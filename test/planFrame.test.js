'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  newFrame,
  mergeFrame,
  concrete,
  filled,
  hardConstraints,
  frameDelta,
  renderFrame,
  MAX_PER_FIELD,
} = require('../src/main/sessions/plan.js');

// The picture of what the room is deciding.
//
// The frame is what separates an observer from a commentator: without it, "is
// this relevant?" is the only question available and the answer is always yes.
// So the rules about when there is enough of a plan to speak about, and about
// what may never get into one, are the rules this file holds.

const sourced = (text, sources, extra = {}) => ({ text, sources, ...extra });

const PLAN = {
  goal: 'Ship the observer without breaking chat',
  constraints: [sourced('Must work on a LAN', ['m1'], { hard: true })],
  candidate_actions: [sourced('Add a mode row to the picker', ['m2'])],
};

// ------------------------------------------------------- enough of a plan to speak

test('a topic is not a plan', () => {
  // Three fields of goal, constraint and assumption is people talking about
  // something. It is not somebody about to do something, and an observer that
  // spoke here would be a commentator.
  const frame = mergeFrame(newFrame('session:1'), {
    goal: 'Make the app faster',
    constraints: [sourced('Must stay on Electron', ['m1'])],
    assumptions: [sourced('Most rooms have three people', ['m2'])],
  });
  assert.equal(filled(frame).length, 3);
  assert.equal(concrete(frame), false);
});

test('a proposed action makes it a plan', () => {
  const frame = mergeFrame(newFrame('session:1'), PLAN, { messageIds: ['m1', 'm2'] });
  assert.equal(concrete(frame), true);
});

test('an action on its own is still not enough', () => {
  // One field is somebody thinking aloud. Three is a plan taking shape.
  const frame = mergeFrame(newFrame('session:1'), {
    candidate_actions: [sourced('Rewrite the transport', ['m1'])],
  });
  assert.equal(concrete(frame), false);
});

test('an empty frame is never concrete', () => {
  assert.equal(concrete(newFrame('session:1')), false);
  assert.equal(concrete(null), false);
});

// ------------------------------------------------------------------- provenance

test('an item that cannot say where it came from never enters the plan', () => {
  // The guard that stops a model summarising a conversation into constraints
  // nobody stated.
  const frame = mergeFrame(newFrame('session:1'), {
    constraints: [sourced('Must be encrypted', []), sourced('Must work on a LAN', ['m1'])],
  });
  assert.equal(frame.constraints.length, 1);
  assert.equal(frame.constraints[0].text, 'Must work on a LAN');
});

test('an item restated later points at both times it was said', () => {
  const first = mergeFrame(newFrame('session:1'), {
    constraints: [sourced('Must work on a LAN', ['m1'])],
  });
  const again = mergeFrame(first, { constraints: [sourced('must work on a lan', ['m7'])] });
  // Same constraint, not a second one.
  assert.equal(again.constraints.length, 1);
  assert.deepEqual(again.constraints[0].sources.sort(), ['m1', 'm7']);
});

// -------------------------------------------------------------------- versioning

test('a version moves only when the plan actually moved', () => {
  const first = mergeFrame(newFrame('session:1'), PLAN, { messageIds: ['m1'] });
  const before = first.version;
  // The same extraction again. A version that ticked here would expire every
  // candidate in flight on every message, and the observer would never finish
  // grounding anything.
  const again = mergeFrame(first, PLAN, { messageIds: ['m9'] });
  assert.equal(again.version, before);
  const grown = mergeFrame(again, { open_questions: [sourced('Who owns the rollout?', ['m9'])] });
  assert.equal(grown.version, before + 1);
});

test('a constraint hardening is material even though nothing was added', () => {
  // The difference between a preference and a rule, and the protective path
  // reads exactly that field.
  const soft = mergeFrame(newFrame('session:1'), {
    constraints: [sourced('Must work on a LAN', ['m1'], { hard: false })],
  });
  const hard = mergeFrame(soft, {
    constraints: [sourced('Must work on a LAN', ['m1'], { hard: true })],
  });
  assert.equal(hard.version, soft.version + 1);
  assert.equal(hardConstraints(hard).length, 1);
});

