'use strict';

// When a scheduled task is next due.
//
// Three ways to say when: once at a moment, every so often out of a short list
// of presets, or a cron expression. The presets compile to cron and the same
// walker answers all three of them — two engines would disagree at a daylight
// saving boundary, and the disagreement would be invisible until something
// fired at the wrong hour once a year.
//
// Hand-written rather than a dependency, because this app has exactly one
// runtime dependency and a five-field parser is a hundred lines. Pure: nothing
// in here reads a clock it was not given, which is what makes a schedule
// testable without waiting for one.
//
// Local time throughout. "Every day at nine" means nine o'clock where the
// person is, and it goes on meaning that across a daylight saving change —
// which is what people mean and is not what UTC arithmetic gives you. Two edges
// come with that and are handled by the walk below rather than by special
// cases: on the morning the clocks go forward, a time that does not exist that
// day is skipped to the next one that does; on the morning they go back, an
// hour that happens twice fires once, because the search is always for a moment
// strictly later than the last one.

// Minute, hour, day of month, month, day of week — the five, in order, with the
// bounds each is allowed.
const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dom', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dow', min: 0, max: 6 },
];

// The three shorthands worth having. Written out rather than special-cased, so
// they go through the same parser and cannot mean anything different from what
// they expand to.
const ALIASES = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
};

// Far enough that an expression with a real answer always has it inside the
// bound — the worst honest case is 29 February, four years out, and the walk
// below moves a whole month or a whole day at a time rather than a minute. Far
// enough, too, that one with no answer at all (`0 0 31 2 *`) stops rather than
// spinning.
const MAX_STEPS = 20_000;

// Presets are cron underneath. Only the shapes the panel offers, so a preset
// cannot express something the panel cannot then show back.
const PRESETS = ['hourly', 'daily', 'weekly'];

function inRange(n, { min, max }) {
  return Number.isInteger(n) && n >= min && n <= max;
}

// One field of an expression to the set of values it allows, or null if it does
// not parse. Accepts `*`, `n`, `a-b`, `*/n`, `a-b/n`, and comma-separated lists
// of any of those.
function parseField(text, field) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const out = new Set();
  for (const part of raw.split(',')) {
    const [range, stepText] = part.split('/');
    if (stepText !== undefined && !/^\d+$/.test(stepText)) return null;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) return null;

    let from;
    let to;
    if (range === '*') {
      from = field.min;
      to = field.max;
    } else if (/^\d+$/.test(range)) {
      from = Number(range);
      // A bare number with a step means "from here on": `5/10` in the minute
      // field is 5, 15, 25… which is what every cron does with it.
      to = stepText === undefined ? from : field.max;
    } else {
      const m = range.match(/^(\d+)-(\d+)$/);
      if (!m) return null;
      from = Number(m[1]);
      to = Number(m[2]);
    }

    // Sunday is 0, and 7 is also Sunday — both spellings are in the wild, and a
    // schedule that silently never fired would be the worst way to find out.
    if (field.name === 'dow') {
      if (from === 7) from = 0;
      if (to === 7) to = 0;
    }
    if (!inRange(from, field) || !inRange(to, field) || to < from) return null;
    for (let n = from; n <= to; n += step) out.add(n);
  }
  return out.size ? out : null;
}

// A cron expression to five sets, or null.
//
// Deliberately no month or day names (`JAN`, `MON`). Saying so here rather than
// accepting them half-heartedly: an expression that parses into something
// different from what it looks like is worse than one that is refused.
function parseCron(expr) {
  const text = String(expr || '')
    .trim()
    .toLowerCase();
  if (!text) return null;
  const expanded = ALIASES[text] || text;
  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = [];
  for (let i = 0; i < 5; i += 1) {
    const set = parseField(parts[i], FIELDS[i]);
    if (!set) return null;
    sets.push(set);
  }
  return { minute: sets[0], hour: sets[1], dom: sets[2], month: sets[3], dow: sets[4] };
}

// A preset to the expression it means.
function presetExpr({ preset, minute = 0, hour = 9, weekday = 1 } = {}) {
  const m = inRange(minute, FIELDS[0]) ? minute : 0;
  const h = inRange(hour, FIELDS[1]) ? hour : 9;
  const d = inRange(weekday, FIELDS[4]) ? weekday : 1;
  if (preset === 'hourly') return `${m} * * * *`;
  if (preset === 'daily') return `${m} ${h} * * *`;
  if (preset === 'weekly') return `${m} ${h} * * ${d}`;
  return null;
}

