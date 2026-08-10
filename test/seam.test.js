'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  MIN_DEBOUNCE_MS,
  MAX_DEBOUNCE_MS,
  LONG_MESSAGE,
  TYPING_TTL_MS,
  COOLDOWN_MS,
  PROTECTIVE_COOLDOWN_MS,
  PROTECTIVE_MAX_PER_HOUR,
  SEAM_PATIENCE_MS,
  debounceFor,
  seamOpen,
  seamStarved,
  protectiveAllowedNow,
  turnSpent,
} = require('../src/main/sessions/seam.js');

// Picking a moment to speak, tested without waiting for one.
//
// Timing is the least testable thing by running it and the most expensive to get
// wrong, so nothing in seam.js reads a clock — every function takes `now`. This
// file is the reason that indirection is worth its keep.

const NOW = 1_000_000_000;

// A room where nothing is happening: nobody typing, nothing said recently,
// nothing streaming, nobody spoke lately. Spoilt one field at a time below.
const QUIET = { typing: {}, lastHumanAt: NOW - 60_000, streaming: false, lastSpokeAt: 0, now: NOW };

test('a quiet room is a seam', () => {
  assert.equal(seamOpen(QUIET), true);
});

// ------------------------------------------------------- the four ways to be rude

test('somebody typing holds the floor shut', () => {
  const busy = { ...QUIET, typing: { 'p-zima': NOW - 1000 } };
  assert.equal(seamOpen(busy), false);
});

test('one person typing holds it shut for the whole room', () => {
  // The multi-person rule, made real by shared sessions rather than left
  // theoretical: in a room, one person still writing stops everybody.
  const busy = { ...QUIET, typing: { 'p-a': 0, 'p-b': NOW - 500 } };
  assert.equal(seamOpen(busy), false);
});

test('a stale typing indicator expires rather than pinning it shut for ever', () => {
  // There is no reliable "stopped typing without sending" event across a flaky
  // link. Trusting one indefinitely means one dropped frame silences the
  // observer permanently.
  const stale = { ...QUIET, typing: { 'p-a': NOW - TYPING_TTL_MS - 1 } };
  assert.equal(seamOpen(stale), true);
  const fresh = { ...QUIET, typing: { 'p-a': NOW - TYPING_TTL_MS + 100 } };
  assert.equal(seamOpen(fresh), false);
});

test('a message that just landed is not spoken over', () => {
  const justSaid = { ...QUIET, lastHumanAt: NOW - 1000, lastHumanText: 'ok' };
  assert.equal(seamOpen(justSaid), false);
});

test('an agent mid-answer is not spoken over', () => {
  const busy = { ...QUIET, streaming: true };
  assert.equal(seamOpen(busy), false);
});

test('an observer that just spoke waits before asking again', () => {
  // Diminishing returns made mechanical: the second contribution in a row is
  // where helpful turns into talkative.
  const recent = { ...QUIET, lastSpokeAt: NOW - 1000 };
  assert.equal(seamOpen(recent), false);
  const later = { ...QUIET, lastSpokeAt: NOW - COOLDOWN_MS - 1 };
  assert.equal(seamOpen(later), true);
});

// ------------------------------------------------------------------ the debounce

test('a short message buys a longer wait than a long one', () => {
  // A person who just sent one line is usually still typing the next; a person
  // who sent a paragraph is usually finished.
  assert.equal(debounceFor('ok'), MAX_DEBOUNCE_MS);
  assert.equal(debounceFor('x'.repeat(LONG_MESSAGE)), MIN_DEBOUNCE_MS);
  assert.equal(debounceFor(''), MAX_DEBOUNCE_MS);
  assert.equal(debounceFor(null), MAX_DEBOUNCE_MS);
});

test('the debounce is measured from the message, either way round', () => {
  const shortMsg = { ...QUIET, lastHumanText: 'ok' };
  assert.equal(seamOpen({ ...shortMsg, lastHumanAt: NOW - MAX_DEBOUNCE_MS + 100 }), false);
  assert.equal(seamOpen({ ...shortMsg, lastHumanAt: NOW - MAX_DEBOUNCE_MS - 1 }), true);
  const longMsg = { ...QUIET, lastHumanText: 'x'.repeat(LONG_MESSAGE) };
  // The same instant that was too soon after a short message is fine after a
  // long one.
  assert.equal(seamOpen({ ...longMsg, lastHumanAt: NOW - MIN_DEBOUNCE_MS - 1 }), true);
});

// --------------------------------------------------- absence is never permission

test('a room nobody is in is not a room that agreed to be spoken to', () => {
  // The rule worth stating twice. Presence is not an input to seamOpen at all —
  // if it were, the observer would be loudest exactly when the room is least
  // able to object. This test asserts the absence of a feature.
  const gone = { ...QUIET, typing: {} };
  const here = { ...QUIET, typing: { 'p-a': NOW - 100 } };
  // The only difference between these two is somebody typing. Nothing about who
  // is connected changes the answer, because nothing about it is consulted.
  assert.equal(seamOpen(gone), true);
  assert.equal(seamOpen(here), false);
});

// ------------------------------------------------------------- one turn, then wait

test('one unsolicited turn is spent until a person speaks again', () => {
  // Two in a row is a conversation between observers with somebody watching.
  assert.equal(turnSpent({ spokeAt: NOW, lastHumanAt: NOW - 1000 }), true);
  // The person said something after: the slot is open again.
  assert.equal(turnSpent({ spokeAt: NOW - 1000, lastHumanAt: NOW }), false);
  // Nobody has spoken unasked at all.
  assert.equal(turnSpent({ spokeAt: 0, lastHumanAt: NOW }), false);
});

// ------------------------------------------------------------- giving up waiting

test('a request that never found a gap stops waiting rather than expiring', () => {
  // It goes back to the shelf: the idea was worth having and is still worth
  // reading later. What ends is the waiting, not the idea.
  assert.equal(seamStarved(NOW - SEAM_PATIENCE_MS + 1, NOW), false);
  assert.equal(seamStarved(NOW - SEAM_PATIENCE_MS, NOW), true);
  assert.equal(seamStarved(0, NOW), false);
});

// -------------------------------------------------------- interrupting, rationed

test('an interruption does not wait for a seam but is still rationed', () => {
  assert.equal(protectiveAllowedNow([], NOW), true);
  // Once is enough for a good while.
  assert.equal(protectiveAllowedNow([NOW - 1000], NOW), false);
  assert.equal(protectiveAllowedNow([NOW - PROTECTIVE_COOLDOWN_MS - 1], NOW), true);
});

test('there is a ceiling on interruptions per hour, not only a gap between them', () => {
  // A cooldown alone permits six an hour for ever. If a room needs more than
  // this, the observer is misconfigured and somebody should look at it.
  const spaced = [];
  for (let i = 1; i <= PROTECTIVE_MAX_PER_HOUR; i += 1) {
    spaced.push(NOW - i * (PROTECTIVE_COOLDOWN_MS + 1000));
  }
  assert.equal(spaced.length, PROTECTIVE_MAX_PER_HOUR);
  // Every one is outside the cooldown, and it is still refused.
  assert.equal(protectiveAllowedNow(spaced, NOW), false);
  // An hour later they have aged out.
  assert.equal(protectiveAllowedNow(spaced, NOW + 60 * 60 * 1000), true);
});

test('nonsense in the interruption history does not open the gate', () => {
  assert.equal(protectiveAllowedNow([NaN, undefined, NOW - 1000], NOW), false);
  assert.equal(protectiveAllowedNow(null, NOW), true);
});
