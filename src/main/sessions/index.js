'use strict';

const crypto = require('node:crypto');
const { SessionRegistry, isSessionId, DEFAULT_TITLE } = require('./registry.js');
const { parseTranscript } = require('./transcript.js');
const { composeContext, contextRecord } = require('./prompt.js');
const { resolveCounsel, missedNotice, unreachableNotice, relayPrompt } = require('./counsel.js');

// Sessions: a titled workspace with a conversation in it.
//
// A session is a thread id and nothing more. It is not a peer and it is never
// registered with PeerHub — agents get a virtual socket because they need
// presence and a wire identity, and a session has neither. Putting one on the
// presence path would be a local-only construct pretending to be a contact, and
// every guard that keeps agent ids off the wire would have to grow a second
// exception.
//
// What it gets instead is the ordinary thread machinery: MessageStore files it
// under its own id, so history, export and delete all work on a session with no
// new code, and the agents it asks answer into it the same way an agent answers
// any other thread.

// How long a round can sit with nothing happening in it before the session gives
// up waiting and lets the next question through. Nothing runs on a timer — this
// is checked when somebody tries to ask again, which is the only moment it
// matters. A transport that hangs must not be able to lock a workspace shut.
const ROUND_IDLE_MS = 10 * 60 * 1000;

function createSessions({ userDataDir, store, agentHub, remoteAgents, registry, hub = null, bus = null }) {
  const sessions = registry || new SessionRegistry(userDataDir);

  // The question each session currently has out with its agents.
  //
  // In memory and nowhere else. A round is a live thing — who is still thinking,
  // what has come back so far, who is next in a relay — and none of it means
  // anything after a restart: the answers that did arrive are in the transcript
  // where they belong, and the ones that had not arrived never will. Writing it
  // down would only create the possibility of the app reopening convinced it is
  // waiting for something.
  const rounds = new Map();

  function list() {
    return sessions.list();
  }

  // A session this machine can still do something with.
  //
  // One in the Trash is not one of those, and this is the single place that is
  // decided. Everything that acts on a session reads it first — send(),
  // importText(), the import handler in ipc.js — so a deleted session refuses
  // the same way a session that never existed does, with no second rule to keep
  // in step. The registry's own get() is the door for anything that has to see
  // a trashed record, which is the trash pair below and nothing else.
  function get(id) {
    const record = sessions.get(id);
    return record && !record.deletedAt ? record : null;
  }

  function create(draft = {}) {
    return sessions.create(draft);
  }

  function rename(id, title) {
    return sessions.update(id, { title });
  }

  function setAgent(id, agentId) {
    return sessions.update(id, { agentId: agentId || null });
  }

  // Who this session asks, as one decision: a list, or everybody, and whether
  // they are asked together or in turn.
  //
  // For a session set to ask everybody there is no list to take a head from, so
  // the mirror `agentId` an older build would read is resolved here, from whoever
  // is around at the moment the choice is made. It is a best effort by
  // definition — the whole point of the setting is that the membership is not
  // fixed — and a best effort is the right amount for a field that only matters
  // to a version of the app this person may never run again.
  function setCounsel(id, { agentIds, allAgents, mode } = {}) {
    const patch = {};
    if (agentIds !== undefined) patch.agentIds = agentIds;
    if (allAgents !== undefined) patch.allAgents = allAgents;
    if (mode !== undefined) patch.mode = mode;
    if (allAgents === true) patch.agentId = askable().find((a) => a.ready)?.id || null;
    return sessions.update(id, patch);
  }

  // Everyone this machine could put a question to, and whether they can take one
  // right now.
  //
  // The single place liveness is decided. Every caller downstream — who gets
  // asked, who is named in the notice, whether the composer is refused at all —
  // reads this one list, so there is no second opinion to drift out of step with
  // it. `reason` is why somebody cannot be asked, and it is carried rather than
  // re-derived because by the time the sentence is written the state may have
  // changed underneath it.
  //
  // The ids are the ids the record stores and the roster shows: `agent:…` for
  // ours, and the `remote-agent:owner:agent` form for one a peer shared. No
  // mapping, no second namespace.
  function askable() {
    const out = [];
    if (agentHub) {
      for (const a of agentHub.list()) {
        // An agent that is switched off is on this list, and not ready. Leaving
        // it off entirely would make it indistinguishable from one that has been
        // removed, and the session would tell somebody their agent was "no longer
        // here" when it is here and turned off — which is the one case with
        // something to do about it.
        const running = a.enabled !== false && agentHub.isRunning(a.id);
        // Busy is not the same as unavailable, but it is the same for this
        // question: an agent asked mid-run answers "one at a time, please" and
        // starts nothing, so a round waiting on that sentence would wait for an
        // answer that is never coming. Skipped and named instead.
        const busy = running && agentHub.isBusy(a.id);
        out.push({
          id: a.id,
          name: a.name,
          remote: false,
          ready: running && !busy,
          reason: !running ? 'off' : busy ? 'busy' : null,
        });
      }
    }
    if (remoteAgents) {
      for (const [ownerPeerId, list] of Object.entries(remoteAgents.sharedBy())) {
        // Whose agent it is, for a picker that has to say so. An owner who has
        // gone offline takes their agents off this list entirely — dropOwner sees
        // to that — so a name is available for everyone still on it.
        const owner = hub && hub.identities.get(ownerPeerId);
        const viaName = (owner && (owner.name || owner.hostname)) || 'a peer';
        for (const entry of list) {
          const resolved = remoteAgents.resolveThread(entry.id);
          // A question of ours already waiting to be read by its owner. Asking
          // again would not be answered any sooner — see the refusal in
          // remote.js — so this end skips them for the same reason it skips one
          // of ours that is busy.
          const held = Boolean(
            resolved && resolved.entry.held && resolved.entry.standing?.state === 'waiting'
          );
          out.push({
            id: entry.id,
            name: entry.name,
            remote: true,
            viaName,
            ready: !held,
            reason: held ? 'held' : null,
          });
        }
      }
    }
    return out;
  }

  // What the window is told about a round in progress: who was asked, who is
  // still thinking, what has come back, and who is yet to be asked.
  //
  // Published from here rather than assembled in the renderer out of four kinds
  // of event. The round is main's — it decides who is asked and when — and a
  // window that reconstructed it would be a second implementation of the same
  // bookkeeping, wrong in exactly the moments that matter: three agents thinking
  // at once, one of them failing, the last one going quiet.
  function view(round) {
    return {
      id: round.id,
      sessionId: round.sessionId,
      mode: round.mode,
      open: round.open,
      messageId: round.messageId,
      asked: round.asked.map((t) => ({ agentId: t.agentId, name: t.name })),
      running: [...round.running],
      answered: round.answers.map((a) => a.agentId),
      failed: [...round.failed],
      empty: [...round.empty],
      missed: round.missed.map((m) => ({ agentId: m.agentId, name: m.name, reason: m.reason })),
      next: round.queue.map((t) => ({ agentId: t.agentId, name: t.name })),
    };
  }

  function publish(round) {
    if (bus) bus.emit('session-round', view(round));
  }

  // A round that nothing has happened in for a long time is over, whatever the
  // transport thinks. Checked lazily, when the next question is asked, because
  // that is the only moment anybody is inconvenienced by it — a timer would burn
  // a wakeup every minute to notice something nobody is waiting on.
  function stale(round) {
    return round.open && Date.now() - round.lastAt > ROUND_IDLE_MS;
  }

  function closeRound(round) {
    if (!round.open) return;
    round.open = false;
    round.running.clear();
    rounds.delete(round.sessionId);
    // A question that nobody answered is a question that failed, and the mark
    // goes on it so it stops counting as work this session got done.
    //
    // Decided here, at the end, rather than by whichever agent errored first:
    // one member of a counsel failing says nothing about whether the question was
    // answered, and marking it there would take a real answer off the total every
    // time two agents out of three came back.
    if (round.answers.length === 0 && round.messageId) {
      store.update(round.sessionId, round.messageId, { failed: true });
      round.failedRef = round.messageId;
    }
    if (bus) bus.emit('session-round', { ...view(round), failedRef: round.failedRef || null });
  }

  // Sweeping the errors an older version wrote into this session.
  //
  // Two things go together and must not come apart: the messages leave the
  // transcript, and the same number is taken off what the session claims to have
  // asked. An error that was written down is one question that was not answered,
  // so removing the noise without removing the commit would leave the box
  // counting work the session never got.
  //
  // The ids are decided in the window, which is also where the person is asked
  // whether they want this at all. Only what was really removed is counted:
  // pressing the button twice must not take the total down twice.
  function sweepErrors(sessionId, ids) {
    const record = get(sessionId);
    if (!record) return { removed: 0 };
    const removed = store.remove(sessionId, ids);
    if (!removed) return { removed: 0 };
    // `needsContext` rides along because it is the same fact seen from the other
    // side: these errors named no question, so the questions behind them cannot
    // be put back, and a fork from here is asking about a conversation with holes
    // in it.
    sessions.update(sessionId, { unlinkedFailures: removed, needsContext: true });
    return { removed, record: sessions.get(sessionId) };
  }

  // ---- the Trash ----
  //
  // Deleting a session is two steps, not one. The first takes it out of the
  // window and leaves everything on disk; the second is the one that cannot be
  // undone. What makes the first reversible is that it does not go near the
  // store: the transcript stays filed under the session's own id, untouched,
  // and restoring is therefore putting a record back rather than rebuilding a
  // conversation out of something. There is nothing to rebuild it from.

  function listTrash() {
    return sessions.trashed();
  }

  // Into the Trash.
  //
  // Any question this session has out is closed on the way, because the answers
  // have nowhere to arrive: the round is in memory, the window has stopped
  // showing the session, and an open round left behind would keep a workspace
  // nobody can see marked as busy until it went stale.
  function trash(id) {
    const record = sessions.get(id);
    if (!record || record.deletedAt) return false;
    const open = rounds.get(id);
    if (open) closeRound(open);
    return Boolean(sessions.trash(id));
  }

  function restore(id) {
    return sessions.restore(id);
  }

  // The end of the road. Takes the conversation with the record: the two are
  // halves of one thing, and leaving the history file behind would keep a
  // deleted workspace on disk under a name nothing points at any more.
  //
  // Only reachable from the Trash, so nothing can lose a transcript in one
  // click.
  function purge(id) {
    const record = sessions.get(id);
    if (!record || !record.deletedAt) return false;
    store.clear(id);
    return sessions.remove(id);
  }

  // The two bulk doors, each returning how many it actually moved — pressing
  // either on an empty Trash is not an error, it is nought.
  function restoreAll() {
    let count = 0;
    for (const record of sessions.trashed()) {
      if (sessions.restore(record.id)) count += 1;
    }
    return count;
  }

  function purgeAll() {
    let count = 0;
    for (const record of sessions.trashed()) {
      if (purge(record.id)) count += 1;
    }
    return count;
  }

  // An agent that no longer exists cannot be asked anything. The sessions that
  // asked it stay — they hold a real conversation — but they stop claiming they
  // can carry on, and the header offers a new agent instead.
  function unbindAgent(agentId) {
    return sessions.unbindAgent(agentId);
  }

  // ---- asking ----

  // The shape a refused send takes, which is the same shape the remote-agent
  // path already returns: the words come back so the composer can be refilled,
  // the documents come back as paths so the chips can be put back, and the
  // reason is shown once and then dropped rather than written into the
  // transcript. Being told why you cannot ask yet should not cost somebody the
  // sentence they wrote.
  function refuse(sessionId, text, docs, reason) {
    return {
      rejected: true,
      text,
      docs: docs.map((d) => ({ path: d.path, name: d.name, bytes: d.bytes })),
      notice: {
        id: crypto.randomUUID(),
        peerId: sessionId,
        direction: 'in',
        kind: 'text',
        text: reason,
        ts: Date.now(),
        notice: true,
      },
    };
  }

  // Asks this session's counsel — one agent or several, ours or ones peers
  // shared.
  //
  // `prompt` is what the agents are asked and `text` is what the person typed;
  // they differ when documents are attached or a fork quoted something, and the
  // split is the point — a transcript should hold the question, not the pages
  // that went with it.
  //
  // One question is written down however many agents it goes to. The person
  // typed one sentence, and a transcript that repeated it once per agent would be
  // claiming they asked three times; it would also have the session count three
  // commits for one piece of work, and put the same documents on three bubbles.
  function send(sessionId, text, { prompt, docs = [], context = null } = {}) {
    // get() rather than the registry's, so a session in the Trash refuses a
    // question exactly the way one that was never here does — see the note on
    // get() for why that rule lives in one place.
    const record = get(sessionId);
    if (!record) return refuse(sessionId, text, docs, 'That session no longer exists.');

    // One round at a time. Two questions in flight at once would interleave two
    // sets of answers in one conversation with nothing to say which belonged to
    // which — and in relay mode it would mean an agent being shown a discussion
    // of a different question. A round nothing has happened in for a long time is
    // treated as over rather than allowed to wedge the workspace shut.
    const open = rounds.get(sessionId);
    if (open && !stale(open)) {
      return refuse(sessionId, text, docs, 'The agents are still answering the last question asked here.');
    }
    if (open) closeRound(open);

    const { targets, missed } = resolveCounsel(record, { askable: askable() });
    // Nobody at all. The question is handed back rather than written into a
    // transcript nothing will ever answer, and the sentence says which of them
    // could not be reached and why — the difference between something to fix and
    // something to wait for.
    if (targets.length === 0) return refuse(sessionId, text, docs, unreachableNotice(record, missed));

    const quoted = contextRecord(context);
    const composed = composeContext(quoted, prompt == null ? text : prompt);

    // Asking something new is the end of the missing-context warning. It was
    // there to say the session had lost questions that could not be put back;
    // once there is a fresh question in it, there is context again and the
    // warning has nothing left to warn about.
    //
    // Cleared when the question is accepted rather than when it is answered: it
    // is the asking that re-establishes what this session is about, and a run
    // that fails does not put the hole back.
    if (record.needsContext) sessions.update(sessionId, { needsContext: false });

    const message = {
      id: crypto.randomUUID(),
      peerId: sessionId,
      direction: 'out',
      kind: 'text',
      text,
      ts: Date.now(),
      ...(docs.length && { docs: docs.map((d) => ({ name: d.name, bytes: d.bytes })) }),
      ...(quoted && { context: quoted }),
    };
    // Written down before anybody is asked, and in that order: a transport that
    // answers immediately would otherwise have its reply filed above the question
    // it was answering.
    store.append(sessionId, message);
    sessions.touch(sessionId);

    const round = {
      id: crypto.randomUUID(),
      sessionId,
      mode: record.mode === 'relay' ? 'relay' : 'parallel',
      // The one message every run in this round is answering. All of them carry
      // it as `ref`, which is why an error has to name the agent as well: the
      // question alone no longer identifies which run failed.
      messageId: message.id,
      text,
      composed,
      docs,
      quoted,
      asked: targets,
      queue: [],
      running: new Set(),
      answers: [],
      empty: new Set(),
      failed: new Set(),
      missed,
      failedRef: null,
      open: true,
      startedAt: Date.now(),
      lastAt: Date.now(),
    };
    rounds.set(sessionId, round);

    if (round.mode === 'relay') {
      round.queue = targets.slice();
      publish(round);
      dispatchNext(round);
    } else {
      // Everybody is marked as thinking before anybody is asked. A transport
      // that answers inside the call would otherwise close the round on the
      // first answer, while the rest of the counsel had not been asked yet.
      for (const t of targets) round.running.add(t.agentId);
      publish(round);
      for (const t of targets) dispatch(round, t);
    }

    // Who was left out, said once. Never stored — it is true about this question
    // and noise above the next one — and shaped exactly like the notice a refusal
    // carries, so the window has one thing to render either way.
    const skipped = missedNotice(missed);
    return {
      ...message,
      delivered: true,
      ...(skipped && {
        notice: {
          id: crypto.randomUUID(),
          peerId: sessionId,
          direction: 'in',
          kind: 'text',
          text: skipped,
          ts: Date.now(),
          notice: true,
        },
      }),
    };
  }

  // Puts the round's question to one agent.
  //
  // In relay mode the question grows as it goes: each agent is shown what the
  // ones before it said, built here rather than at the start, because at the
  // start those answers did not exist.
  function dispatch(round, target) {
    const question = round.mode === 'relay' ? relayPrompt(round.composed, round.answers) : round.composed;
    round.running.add(target.agentId);
    // An agent a peer shared with us. The question travels to its owner, and the
    // answer is routed back to this session rather than to the agent's own
    // thread — see `pending` in agents/remote.js for how, and why that is safe.
    const remote = remoteAgents && remoteAgents.resolveThread(target.agentId);
    let ok = false;
    if (remote) {
      const sent = remoteAgents.send(remote.ownerPeerId, remote.entry, round.text, {
        prompt: question,
        docs: round.docs,
        thread: round.sessionId,
        context: round.quoted,
        // The question is already in the transcript; this is the same question
        // reaching one more agent, not a second question.
        record: false,
      });
      ok = !sent.rejected;
    } else if (agentHub) {
      // `ref` is what makes a failure attributable: if this run errors, the error
      // comes back naming this message, and this message stops counting as a
      // question that was answered — once the whole round is in, and not before.
      ok = agentHub.ask(target.agentId, question, { thread: round.sessionId, ref: round.messageId });
    }
    // Refused at the door. Everything that could be checked in advance already
    // was, so this is a race — an agent switched off between resolving the
    // counsel and asking it — and it closes the slot the same way an error does,
    // because it is one: nothing is coming back from this agent.
    if (!ok) noteOutcome({ threadId: round.sessionId, agentId: target.agentId, kind: 'error' });
    return ok;
  }

  // The next agent in a relay, or the end of the round.
  function dispatchNext(round) {
    const next = round.queue.shift();
    if (!next) {
      if (round.running.size === 0) closeRound(round);
      return;
    }
    dispatch(round, next);
    if (round.open) publish(round);
  }

  // One agent's run is over: it answered, it failed, or it finished with nothing
  // in it.
  //
  // The one funnel every ending comes through, whichever of the four routes it
  // arrived by (see ipc.js). A round has to know when it is finished, and
  // "finished" is not a thing any single reply can tell you when three of them
  // are outstanding.
  function noteOutcome({ threadId, agentId, kind, text = '' } = {}) {
    const round = rounds.get(threadId);
    if (!round || !round.open) return null;
    // Somebody this round is not waiting on. A notice, a stray answer arriving
    // after the round closed and reopened, an agent that already reported: none
    // of them end anything.
    if (!round.running.has(agentId)) return null;
    const who = round.asked.find((t) => t.agentId === agentId);
    round.running.delete(agentId);
    round.lastAt = Date.now();
    if (kind === 'answer')
      round.answers.push({ agentId, name: (who && who.name) || 'an agent', text, ts: Date.now() });
    else if (kind === 'empty') round.empty.add(agentId);
    else round.failed.add(agentId);

    if (round.queue.length) {
      publish(round);
      dispatchNext(round);
      return round.open ? view(round) : null;
    }
    if (round.running.size === 0) {
      closeRound(round);
      return null;
    }
    publish(round);
    return view(round);
  }

  // The round a session currently has out, for anything that needs to know
  // whether it is waiting — and for a window that opened after the round started.
  function roundFor(sessionId) {
    const round = rounds.get(sessionId);
    return round && round.open ? view(round) : null;
  }

  // ---- import ----

  // Loads a transcript into a session. The text arrives already read from disk:
  // dialogs and files belong to ipc.js, and keeping them out of here is what
  // lets the whole of the parsing be tested without a window.
  function importText(sessionId, raw, { source = null, at = Date.now() } = {}) {
    const record = get(sessionId);
    if (!record) return { ok: false, error: 'That session no longer exists.' };

    const parsed = parseTranscript(raw, { at });
    if (!parsed.messages.length) return { ok: false, error: 'There is no readable text in that file.' };

    for (const m of parsed.messages) {
      store.append(sessionId, {
        id: crypto.randomUUID(),
        peerId: sessionId,
        direction: m.direction,
        kind: 'text',
        text: m.text,
        ts: m.ts,
        // What marks these apart from the conversation the session goes on to
        // have: they were not said here, and the bubble says so rather than
        // letting an import pass itself off as something the agent replied.
        imported: true,
        ...(m.speaker && { speaker: m.speaker }),
        ...(source && { source }),
      });
    }
    // A session named by nobody takes the name of the first thing put in it, so
    // the sidebar reads as a list of subjects rather than a list of "New
    // Session".
    if (record.title === DEFAULT_TITLE && source) sessions.update(sessionId, { title: titleFrom(source) });
    else sessions.touch(sessionId);

    return {
      ok: true,
      mode: parsed.mode,
      count: parsed.messages.length,
      source,
      title: sessions.get(sessionId).title,
    };
  }

  // `LanChat Server 2026-07-30.txt` reads better as `LanChat Server 2026-07-30`.
  function titleFrom(source) {
    return String(source).replace(/\.[^.]+$/, '');
  }

  return {
    list,
    get,
    create,
    rename,
    setAgent,
    setCounsel,
    listTrash,
    trash,
    restore,
    purge,
    restoreAll,
    purgeAll,
    unbindAgent,
    sweepErrors,
    send,
    noteOutcome,
    roundFor,
    askable,
    importText,
    isSessionId,
  };
}

module.exports = { createSessions, isSessionId, ROUND_IDLE_MS };
