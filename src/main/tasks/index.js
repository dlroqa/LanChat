'use strict';

const crypto = require('node:crypto');
const { TaskRegistry, isTaskId } = require('./registry');
const { TaskRunStore } = require('./runs');

// Agent tasks: one question, asked whenever you want it asked.
//
// The whole of the difference between this and a session is where the answer
// goes. A session's answer is a message in a conversation; a task's answer is
// the result of the task, and it goes onto the task and nowhere else. There is
// no transcript here, nothing is appended to any thread, and no `chat` event is
// emitted — see the task branch in ipc.js, which is the mechanical guarantee
// behind that sentence rather than a promise about intent.
//
// The task's own id is the thread it asks under. That is what redirects the
// agent's reply here instead of into the agent's own conversation, and it is
// also why `task:` had to be added to the impersonation guard: a namespace that
// answers must be a namespace a peer cannot claim.
//
// Liveness is not decided here. `askable` is passed in — it is the sessions
// service's, and it is the only implementation of "can this agent be asked" in
// the app. A second one would drift on exactly the two cases that matter, an
// agent switched off and an agent mid-run.

// A run nothing has been heard from for this long is over, whatever the
// transport thinks. Checked lazily, when the task is next run, for the reason
// the session round checks its own staleness that way: a timer would burn a
// wakeup to notice something nobody is waiting on. Without it, a transport that
// dies mid-answer would leave a task saying "working" until the app restarted.
const RUN_IDLE_MS = 10 * 60 * 1000;

// Why a run did not start, and the sentence to show for it. Written here rather
// than in the window so that the schedule, which has no window to write one in,
// records the same words for the same situation.
const REFUSALS = {
  gone: 'That task is no longer here.',
  'no-agent': 'Pick an agent for this task first.',
  'no-instruction': 'Write what the agent should do first.',
  'already-running': 'It is already running.',
  'agent-gone': 'That agent is no longer here.',
  'agent-off': 'The agent is switched off.',
  'agent-busy': 'The agent is in the middle of something.',
  refused: 'The agent would not take it.',
};

