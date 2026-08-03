'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ScheduleRegistry } = require('../src/main/tasks/schedules.js');
const { createScheduler } = require('../src/main/tasks/scheduler.js');

// The clock that runs tasks nobody is watching.
//
// Driven with an injected clock and injected timers, so none of this waits for
// anything: what is being asked is what the scheduler decides, and deciding it
// half a minute at a time in real seconds would make the suite unbearable and
// the assertions flaky.
//
// The claim worth the most here is the one about downtime. An hourly schedule
// and a week with the app closed must produce **one** run, not a hundred and
// sixty-eight. A scheduled run is addressed to a moment; an outbox message is
// addressed to a person and is worth delivering late, and confusing the two
// would empty a week of missed alarms into an agent the instant somebody opened
// their laptop.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// A fixed local moment to schedule around: Wednesday 15 July 2026, 08:00.
const START = new Date(2026, 6, 15, 8, 0).getTime();

// Stands in for the tasks service. Records what it was asked to run, and can be
// told to refuse the way the real one does.
function fakeTasks({ agentId = 'agent:tessie', refuse = null } = {}) {
  const runs = [];
  return {
    runs,
    get: (id) => (id === 'task:a' ? { id, title: 'Nightly', agentId, instruction: 'do it' } : null),
    run(id, opts) {
      if (refuse) return { ok: false, ...refuse };
      runs.push({ id, ...opts });
      return { ok: true, task: { id } };
    },
  };
}

