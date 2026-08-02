'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  parseCron,
  parseSchedule,
  presetExpr,
  nextAfter,
  nextRuns,
  describeSchedule,
} = require('../src/main/tasks/cron.js');

// When a scheduled task is next due.
//
// This is a hand-written cron parser, which is a thing that should only ever
// arrive with its own test file. What it gets wrong, it gets wrong silently:
// nobody notices a schedule that is an hour late until the morning after, and
// nobody notices one that never fires at all.
//
// So the three things asked here are the three that can be wrong. Does the
// syntax parse into the set of values it looks like? Does the walk land on the
// right moment, including across a month, a year and a daylight saving change?
// And does an expression with no answer stop rather than spin?

// A fixed moment to walk from, in local time, so nothing here depends on when
// it is run: Wednesday 15 July 2026, 10:30.
const FROM = new Date(2026, 6, 15, 10, 30).getTime();
const local = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const cron = (expr) => ({ kind: 'cron', expr });
const next = (expr, from = FROM) => local(nextAfter(cron(expr), from));

test('every syntax the parser claims to take, parses into what it looks like', () => {
  const set = (expr, field) => [...parseCron(expr)[field]].sort((a, b) => a - b);

  assert.deepEqual(set('* * * * *', 'minute').length, 60, 'a star is the whole field');
  assert.deepEqual(set('5 * * * *', 'minute'), [5]);
  assert.deepEqual(set('5-8 * * * *', 'minute'), [5, 6, 7, 8]);
  assert.deepEqual(set('*/15 * * * *', 'minute'), [0, 15, 30, 45]);
  assert.deepEqual(set('10-20/5 * * * *', 'minute'), [10, 15, 20]);
  assert.deepEqual(set('0,30 * * * *', 'minute'), [0, 30]);
  assert.deepEqual(set('0,15-17,45 * * * *', 'minute'), [0, 15, 16, 17, 45]);
  // A bare number with a step means "from here on", which is what every other
  // cron does with it.
  assert.deepEqual(set('50/5 * * * *', 'minute'), [50, 55]);
  assert.deepEqual(set('* * * * 1-5', 'dow'), [1, 2, 3, 4, 5]);
  // Sunday is spelled two ways in the wild, and a schedule that silently never
  // fired would be a terrible way to find out which one this takes.
  assert.deepEqual(set('* * * * 7', 'dow'), [0]);
  assert.deepEqual(set('* * * * 0', 'dow'), [0]);
});

test('what does not parse is refused, rather than parsed into something else', () => {
  for (const expr of [
    '',
    '   ',
    '* * *',
    '* * * * * *',
    '60 * * * *',
    '* 24 * * *',
    '* * 0 * *',
    '* * 32 * *',
    '* * * 13 *',
    '* * * * 8',
    '8-5 * * * *',
    'a b c d e',
    '*/0 * * * *',
    '*/x * * * *',
    '1--5 * * * *',
    // Names are not supported. Refused rather than half-accepted: an expression
    // that parses into something other than what it looks like is worse than
    // one that does not parse.
    '0 9 * * MON',
    '0 9 * JAN *',
  ]) {
    assert.equal(parseCron(expr), null, `${JSON.stringify(expr)} is not an expression`);
  }
});

test('the aliases mean exactly what they expand to', () => {
  for (const [alias, expr] of [
    ['@hourly', '0 * * * *'],
    ['@daily', '0 0 * * *'],
    ['@midnight', '0 0 * * *'],
    ['@weekly', '0 0 * * 0'],
  ]) {
    assert.equal(next(alias), next(expr), alias);
  }
  assert.equal(parseCron('@yearly'), null, 'and one that is not offered is not invented');
});

test('the walk lands on the next allowed minute, rolling every unit it has to', () => {
  // Wednesday 15 July 2026, 10:30 is where every one of these starts.
  assert.equal(next('* * * * *'), '2026-07-15 10:31', 'the very next minute');
  assert.equal(next('45 * * * *'), '2026-07-15 10:45', 'later this hour');
  assert.equal(next('15 * * * *'), '2026-07-15 11:15', 'over the hour');
  assert.equal(next('0 9 * * *'), '2026-07-16 09:00', 'over the day — nine has been and gone');
  assert.equal(next('0 9 1 * *'), '2026-08-01 09:00', 'over the month');
  assert.equal(next('0 9 1 1 *'), '2027-01-01 09:00', 'over the year');
  // Strictly after, always: the minute we are standing in has had its chance.
  assert.equal(next('30 10 * * *'), '2026-07-16 10:30', 'not the minute it is now');
});

test('a weekday schedule steps over the weekend', () => {
  // From Friday 17 July, 18:00 — the next weekday nine is Monday.
  const friday = new Date(2026, 6, 17, 18, 0).getTime();
  assert.equal(next('0 9 * * 1-5', friday), '2026-07-20 09:00');
  // And from Monday morning it is the same day.
  const monday = new Date(2026, 6, 20, 7, 0).getTime();
  assert.equal(next('0 9 * * 1-5', monday), '2026-07-20 09:00');
});

test("cron's day rule: restrict both, and either one qualifies", () => {
  // The surprising one, and the one people get wrong. `0 0 13 * 5` is the 13th
  // *and* every Friday, not the Friday the 13th.
  const from = new Date(2026, 10, 1, 0, 30).getTime(); // Sunday 1 November 2026
  const runs = nextRuns({ kind: 'cron', expr: '0 0 13 * 5' }, from, 4).map(local);
  assert.deepEqual(runs, [
    '2026-11-06 00:00', // a Friday
    '2026-11-13 00:00', // a Friday that is also the 13th
    '2026-11-20 00:00',
    '2026-11-27 00:00',
  ]);

  // Restrict only one, and only that one decides.
  assert.equal(next('0 0 13 * *', from), '2026-11-13 00:00', 'the 13th, whatever day it is');
  assert.equal(next('0 0 * * 5', from), '2026-11-06 00:00', 'Fridays, whatever date they are');
});

