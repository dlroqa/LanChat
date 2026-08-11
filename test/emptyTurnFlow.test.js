'use strict';

const test = require('node:test');
const assert = require('node:assert');

// A turn with nothing in it, erasing itself — through the real App.
//
// test/emptyTurn.test.js pins the rule, which is a pure function and can be
// asked anything. This is the part with a clock and a DOM in it: a bubble
// arriving, being counted down where somebody can see it, coming apart, leaving
// the window and being taken off the disk — and, in the same room at the same
// moment, the answer beside it that must not move.
//
// The two messages are chosen to be the hardest possible pair: one of them ends
// with the other one's entire text. A rule that looked at the end of a message
// rather than the whole of it would delete a paragraph of reasoning here, which
// is exactly the mistake this exists to prevent.

let run = null;
function driven() {
  const { runEmptyTurnHarness } = require('../scripts/empty-turn-harness.js');
  run ||= runEmptyTurnHarness();
  return run;
}

test('an empty turn erases itself and a real answer that closes with the same line does not', async () => {
  const result = await driven();
  if (result.skipped) {
    console.log(`# skipped browser check: ${result.skipped}`);
    return;
  }
  assert.equal(result.mountError, null, `the app should mount: ${result.mountError}`);
  assert.deepEqual(result.errors, [], 'nothing should have thrown in the page');
  assert.equal(result.foundSession, true, 'the session should be in the panel');

  // ---- the one with nothing in it ----------------------------------------
  const empty = result.emptyAtFirst;
  assert.ok(empty, 'the empty turn should be on screen and saying what happens to it');
  assert.equal(empty.erasing, true, 'it should be marked as going');
  assert.equal(
    empty.caption,
    'Erasing empty turn to maintain clean context conversation in 4s',
    'and say so in words, counting from four'
  );

  // Four seconds later it is out of the window and off the disk — both, or the
  // export would still have it.
  assert.equal(result.emptyAfter, null, 'it should be gone from the transcript');
  assert.deepEqual(
    result.purged,
    [{ id: 'session:1', ids: ['erase-me'] }],
    'and exactly it should have been taken off the disk'
  );

  // ---- the one with an answer in it --------------------------------------
  const kept = result.keptAfter;
  assert.ok(kept, 'the answer must still be there');
  assert.equal(kept.erasing, false, 'it was never on its way out');
  assert.equal(kept.caption, null, 'and nothing ever offered to erase it');
  assert.equal(result.keptAtFirst.erasing, false, 'not for a moment, either');
  assert.match(kept.text, /no rain for Brentwood through Thursday/, 'with the reasoning it arrived with');
  assert.match(kept.text, /nothing further\.$|nothing further\.\d/, 'and its closing line, unedited');
  assert.equal(result.bubbles, 1, 'one message left in the room, and it is that one');
});
