'use strict';

// What the room is actually deciding.
//
// An observer that speaks whenever the subject is interesting is a nuisance.
// Topic relevance is not the bar — almost everything said in a working
// conversation is relevant to something, and a model asked "is this relevant?"
// says yes. The bar is whether there is a *plan in motion*: a goal, things it
// must not break, a mechanism somebody is proposing, a decision about to be
// made. That is the only state in which an unasked-for contribution can be worth
// more than the interruption it costs.
//
// So a session that has observers keeps a frame: the plan as best it can be read
// off what people have said, versioned, with every field pointing back at the
// messages it came from. It is a draft and it is never anything else — nothing
// in here creates a decision, and the one field that could
// (`decisions`) is only ever written by a person acting deliberately. A model
// that could write into `decisions` would be a model that can put words in
// somebody's mouth and then reason about them as though they were said.
//
// Pure, like its neighbours: merging an extraction into a frame, deciding
// whether the plan moved, and deciding whether there is enough of a plan to
// speak about are all functions of what they are handed.

// The fields a plan is made of. Order matters — it is the order they are
// rendered to an agent and shown to a person, and it runs from what the work is
// towards what happens next.
const LIST_FIELDS = [
  'constraints',
  'assumptions',
  'candidate_actions',
  'open_questions',
  'decisions',
  'rejected_options',
  'owners',
  'next_steps',
];

// What has to be present before an observer may say anything unasked.
//
// At least three of these, and at least one of the two that mean somebody is
// about to *do* something. Three fields of goal, constraint and assumption is a
// topic; a candidate action or a decision point is a plan. The distinction is
// the whole of what separates an observer from a commentator.
const MIN_FIELDS = 3;
const ACTION_FIELDS = ['candidate_actions', 'decisions'];

function newFrame(sessionId, at = Date.now()) {
  return {
    planId: `plan-${sessionId}`,
    version: 0,
    sessionId,
    goal: null,
    goalSources: [],
    constraints: [],
    assumptions: [],
    candidate_actions: [],
    open_questions: [],
    decisions: [],
    rejected_options: [],
    owners: [],
    next_steps: [],
    sourceMessageIds: [],
    createdAt: at,
    updatedAt: at,
  };
}

// One item of a plan, cleaned.
//
// Every item carries where it came from, and an item that cannot say where it
// came from is dropped. That is the single most useful guard in this file: a
// model summarising a conversation will happily produce a constraint nobody
// stated, and the requirement to name a message is what makes that fail loudly
// rather than quietly becoming something the room believes it agreed.
function cleanItem(raw, { allowHard = false } = {}) {
  if (raw == null) return null;
  const item = typeof raw === 'string' ? { text: raw } : raw;
  if (typeof item !== 'object') return null;
  const text = String(item.text == null ? '' : item.text)
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  const sources = Array.isArray(item.sources || item.source_message_ids)
    ? (item.sources || item.source_message_ids).filter((id) => id != null).map(String)
    : [];
  if (sources.length === 0) return null;
  return {
    text: text.slice(0, 300),
    sources,
    // Only constraints have a hardness, and only where the caller says the field
    // can carry one — so a model cannot mark an assumption "hard" and have it
    // count towards a protective interruption.
    ...(allowHard && { hard: item.hard === true }),
  };
}

function cleanList(raw, options) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    const item = cleanItem(entry, options);
    // Nothing twice. Two models watching the same conversation will each extract
    // the same constraint, and a frame that accumulates duplicates grows without
    // ever saying anything new.
    if (item && !out.some((k) => k.text.toLowerCase() === item.text.toLowerCase())) out.push(item);
  }
  return out;
}

// A frame with an extraction folded into it.
//
// Additive: nothing already in the plan is removed by a later reading of it,
// because a model that momentarily forgets a constraint must not be able to
// delete one. Things leave a plan when a person takes them out, and by no other
// route.
//
// The version moves only when something material changed — see `moved` below.
// A version that ticked on every extraction would expire every candidate on
// every message, and the observer would never finish grounding anything.
function mergeFrame(frame, extracted, { at = Date.now(), messageIds = [] } = {}) {
  const base = frame || newFrame((extracted && extracted.sessionId) || 'unknown', at);
  const next = { ...base };

  const goal = extracted && extracted.goal ? String(extracted.goal).replace(/\s+/g, ' ').trim() : '';
  // A goal is replaced rather than accumulated — there is one — but only by a
  // goal, never by silence. An extraction that found no goal leaves the one
  // already there alone.
  if (goal) {
    next.goal = goal.slice(0, 300);
    next.goalSources = [...new Set([...(base.goalSources || []), ...messageIds.map(String)])];
  }

  for (const field of LIST_FIELDS) {
    // Copied item by item, not `[...base[field]]`.
    //
    // A spread copies the array and keeps every object in it, so tightening a
    // constraint below would reach through and change the frame that was passed
    // in — the caller's previous version, mutated under it. That breaks the
    // version comparison at the end of this function (the "before" would already
    // have the change), it breaks frameDelta between two versions, and it means
    // a frame written to disk could change after it was written. A merge has to
    // return a new frame and leave the old one exactly as it was.
    const merged = base[field].map((item) => ({ ...item, sources: [...item.sources] }));
    for (const item of cleanList(extracted && extracted[field], { allowHard: field === 'constraints' })) {
      const twin = merged.find((k) => k.text.toLowerCase() === item.text.toLowerCase());
      if (!twin) {
        merged.push(item);
        continue;
      }
      // Already known. It keeps its place and gains whatever new grounding this
      // reading found, so a constraint restated later points at both times it
      // was said.
      twin.sources = [...new Set([...twin.sources, ...item.sources])];
      // Hardness only ever tightens. A constraint stated as absolute and later
      // paraphrased loosely must not quietly stop being one — softening is a
      // decision, and decisions are the person's.
      if (item.hard === true) twin.hard = true;
    }
    next[field] = merged;
  }

  next.sourceMessageIds = [...new Set([...base.sourceMessageIds, ...messageIds.map(String)])];
  next.updatedAt = at;
  next.version = moved(base, next) ? base.version + 1 : base.version;
  return next;
}