function makeScheduler({
  spec = { kind: 'cron', expr: '0 * * * *' },
  taskId = 'task:a',
  at = START,
  tasks = fakeTasks(),
  agents = [{ id: 'agent:tessie', name: 'Tessie', ready: true }],
  nextRunAt,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-sched-'));
  const schedules = new ScheduleRegistry(dir);
  let clock = at;
  const timers = { set: [], cleared: [] };

  const scheduler = createScheduler({
    schedules,
    tasks,
    askable: () => agents,
    bus: { emit: () => {} },
    now: () => clock,
    setTimer: (fn, ms) => {
      const handle = { fn, ms, id: timers.set.length };
      timers.set.push(handle);
      return handle;
    },
    clearTimer: (handle) => timers.cleared.push(handle),
  });

  const record = schedules.create({
    taskId,
    spec,
    nextRunAt: nextRunAt === undefined ? scheduler.nextFor(spec, at) : nextRunAt,
  });

  return {
    dir,
    schedules,
    scheduler,
    tasks,
    timers,
    record: () => schedules.get(record.id),
    id: record.id,
    travel(ms) {
      clock = ms;
    },
    get clock() {
      return clock;
    },
  };
}

const local = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

test('a schedule knows when it is next due, and it is on disk', () => {
  const s = makeScheduler({ spec: { kind: 'cron', expr: '0 9 * * *' } });
  assert.equal(local(s.record().nextRunAt), '2026-07-15 09:00');
  // On disk, not merely in memory: the tick has to be a numeric comparison, and
  // the number has to survive a restart.
  const onDisk = JSON.parse(fs.readFileSync(path.join(s.dir, 'schedules.json'), 'utf8'));
  assert.equal(onDisk[0].nextRunAt, s.record().nextRunAt);
  assert.deepEqual(new ScheduleRegistry(s.dir).list()[0].nextRunAt, s.record().nextRunAt);
});

test('nothing happens until the moment comes, and then it does', () => {
  const s = makeScheduler({ spec: { kind: 'cron', expr: '0 9 * * *' } });

  s.travel(START + 30_000);
  s.scheduler.tick();
  assert.deepEqual(s.tasks.runs, [], 'not yet');

  s.travel(new Date(2026, 6, 15, 9, 0).getTime());
  s.scheduler.tick();
  assert.equal(s.tasks.runs.length, 1, 'now');
  // The run says which schedule asked for it, so a list of runs can tell what
  // you pressed from what happened while you were out.
  assert.equal(s.tasks.runs[0].by, s.id);
  assert.equal(s.record().lastResult, 'ran');
  // And it has rolled on to tomorrow rather than staying due.
  assert.equal(local(s.record().nextRunAt), '2026-07-16 09:00');

  // A second tick in the same minute must not fire it again.
  s.scheduler.tick();
  assert.equal(s.tasks.runs.length, 1);
});

test('a one-off fires once and then switches itself off, without vanishing', () => {
  const at = START + HOUR;
  const s = makeScheduler({ spec: { kind: 'once', at } });
  assert.equal(s.record().nextRunAt, at);

  s.travel(at);
  s.scheduler.tick();
  assert.equal(s.tasks.runs.length, 1);

  const after = s.record();
  assert.equal(after.enabled, false, 'it has said its piece');
  assert.equal(after.nextRunAt, null);
  assert.equal(after.lastResult, 'ran');
  // Kept rather than deleted, so the list still says what happened and when —
  // the same bargain a session in the Trash strikes.
  assert.equal(s.schedules.list().length, 1);

  s.travel(at + DAY);
  s.scheduler.tick();
  assert.equal(s.tasks.runs.length, 1, 'and it does not come round again');
});

test('a run missed by minutes while the app was closed still happens, once', () => {
  const nine = new Date(2026, 6, 15, 9, 0).getTime();
  const s = makeScheduler({ spec: { kind: 'cron', expr: '0 9 * * *' }, nextRunAt: nine });

  // The laptop was opened at twenty past nine.
  s.travel(nine + 20 * 60 * 1000);
  s.scheduler.catchUp();

  assert.equal(s.tasks.runs.length, 1, 'the nine o’clock run was still wanted');
  assert.equal(s.record().lastResult, 'ran');
  assert.equal(s.record().missed, 0);
  assert.equal(local(s.record().nextRunAt), '2026-07-16 09:00', 'and it is due again tomorrow');
});

test('a week of downtime produces one run, not a hundred and sixty-eight', () => {
  const s = makeScheduler({ spec: { kind: 'cron', expr: '0 * * * *' }, nextRunAt: START });

  // Seven days later.
  const back = START + 7 * DAY;
  s.travel(back);
  s.scheduler.catchUp();

  // The whole rule, in one assertion. A scheduled run is addressed to a moment,
  // and a backlog of them emptied into an agent at once is noise nobody asked
  // for.
  assert.equal(s.tasks.runs.length, 1, 'exactly one run');

  const after = s.record();
  // The most recent occurrence was run — that is the one somebody coming back
  // to their desk actually wants — and the 168 before it were not. The count is
  // kept so the panel can be honest about it rather than looking like a
  // schedule that has been working all week.
  assert.equal(after.lastResult, 'ran');
  assert.equal(after.missed, 168);
  assert.ok(after.nextRunAt > back, 'and it is due next at a real moment, not immediately');
  assert.equal(after.enabled, true, 'still on');
});

test('a run missed by more than an hour is recorded rather than run late', () => {
  const nine = new Date(2026, 6, 15, 9, 0).getTime();
  const s = makeScheduler({ spec: { kind: 'cron', expr: '0 9 * * *' }, nextRunAt: nine });

  // Opened at eight in the evening, eight days later. The most recent nine
  // o'clock was eleven hours ago, and this morning's alarm is not worth
  // ringing at bedtime.
  s.travel(nine + 8 * DAY + 11 * HOUR);
  s.scheduler.catchUp();

  assert.deepEqual(s.tasks.runs, [], 'nothing ran');
  const after = s.record();
  assert.equal(after.lastResult, 'missed');
  assert.match(after.lastDetail, /not running/);
  // The eight that went by while it was closed, and the one that was too late
  // to be worth running now.
  assert.equal(after.missed, 9, 'and it says how many went by');
  assert.ok(after.nextRunAt > s.clock);
  assert.equal(local(after.nextRunAt), '2026-07-24 09:00', 'due again in the morning');
});

test('an agent that cannot be asked is skipped, with the reason written down', () => {
  for (const [reason, sentence] of [
    ['off', /switched off/],
    ['busy', /middle of something/],
    ['held', /still waiting/],
  ]) {
    const s = makeScheduler({
      spec: { kind: 'cron', expr: '0 9 * * *' },
      agents: [{ id: 'agent:tessie', name: 'Tessie', ready: false, reason }],
    });
    s.travel(new Date(2026, 6, 15, 9, 0).getTime());
    s.scheduler.tick();

    assert.deepEqual(s.tasks.runs, [], `${reason}: nothing was asked`);
    assert.equal(s.record().lastResult, 'skipped', reason);
    // Written here rather than in the window, because the window is not open at
    // three in the morning and the record has to explain itself without one.
    assert.match(s.record().lastDetail, sentence, reason);
    // No queue: "off" can mean days, and a queue would empty every skipped
    // fire at the agent the instant it came back.
    assert.equal(local(s.record().nextRunAt), '2026-07-16 09:00', `${reason}: rolled on`);
  }
});

test('an agent or a task that is gone fails rather than being skipped', () => {
  const missing = makeScheduler({
    spec: { kind: 'cron', expr: '0 9 * * *' },
    agents: [],
  });
  missing.travel(new Date(2026, 6, 15, 9, 0).getTime());
  missing.scheduler.tick();
  assert.equal(missing.record().lastResult, 'failed');
  assert.match(missing.record().lastDetail, /no longer here/);

  const orphan = makeScheduler({ spec: { kind: 'cron', expr: '0 9 * * *' }, taskId: 'task:gone' });
  orphan.travel(new Date(2026, 6, 15, 9, 0).getTime());
  orphan.scheduler.tick();
  assert.equal(orphan.record().lastResult, 'failed');
  assert.match(orphan.record().lastDetail, /task is no longer here/);
});

test('a refusal from the task service is recorded in its own words', () => {
  const s = makeScheduler({
    spec: { kind: 'cron', expr: '0 9 * * *' },
    tasks: fakeTasks({ refuse: { reason: 'already-running', detail: 'It is already running.' } }),
  });
  s.travel(new Date(2026, 6, 15, 9, 0).getTime());
  s.scheduler.tick();
  assert.equal(s.record().lastResult, 'skipped');
  assert.equal(s.record().lastDetail, 'It is already running.');
});

test('a schedule that is switched off is not a schedule that fires', () => {
  const s = makeScheduler({ spec: { kind: 'cron', expr: '0 9 * * *' } });
  s.schedules.update(s.id, { enabled: false });
  s.travel(new Date(2026, 6, 16, 9, 0).getTime());
  s.scheduler.tick();
  s.scheduler.catchUp();
  assert.deepEqual(s.tasks.runs, []);
});

test('the timer is captured, unrefs itself, and is cleared on the way out', () => {
  const s = makeScheduler({ spec: { kind: 'cron', expr: '0 9 * * *' } });
  assert.equal(s.scheduler.running(), false);

  s.scheduler.start();
  assert.equal(s.timers.set.length, 1, 'one timer, not one per schedule');
  assert.equal(s.timers.set[0].ms, 30_000, 'half a minute, so a named minute is hit inside it');
  assert.equal(s.scheduler.running(), true);

  s.scheduler.start();
  assert.equal(s.timers.set.length, 1, 'starting twice does not start twice');

  s.scheduler.stop();
  // Cleared with the handle it was given, which is the part that would silently
  // not work if the handle were not kept.
  assert.deepEqual(s.timers.cleared, [s.timers.set[0]]);
  assert.equal(s.scheduler.running(), false);
  s.scheduler.stop();
  assert.equal(s.timers.cleared.length, 1, 'and stopping twice is not an error');
});

test('starting sweeps for what fell due while the app was closed', () => {
  const nine = new Date(2026, 6, 15, 9, 0).getTime();
  const s = makeScheduler({ spec: { kind: 'cron', expr: '0 9 * * *' }, nextRunAt: nine });
  s.travel(nine + 10 * 60 * 1000);

  s.scheduler.start();
  assert.equal(s.tasks.runs.length, 1, 'the sweep runs before the first tick, not after it');
  s.scheduler.stop();
});

test('the timer that is set actually ticks', () => {
  // The handle is captured, so the function it was given can be called — which
  // proves the thing the injected timer would otherwise hide: that what is
  // scheduled every thirty seconds is the sweep and not something else.
  const s = makeScheduler({ spec: { kind: 'cron', expr: '0 9 * * *' } });
  s.scheduler.start();
  s.travel(new Date(2026, 6, 15, 9, 0).getTime());
  s.timers.set[0].fn();
  assert.equal(s.tasks.runs.length, 1);
  s.scheduler.stop();
});

test('a spec that cannot be read leaves a schedule that never claims to be due', () => {
  const s = makeScheduler({ spec: { kind: 'cron', expr: 'not a cron' } });
  assert.equal(s.record().nextRunAt, null);
  s.travel(START + DAY);
  s.scheduler.tick();
  assert.deepEqual(s.tasks.runs, [], 'a null next moment is never past');
  assert.equal(s.scheduler.nextFor({ kind: 'cron', expr: 'nonsense' }), null);
});

test('schedules deleted with their task, and junk in the file dropped', () => {
  const s = makeScheduler();
  assert.equal(s.schedules.forTask('task:a').length, 1);
  assert.equal(s.schedules.removeForTask('task:a'), 1);
  assert.equal(s.schedules.list().length, 0);
  assert.equal(s.schedules.removeForTask('task:a'), 0, 'and again is not an error');

  const file = path.join(s.dir, 'schedules.json');
  fs.writeFileSync(file, JSON.stringify([{ id: 'sched:real' }, { id: 'task:no' }, null, 7]), 'utf8');
  const guarded = new ScheduleRegistry(s.dir);
  assert.deepEqual(
    guarded.list().map((r) => r.id),
    ['sched:real']
  );
  assert.equal(guarded.get('sched:real').enabled, true, 'a record with no flag gets a usable one');

  fs.writeFileSync(file, 'not json', 'utf8');
  assert.deepEqual(new ScheduleRegistry(s.dir).list(), []);
});

test('the soonest one is at the top, and the ones that will never fire are at the bottom', () => {
  const s = makeScheduler({ spec: { kind: 'cron', expr: '0 9 * * *' } });
  const later = s.schedules.create({ taskId: 'task:a', spec: {}, nextRunAt: START + DAY });
  const never = s.schedules.create({ taskId: 'task:a', spec: {}, nextRunAt: null });
  s.schedules.update(later.id, { enabled: true });

  const order = s.schedules.list().map((r) => r.id);
  assert.equal(order[0], s.id, 'nine this morning');
  assert.equal(order[1], later.id, 'then tomorrow');
  assert.equal(order[2], never.id, 'and one with no next moment is not next');
});