function createTasks({ userDataDir, agentHub, remoteAgents, askable, bus }) {
  const registry = new TaskRegistry(userDataDir);
  const runStore = new TaskRunStore(userDataDir);

  // Runs in flight, keyed by task id — which is also the thread id the answer
  // comes back on, so an ending can be matched to a run with no lookup.
  //
  // In memory only. Live state that outlived the process would be a lie: the
  // transport it was waiting on is gone, and the run it describes can never
  // finish. The durable record is the run file, written when the run ends.
  const running = new Map();

  function publish() {
    if (bus) bus.emit('tasks', registry.list());
  }

  // Who the task asks, as the one list that knows. `null` when the agent it
  // names has been removed or its owner has gone offline.
  function targetFor(record) {
    if (!record.agentId) return null;
    return (askable ? askable() : []).find((a) => a.id === record.agentId) || null;
  }

  function refuse(reason) {
    return { ok: false, reason, detail: REFUSALS[reason] || 'It could not be run.' };
  }

  // A run that has been in flight too long to still be in flight. Cleared on
  // the way in to the next run rather than swept: this is the only moment
  // anybody is inconvenienced by it.
  function reapStale(taskId) {
    const entry = running.get(taskId);
    if (!entry || Date.now() - entry.lastAt < RUN_IDLE_MS) return;
    noteOutcome({
      threadId: taskId,
      agentId: entry.agentId,
      kind: 'error',
      detail: 'The agent stopped answering.',
    });
  }

  // One run is over: it answered, it failed, or it finished with nothing in it.
  //
  // The one funnel every ending comes through, whichever of the routes it
  // arrived by — a reply, an empty run, a refusal at the door, a stop, or the
  // staleness check above. Mirrors sessions.noteOutcome, and for the same
  // reason: a record that can be left saying "working" by one forgotten path is
  // a record nobody can trust.
  function noteOutcome({ threadId, agentId, kind, text = '', detail = null } = {}) {
    const entry = running.get(threadId);
    if (!entry) return null;
    // An ending from somebody this task is not waiting on: a stray answer
    // arriving after the run closed, or a second agent that was never asked.
    if (agentId && entry.agentId && agentId !== entry.agentId) return null;
    running.delete(threadId);

    const answer = String(text || '');
    const run = {
      id: entry.runId,
      startedAt: entry.startedAt,
      endedAt: Date.now(),
      ok: kind === 'answer',
      kind,
      text: answer,
      agentId: entry.agentId,
      agentName: entry.agentName,
      by: entry.by,
      ...(detail && { detail }),
    };
    runStore.append(threadId, run);

    registry.markRun(threadId, {
      status: kind === 'answer' ? 'done' : 'failed',
      lastEndedAt: run.endedAt,
      lastResult: kind,
      lastDetail: detail,
      lastChars: answer.length,
      countRun: true,
    });
    publish();
    return run;
  }

  // A reply that came back on a task's thread.
  //
  // Called from the task branch in ipc.js, which is above the session branch
  // and above every router — an answer that happened to open with "@" must not
  // be read as a fresh question and asked all over again.
  function noteReply(msg) {
    if (!msg || !isTaskId(msg.from)) return null;
    const failed = msg.error === true;
    // Queue chatter is not an outcome. An agent asked while it is busy answers
    // "one at a time, please" and starts nothing; treating that as the run
    // ending would file a notice as this task's result.
    if (msg.notice === true && !failed) return null;
    return noteOutcome({
      threadId: msg.from,
      agentId: msg.agentId,
      kind: failed ? 'error' : 'answer',
      text: msg.text,
      detail: failed ? msg.detail || 'The agent reported an error.' : null,
    });
  }

  // Puts the task's instruction to its agent.
  //
  // `by` is what asked: 'manual' for the button, or a schedule's id. It is
  // recorded on the run so a list of them can say which were yours and which
  // happened while you were out.
  function run(id, { by = 'manual' } = {}) {
    const record = registry.get(id);
    if (!record) return refuse('gone');

    reapStale(id);
    if (running.has(id)) return refuse('already-running');
    if (!record.instruction) return refuse('no-instruction');
    if (!record.agentId) return refuse('no-agent');

    const target = targetFor(record);
    if (!target) return refuse('agent-gone');
    if (!target.ready) return refuse(target.reason === 'off' ? 'agent-off' : 'agent-busy');

    const runId = crypto.randomUUID();
    const now = Date.now();
    // Booked before the ask, not after. A transport that answers inside the
    // call would otherwise have its reply arrive before there was anything for
    // noteOutcome to match it to — the same ordering hazard sessions.send
    // guards by writing the question down before dispatching it.
    running.set(id, {
      runId,
      agentId: target.id,
      agentName: target.name,
      startedAt: now,
      lastAt: now,
      by,
    });
    registry.markRun(id, {
      status: 'working',
      lastRunAt: now,
      lastResult: null,
      lastDetail: null,
    });
    publish();

    // An agent a peer shared with us: the question travels to its owner, and
    // the answer is routed back to this task rather than to the agent's own
    // thread — the same second branch a session's dispatch has.
    const remote = remoteAgents && remoteAgents.resolveThread(target.id);
    let ok = false;
    if (remote) {
      const sent = remoteAgents.send(remote.ownerPeerId, remote.entry, record.instruction, {
        thread: id,
        // A task has no transcript for this to be written into. That is the
        // whole shape of the feature.
        record: false,
      });
      ok = !sent.rejected;
    } else if (agentHub) {
      ok = agentHub.ask(target.id, record.instruction, { thread: id, ref: runId });
    }

    // Refused at the door. Everything that could be checked in advance was, so
    // this is a race — an agent switched off between the liveness check and the
    // ask — and it ends the run the same way an error does, because it is one.
    if (!ok) {
      noteOutcome({ threadId: id, agentId: target.id, kind: 'error', detail: REFUSALS.refused });
      return refuse('refused');
    }
    return { ok: true, task: registry.get(id) };
  }

  // Interrupting a run. Only reaches the transport when this task is the one
  // holding it: stopping an agent that is busy answering a session instead
  // would take somebody else's answer away.
  function stop(id) {
    const entry = running.get(id);
    if (!entry) return { ok: false };
    if (agentHub && !remoteAgents?.resolveThread(entry.agentId)) {
      Promise.resolve(agentHub.stopRun(entry.agentId)).catch(() => {});
    }
    noteOutcome({ threadId: id, agentId: entry.agentId, kind: 'error', detail: 'Stopped.' });
    return { ok: true };
  }

  return {
    list: () => registry.list(),
    get: (id) => registry.get(id),

    create(draft) {
      const record = registry.create(draft || {});
      publish();
      return record;
    },

    update(id, patch) {
      const record = registry.update(id, patch || {});
      if (record) publish();
      return record;
    },

    remove(id) {
      // A run in flight is ended first, so nothing is left waiting on a task
      // that has stopped existing — and the answers go with the record.
      if (running.has(id)) stop(id);
      const ok = registry.remove(id);
      if (ok) {
        runStore.clear(id);
        publish();
      }
      return ok;
    },

    runs: (id, limit) => runStore.read(id, limit),
    run,
    stop,
    noteReply,
    noteOutcome,

    // What is in flight right now, for the panel's live section. A projection
    // of the map above rather than a second record of it.
    running: () =>
      [...running.entries()].map(([taskId, entry]) => ({
        taskId,
        agentId: entry.agentId,
        agentName: entry.agentName,
        startedAt: entry.startedAt,
        by: entry.by,
      })),

    unbindAgent(agentId) {
      const changed = registry.unbindAgent(agentId);
      if (changed) publish();
      return changed;
    },

    isTaskId,
  };
}

module.exports = { createTasks, isTaskId, RUN_IDLE_MS, REFUSALS };