// Whether the plan changed in a way anything should care about.
//
// Counting fields rather than comparing text: a reworded goal is the same goal,
// and a version bump for a rephrasing would expire every candidate in flight for
// no reason. A new constraint, a new proposed action, a new decision — those are
// the plan moving.
function moved(before, after) {
  if (!before.goal && after.goal) return true;
  for (const field of LIST_FIELDS) {
    if (after[field].length !== before[field].length) return true;
    // A constraint that hardened is material even though nothing was added: it
    // is the difference between a preference and a rule, and the protective path
    // reads exactly that field.
    for (let i = 0; i < after[field].length; i += 1) {
      if (after[field][i].hard === true && before[field][i].hard !== true) return true;
    }
  }
  return false;
}

// How much of a plan there is.
function filled(frame) {
  if (!frame) return [];
  const has = [];
  if (frame.goal) has.push('goal');
  for (const field of LIST_FIELDS) {
    if (frame[field] && frame[field].length) has.push(field);
  }
  return has;
}

// Whether there is enough of a plan for an observer to speak about unasked.
//
// Three fields, one of which means somebody is about to act. Direct invocation
// does not consult this — being asked a question is its own justification — and
// nothing else may skip it.
function concrete(frame) {
  const has = filled(frame);
  if (has.length < MIN_FIELDS) return false;
  return ACTION_FIELDS.some((f) => has.includes(f));
}

// The hard constraints, which are the only things a protective interruption may
// be about. Returned as text so the warning can name the one it is protecting —
// a warning that cannot say what rule is about to be broken has not earned the
// interruption.
function hardConstraints(frame) {
  return ((frame && frame.constraints) || []).filter((c) => c.hard === true);
}

// What changed between two versions, in words.
//
// Used for two things: showing a person why a candidate came back, and giving a
// re-raised candidate the delta it is required to have. Deliberately short — it
// is a reason, not a report.
function frameDelta(before, after) {
  if (!before || !after) return null;
  if (before.version === after.version) return null;
  const parts = [];
  if (!before.goal && after.goal) parts.push('a goal was set');
  for (const field of LIST_FIELDS) {
    const grew = after[field].length - before[field].length;
    if (grew > 0) parts.push(`${grew} ${LABEL[field] || field}${grew === 1 ? '' : 's'} added`);
  }
  const hardened = hardConstraints(after).length - hardConstraints(before).length;
  if (hardened > 0 && !parts.length) parts.push('a constraint became hard');
  if (!parts.length) return null;
  return parts.join(', ');
}

const LABEL = {
  constraints: 'constraint',
  assumptions: 'assumption',
  candidate_actions: 'proposed action',
  open_questions: 'open question',
  decisions: 'decision',
  rejected_options: 'rejected option',
  owners: 'owner',
  next_steps: 'next step',
};

// The plan as an agent is shown it.
//
// Rendered rather than handed over as JSON, because every transport here takes
// text and a model reads a list better than it reads a serialisation. Bounded,
// so a long-running room cannot push the question out of its own prompt.
const MAX_PER_FIELD = 8;

function renderFrame(frame) {
  if (!frame || !concrete(frame)) return null;
  const lines = [];
  if (frame.goal) lines.push(`Goal: ${frame.goal}`);
  for (const field of LIST_FIELDS) {
    const items = frame[field];
    if (!items || !items.length) continue;
    lines.push(`${TITLE[field]}:`);
    for (const item of items.slice(0, MAX_PER_FIELD)) {
      lines.push(`  - ${item.text}${item.hard === true ? ' (hard)' : ''}`);
    }
    if (items.length > MAX_PER_FIELD) lines.push(`  - … and ${items.length - MAX_PER_FIELD} more`);
  }
  return lines.join('\n');
}

const TITLE = {
  constraints: 'Constraints',
  assumptions: 'Assumptions',
  candidate_actions: 'Proposed actions',
  open_questions: 'Open questions',
  decisions: 'Decisions',
  rejected_options: 'Rejected',
  owners: 'Owners',
  next_steps: 'Next steps',
};

module.exports = {
  LIST_FIELDS,
  MIN_FIELDS,
  ACTION_FIELDS,
  MAX_PER_FIELD,
  newFrame,
  cleanItem,
  cleanList,
  mergeFrame,
  moved,
  filled,
  concrete,
  hardConstraints,
  frameDelta,
  renderFrame,
};