test('merging leaves the frame it was given exactly as it was', () => {
  // Not a nicety. A shallow array copy keeps the item objects, so tightening a
  // constraint reaches back through and edits the caller's previous version —
  // which silently breaks the version comparison, breaks frameDelta between two
  // versions, and means a frame already written to disk can change afterwards.
  const before = mergeFrame(newFrame('session:1'), PLAN, { messageIds: ['m1'] });
  const snapshot = JSON.stringify(before);
  mergeFrame(before, {
    constraints: [sourced('Must work on a LAN', ['m9'], { hard: true })],
    open_questions: [sourced('Who owns it?', ['m9'])],
  });
  assert.equal(JSON.stringify(before), snapshot);
});

test('hardness only ever tightens', () => {
  // A constraint stated absolutely and later paraphrased loosely must not
  // quietly stop being one. Softening is a decision, and decisions are the
  // person's.
  const hard = mergeFrame(newFrame('session:1'), {
    constraints: [sourced('Must work on a LAN', ['m1'], { hard: true })],
  });
  const loose = mergeFrame(hard, {
    constraints: [sourced('Must work on a LAN', ['m2'], { hard: false })],
  });
  assert.equal(loose.constraints[0].hard, true);
});

test('nothing already in the plan is removed by a later reading of it', () => {
  // A model that momentarily forgets a constraint must not be able to delete
  // one. Things leave a plan when a person takes them out, and by no other route.
  const full = mergeFrame(newFrame('session:1'), PLAN, { messageIds: ['m1'] });
  const forgetful = mergeFrame(full, { goal: 'Ship the observer without breaking chat' });
  assert.equal(forgetful.constraints.length, 1);
  assert.equal(forgetful.candidate_actions.length, 1);
});

test('a reading that found no goal leaves the goal that is there', () => {
  const full = mergeFrame(newFrame('session:1'), PLAN, { messageIds: ['m1'] });
  const quiet = mergeFrame(full, { constraints: [sourced('Must be fast', ['m3'])] });
  assert.equal(quiet.goal, PLAN.goal);
});

// ---------------------------------------------------------------- what changed

test('a delta says what moved, for a candidate that wants raising again', () => {
  const before = mergeFrame(newFrame('session:1'), PLAN, { messageIds: ['m1'] });
  const after = mergeFrame(before, {
    constraints: [sourced('Must survive a host disconnect', ['m5'], { hard: true })],
  });
  const delta = frameDelta(before, after);
  assert.match(delta, /1 constraint added/);
  // No movement, no delta — which is what blocks a re-raise that has no excuse.
  assert.equal(frameDelta(before, before), null);
});

// ------------------------------------------------------------------- rendering

test('a plan is rendered for an agent only once it is a plan', () => {
  const thin = mergeFrame(newFrame('session:1'), { goal: 'Make it faster' });
  assert.equal(renderFrame(thin), null);
  const real = mergeFrame(newFrame('session:1'), PLAN, { messageIds: ['m1'] });
  const text = renderFrame(real);
  assert.match(text, /Goal: Ship the observer/);
  assert.match(text, /Must work on a LAN \(hard\)/);
  assert.match(text, /Proposed actions:/);
});

test('a long-running room cannot push the question out of its own prompt', () => {
  const many = [];
  for (let i = 0; i < MAX_PER_FIELD + 5; i += 1) many.push(sourced(`constraint number ${i}`, [`m${i}`]));
  const frame = mergeFrame(newFrame('session:1'), {
    goal: 'A goal',
    constraints: many,
    candidate_actions: [sourced('Do the thing', ['m99'])],
  });
  const text = renderFrame(frame);
  assert.match(text, /and 5 more/);
  // What is rendered is bounded, but nothing was lost from the frame itself.
  assert.equal(frame.constraints.length, MAX_PER_FIELD + 5);
});

test('an item is trimmed rather than allowed to run away', () => {
  const frame = mergeFrame(newFrame('session:1'), {
    constraints: [sourced('x'.repeat(1000), ['m1'])],
  });
  assert.equal(frame.constraints[0].text.length, 300);
});

test('a plain string with no source is not an item', () => {
  const frame = mergeFrame(newFrame('session:1'), {
    constraints: ['Must work on a LAN', null, 42],
  });
  assert.equal(frame.constraints.length, 0);
});