// A spec as it is stored, made safe to schedule from — or null, which is what
// the panel turns into the sentence it shows.
//
// Three kinds:
//   { kind: 'once',  at }
//   { kind: 'every', preset, minute, hour, weekday }
//   { kind: 'cron',  expr }
function parseSchedule(spec) {
  if (!spec || typeof spec !== 'object') return null;
  if (spec.kind === 'once') {
    const at = Number(spec.at);
    return Number.isFinite(at) && at > 0 ? { kind: 'once', at } : null;
  }
  if (spec.kind === 'every') {
    if (!PRESETS.includes(spec.preset)) return null;
    const expr = presetExpr(spec);
    const fields = expr && parseCron(expr);
    return fields ? { kind: 'every', expr, fields } : null;
  }
  if (spec.kind === 'cron') {
    const fields = parseCron(spec.expr);
    return fields ? { kind: 'cron', expr: String(spec.expr).trim(), fields } : null;
  }
  return null;
}

// Cron's day rule, which is the one part of it that surprises people: when both
// the day of month and the day of week are restricted, a day matching *either*
// qualifies. When only one is restricted, only that one decides.
function dayAllowed(fields, date) {
  const domAll = fields.dom.size === 31;
  const dowAll = fields.dow.size === 7;
  const dom = fields.dom.has(date.getDate());
  const dow = fields.dow.has(date.getDay());
  if (domAll && dowAll) return true;
  if (domAll) return dow;
  if (dowAll) return dom;
  return dom || dow;
}

const at = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi, 0, 0);

// The first moment strictly after `from` that the expression allows, or null if
// it allows none.
//
// Component arithmetic rather than a minute-by-minute scan: four years of
// minutes is two million iterations, and a schedule that has to be checked on a
// timer cannot pay that. Each step below skips the largest unit it can — a
// whole month, then a whole day, then an hour — so an expression like
// "09:00 on 1 January" is found in a handful of passes.
function nextAfter(spec, fromMs) {
  const parsed = spec && spec.fields ? spec : parseSchedule(spec);
  if (!parsed) return null;
  if (parsed.kind === 'once') return parsed.at > fromMs ? parsed.at : null;

  const fields = parsed.fields;
  const start = new Date(Number(fromMs));
  if (Number.isNaN(start.getTime())) return null;
  // Strictly after: the minute `from` is in has already had its chance, which
  // is also what stops a repeated hour firing twice when the clocks go back.
  let t = at(
    start.getFullYear(),
    start.getMonth(),
    start.getDate(),
    start.getHours(),
    start.getMinutes() + 1
  );

  for (let steps = 0; steps < MAX_STEPS; steps += 1) {
    if (!fields.month.has(t.getMonth() + 1)) {
      // The first of the next month, at midnight. Month 12 rolls the year over
      // on its own — Date takes an out-of-range month and carries it.
      t = at(t.getFullYear(), t.getMonth() + 1, 1, 0, 0);
      continue;
    }
    if (!dayAllowed(fields, t)) {
      t = at(t.getFullYear(), t.getMonth(), t.getDate() + 1, 0, 0);
      continue;
    }
    if (!fields.hour.has(t.getHours())) {
      t = at(t.getFullYear(), t.getMonth(), t.getDate(), t.getHours() + 1, 0);
      continue;
    }
    if (!fields.minute.has(t.getMinutes())) {
      t = at(t.getFullYear(), t.getMonth(), t.getDate(), t.getHours(), t.getMinutes() + 1);
      continue;
    }
    return t.getTime();
  }
  return null;
}

// The next few times, for the panel to show back. The same walker, so a preview
// cannot promise a moment the scheduler will not honour — which is the whole
// point of showing one, and the only validation a cron expression can really
// have.
function nextRuns(spec, fromMs, count = 3) {
  const parsed = parseSchedule(spec);
  if (!parsed) return null;
  const out = [];
  let t = Number(fromMs);
  for (let i = 0; i < Math.max(1, count); i += 1) {
    const next = nextAfter(parsed, t);
    if (next == null) break;
    out.push(next);
    t = next;
  }
  return out;
}

// What a spec is called, in words, for a row that has to say what it does
// without making somebody read cron.
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function describeSchedule(spec) {
  const parsed = parseSchedule(spec);
  if (!parsed) return 'Not a schedule';
  if (parsed.kind === 'once') return 'Once';
  if (parsed.kind === 'every') {
    const mm = String(spec.minute ?? 0).padStart(2, '0');
    const hh = String(spec.hour ?? 9).padStart(2, '0');
    if (spec.preset === 'hourly') return `Every hour at :${mm}`;
    if (spec.preset === 'daily') return `Every day at ${hh}:${mm}`;
    return `Every ${DAYS[spec.weekday ?? 1] || 'Monday'} at ${hh}:${mm}`;
  }
  return parsed.expr;
}

module.exports = {
  parseCron,
  parseField,
  parseSchedule,
  presetExpr,
  nextAfter,
  nextRuns,
  describeSchedule,
  PRESETS,
  ALIASES,
  MAX_STEPS,
};
