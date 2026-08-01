'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Composer.jsx is JSX, so only the pure helper is lifted out of it here — the
// same way ptt.test.js evaluates the non-DOM half of ptt.js. What is under test
// is how a dictated phrase meets whatever is already in the message box.
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'components', 'Composer.jsx'),
  'utf8'
);

function loadJoinSpoken() {
  const match = SRC.match(/export function joinSpoken[\s\S]*?\n}/);
  assert.ok(match, 'joinSpoken must stay a self-contained function');
  const fn = new Function(`'use strict'; ${match[0].replace(/^export /, '')} return joinSpoken;`);
  return fn();
}

test('dictating into an empty box just writes the words', () => {
  const joinSpoken = loadJoinSpoken();
  assert.equal(joinSpoken('', 'what is the plan'), 'what is the plan');
  assert.equal(joinSpoken(undefined, 'what is the plan'), 'what is the plan');
});

test('dictating again continues the message rather than replacing it', () => {
  const joinSpoken = loadJoinSpoken();
  assert.equal(joinSpoken('what is the plan', 'and when'), 'what is the plan and when');
});

test('a half-typed line does not collect a double space', () => {
  const joinSpoken = loadJoinSpoken();
  // The composer is where the caret was left, so trailing whitespace is normal.
  assert.equal(joinSpoken('what is the plan ', 'and when'), 'what is the plan and when');
  assert.equal(joinSpoken('what is the plan\n', 'and when'), 'what is the plan and when');
  assert.equal(joinSpoken('   ', 'and when'), 'and when', 'whitespace alone is an empty box');
});

test('the restore path is untouched by the append path', () => {
  // A refused message is put back with no mode, and the effect must then use
  // draft.text exactly — the one thing that would quietly break the existing
  // behaviour is if append leaked into it.
  const effect = SRC.match(/const next =\s*draft\.mode === 'append'[^;]*;/);
  assert.ok(effect, 'the branch must stay legible');
  assert.match(
    effect[0],
    /:\s*draft\.text;/,
    'anything that is not an append is still the draft text verbatim'
  );
});
