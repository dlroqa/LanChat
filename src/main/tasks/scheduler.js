'use strict';

const { parseSchedule, nextAfter } = require('./cron');

// The clock that runs tasks nobody is watching.
//
// This is the one timer the Task Bar adds, and it is worth saying why, because
// the two standing precedents in this codebase go the other way: a session's
// round staleness is checked when the next question is asked, and the outbox
// drains on the `presence` event rather than on a poll. Both of those hang on
// something the app does. A clock reaching nine in the morning is not something
// the app does — that is the entire feature — so there is nothing to hang this
// on, and it wakes up instead.
//
// It wakes cheaply. Each tick is a numeric comparison against a `nextRunAt`
// that was computed and written when the schedule was last touched; no
// expression is re-parsed and no date arithmetic is done unless something is
// actually due.

// Half a minute, so a schedule naming a minute fires inside the minute it
// named. Anything longer and "every day at 09:00" becomes "some time in the
// nine o'clock hour", which is not what was asked for.
const TICK_MS = 30_000;

// How late a run may be and still be worth doing when the app comes back.
//
// The rule this encodes matters more than the number: an hourly schedule and a
// week of downtime produce **one** run, not a hundred and sixty-eight. A
// scheduled run is addressed to a moment. That is the opposite of an outbox
// message, which is addressed to a person and is still worth delivering late —
// and the difference is why this does not do what the outbox does. A backlog of
// them, all firing at once on launch, is noise nobody asked for and an agent
// nobody can get a word in with.
const CATCH_UP_MS = 60 * 60 * 1000;

// A guard on the roll-forward loop below. A schedule left alone for years with
// a `* * * * *` spec would otherwise walk a minute at a time to catch up.
const MAX_ROLL = 5000;

// Why a fire did nothing, and the sentence for it. Written here rather than in
// the window, because the window is not open at three in the morning and the
// run record has to explain itself without one.
const OUTCOMES = {
  gone: 'That task is no longer here.',
  off: 'The agent was switched off.',
  busy: 'The agent was in the middle of something.',
  held: 'The agent had a question of ours still waiting.',
  missing: 'That agent is no longer here.',
  missed: 'The app was not running when this was due.',
};

function createScheduler({
  schedules,
  tasks,
  askable,
  bus,
  now = Date.now,
  setTimer = setInterval,
  clearTimer = clearInterval,
  tickMs = TICK_MS,
  catchUpMs = CATCH_UP_MS,
}) {
  let timer = null;

  function publish() {
    if (bus) bus.emit('schedules', schedules.list());
  }

  // The next moment this spec is due after `from`, or null if it never is.
  function due(spec, from) {
    return nextAfter(spec, from);
  }

  // The most recent moment this schedule was due at or before `at`, and how
  // many came and went before it.
  //
  // Which occurrence is "the" missed one is the whole question. Judging by the
  // oldest would mean an hourly schedule and a week of downtime looked a week
  // late and never ran again; judging by the most recent asks the question
  // somebody actually has — did I miss the last one, and by how much. The count
  // of the ones passed over is kept because a schedule that quietly skipped
  // forty runs should be able to say so.
  function lastDue(record, at) {
    let last = record.nextRunAt;
    let skipped = 0;
    for (let i = 0; i < MAX_ROLL; i += 1) {
      const next = due(record.spec, last);
      if (next == null || next > at) break;
      last = next;
      skipped += 1;
    }
    return { last, skipped };
  }

  // One schedule's moment has come.
  //
  // Every branch writes a result, including the ones where nothing ran. A
  // schedule that appears not to have fired, with nothing to say why, is the
  // worst thing this feature could produce.
  function fire(record, { at = now() } = {}) {
    const task = tasks.get(record.taskId);
    if (!task) {
      return { result: 'failed', detail: OUTCOMES.gone };
    }

    // Resolved through the same list the session composer reads, so a schedule
    // and a person get the same answer to "can this agent be asked".
    const target = task.agentId ? (askable ? askable() : []).find((a) => a.id === task.agentId) : null;
    if (!task.agentId || !target) {
      return { result: 'failed', detail: task.agentId ? OUTCOMES.missing : 'That task has no agent.' };
    }
    if (!target.ready) {
      // Skipped, not queued. "Off" can mean days, and a queue would dump every
      // skipped fire at the agent the instant it came back — which is the
      // backlog problem again, one level down.
      return { result: 'skipped', detail: OUTCOMES[target.reason] || 'The agent could not be asked.' };
    }

    const started = tasks.run(record.taskId, { by: record.id });
    if (!started.ok) return { result: 'skipped', detail: started.detail };
    return { result: 'ran', detail: null, at };
  }

  // One schedule that has come round: fire it if it is still worth firing, and
  // roll it on to its next real moment either way.
  function advance(record, at) {
    const { last, skipped } = lastDue(record, at);
    const late = at - last;
    // Late by an hour or less: run it. Somebody who opened their laptop at ten
    // past nine still wants the nine o'clock run. Later than that: say so, and
    // count it among the ones that went by.
    const worthIt = late <= catchUpMs;
    const outcome = worthIt ? fire(record, { at }) : { result: 'missed', detail: OUTCOMES.missed };
    const nextRunAt = due(record.spec, at);
    schedules.markFire(record.id, {
      lastFireAt: at,
      lastResult: outcome.result,
      lastDetail: outcome.detail,
      nextRunAt,
      missed: worthIt ? skipped : skipped + 1,
      // Nothing left to come round: a one-off has said its piece. Switched off
      // rather than deleted, so the list still says what happened and when —
      // the same bargain a session in the Trash strikes.
      ...(nextRunAt == null && { enabled: false }),
    });
    return outcome;
  }

  // Everything that has come round, done.
  //
  // One function behind both the timer and the start-up sweep, deliberately. A
  // laptop that slept for two days and a laptop that was shut down for two days
  // present the same problem — the interval did not fire, and the wall clock
  // moved — so they must not be able to disagree about what to do next.
  function sweep() {
    const at = now();
    let moved = false;
    for (const record of schedules.list()) {
      if (!record.enabled || !record.nextRunAt || record.nextRunAt > at) continue;
      advance(record, at);
      moved = true;
    }
    if (moved) publish();
  }

  return {
    // Called once from startServices, after the agents have been asked to come
    // up — a catch-up run that fired into a hub with nothing started yet would
    // find every agent "off" and record a skip for each.
    start() {
      if (timer) return;
      sweep();
      timer = setTimer(sweep, tickMs);
      // The same courtesy the agent hub's idle sweep extends: a background wake
      // should not be the reason a process stays alive.
      if (timer && typeof timer.unref === 'function') timer.unref();
    },

    stop() {
      if (!timer) return;
      clearTimer(timer);
      timer = null;
    },

    // The sweep, under both the names callers think of it by, and exported so
    // the tests can drive it rather than wait half a minute for a real tick.
    // They are the same function: see the aside above.
    tick: sweep,
    catchUp: sweep,

    // Where a schedule stands, recomputed from its spec. Used when one is
    // created or edited: the number on disk is only ever as good as the last
    // time something worked it out.
    nextFor(spec, from = now()) {
      return parseSchedule(spec) ? due(spec, from) : null;
    },

    running: () => Boolean(timer),
    TICK_MS: tickMs,
    CATCH_UP_MS: catchUpMs,
  };
}

module.exports = { createScheduler, TICK_MS, CATCH_UP_MS, OUTCOMES };