test('an expression with no answer stops, rather than spinning for four years', () => {
  // There is no 31 February. The walk is bounded, so this returns instead of
  // running until something gives up.
  assert.equal(nextAfter(cron('0 0 31 2 *'), FROM), null);
  // And one that is merely rare is still found: 29 February, two years out.
  assert.equal(next('0 0 29 2 *'), '2028-02-29 00:00');
});

test('a daily time stays that time across a daylight saving change', () => {
  // Only meaningful where the clocks actually move. Where they do not, the
  // assertion below is trivially true, which is the honest outcome rather than
  // a skipped test that looks like a pass.
  const jan = new Date(2026, 0, 15, 12, 0);
  const jul = new Date(2026, 6, 15, 12, 0);
  const shifts = jan.getTimezoneOffset() !== jul.getTimezoneOffset();

  // Walk a daily 09:00 across a fortnight that contains the spring change in
  // both hemispheres' usual windows, and check every one of them is 09:00.
  for (const start of [new Date(2026, 2, 22, 12, 0), new Date(2026, 9, 25, 12, 0)]) {
    const runs = nextRuns({ kind: 'cron', expr: '0 9 * * *' }, start.getTime(), 14);
    for (const ms of runs) {
      assert.equal(new Date(ms).getHours(), 9, `${local(ms)} is still nine o'clock`);
      assert.equal(new Date(ms).getMinutes(), 0);
    }
    // And they are consecutive days, so none was skipped or repeated.
    const days = runs.map((ms) => new Date(ms).getDate());
    assert.equal(new Set(days).size, days.length, 'each day once');
  }
  // Said out loud, so a run on a machine with no DST does not look like proof.
  if (!shifts) console.log('# note: this timezone has no daylight saving; the walk was checked anyway');
});

test('presets are cron underneath, so they cannot mean something different', () => {
  assert.equal(presetExpr({ preset: 'hourly', minute: 20 }), '20 * * * *');
  assert.equal(presetExpr({ preset: 'daily', minute: 5, hour: 7 }), '5 7 * * *');
  assert.equal(presetExpr({ preset: 'weekly', minute: 0, hour: 18, weekday: 5 }), '0 18 * * 5');
  assert.equal(presetExpr({ preset: 'never' }), null);

  // The same walker answers both spellings of the same intention.
  const spec = { kind: 'every', preset: 'daily', minute: 30, hour: 6 };
  assert.equal(nextAfter(spec, FROM), nextAfter(cron('30 6 * * *'), FROM));
  assert.equal(local(nextAfter(spec, FROM)), '2026-07-16 06:30');

  // Out-of-range parts fall back rather than producing an expression that will
  // not parse — a preset comes from a picker, not from typing.
  assert.equal(presetExpr({ preset: 'daily', minute: 99, hour: 99 }), '0 9 * * *');
});

test('a one-off is due once and then never again', () => {
  const when = FROM + 60_000;
  assert.equal(nextAfter({ kind: 'once', at: when }, FROM), when);
  assert.equal(nextAfter({ kind: 'once', at: when }, when), null, 'not at the moment it fires');
  assert.equal(nextAfter({ kind: 'once', at: when }, when + 1), null, 'nor after it');
  assert.equal(parseSchedule({ kind: 'once', at: 'soon' }), null);
  assert.equal(parseSchedule({ kind: 'once', at: 0 }), null);
});

test('anything that is not a schedule is refused', () => {
  for (const spec of [null, undefined, {}, 'daily', 42, { kind: 'sometimes' }, { kind: 'every' }]) {
    assert.equal(parseSchedule(spec), null, JSON.stringify(spec));
    assert.equal(nextAfter(spec, FROM), null);
    assert.equal(nextRuns(spec, FROM), null);
  }
});

test('the preview is the walker, so it cannot promise a time that will not happen', () => {
  const runs = nextRuns(cron('0 9 * * 1-5'), FROM, 3);
  assert.deepEqual(runs.map(local), ['2026-07-16 09:00', '2026-07-17 09:00', '2026-07-20 09:00']);
  // Each one is exactly what the scheduler will find from the one before it.
  assert.equal(nextAfter(cron('0 9 * * 1-5'), runs[0]), runs[1]);
  assert.equal(nextAfter(cron('0 9 * * 1-5'), runs[1]), runs[2]);
  // A one-off previews as the one time it has, not as three.
  assert.deepEqual(nextRuns({ kind: 'once', at: FROM + 1000 }, FROM, 3), [FROM + 1000]);
  assert.deepEqual(nextRuns(cron('0 0 31 2 *'), FROM, 3), [], 'and one with no answer previews as none');
});

test('a schedule can say what it does without making anybody read cron', () => {
  assert.equal(describeSchedule({ kind: 'once', at: FROM }), 'Once');
  assert.equal(describeSchedule({ kind: 'every', preset: 'hourly', minute: 5 }), 'Every hour at :05');
  assert.equal(
    describeSchedule({ kind: 'every', preset: 'daily', minute: 0, hour: 9 }),
    'Every day at 09:00'
  );
  assert.equal(
    describeSchedule({ kind: 'every', preset: 'weekly', minute: 30, hour: 18, weekday: 5 }),
    'Every Friday at 18:30'
  );
  // A cron expression describes itself. Anything else would be a translation
  // that could disagree with what actually runs.
  assert.equal(describeSchedule(cron('0 9 * * 1-5')), '0 9 * * 1-5');
  assert.equal(describeSchedule(cron('nonsense')), 'Not a schedule');
});
