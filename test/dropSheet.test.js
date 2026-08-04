'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The sheet that says what a dropped file will do, and when it goes away.
//
// Raising it is the easy half and was never broken. The half that was: a file
// dragged in and then carried back out again left the sheet up, over whatever
// conversation the window moved to next — Sessions, Agents, People — until the
// app was restarted. Nothing about that is visible in the markup, because it is
// a question about which events arrive and in what order, so it is settled in a
// browser with real DragEvents. See scripts/drop-harness.js.

const SRC = path.join(__dirname, '..', 'src', 'renderer');

test('the sheet is held up by the drag rather than switched off by an event', () => {
  // The property that makes a stuck sheet impossible, stated where it can be
  // read: nothing turns the sheet on and leaves it on. `hold` is renewed by
  // every dragenter and dragover and expires on its own, so any way a drag ends — out of
  // the window, Esc, a drop somewhere else — ends the sheet by simply going
  // quiet. A future edit that swaps this back for a plain boolean has to
  // contend with this test first.
  const hook = fs.readFileSync(path.join(SRC, 'lib', 'useFileDrag.js'), 'utf8');
  assert.match(hook, /setTimeout\(stop, QUIET_MS\)/, 'the sheet should expire unless the drag renews it');
  assert.match(hook, /setTimeout\(stop, GRACE_MS\)/, 'a dragleave should only propose an ending');

  const app = fs.readFileSync(path.join(SRC, 'App.jsx'), 'utf8');
  assert.ok(!/setDragOver/.test(app), 'the sheet should not be a boolean App can leave switched on');
  // The old dismissal, which is the bug: a dragleave on the app root only
  // counted when the pointer left the root element itself, and the root always
  // has a child under the pointer, so it never counted.
  assert.ok(
    !/e\.currentTarget === e\.target/.test(app),
    'a dragleave that only counts on the root element never fires'
  );
});

test('mounted in a browser: dragging a file in, across, and back out again', async () => {
  const { runDropHarness } = require('../scripts/drop-harness.js');
  const result = await runDropHarness();
  if (result.skipped) {
    // Chromium is not always present. Say so rather than reporting a pass that
    // never happened.
    console.log(`# skipped browser checks: ${result.skipped}`);
    return;
  }

  const s = result.steps;
  assert.ok(s, 'the harness should report');
  assert.deepEqual(s.errors, [], 'the window should raise nothing while a file is dragged over it');

  // ---- raised ------------------------------------------------------------
  assert.equal(s.beforeAnything, null, 'nothing is being dragged, so there should be no sheet');
  assert.equal(s.overPerson, 'Drop to send', 'a file over a person’s chat should say what dropping it does');

  // ---- and steady --------------------------------------------------------
  // Every element the pointer crosses fires a dragleave. A sheet that believed
  // them would blink on the way from the conversation to the panel, which is
  // exactly where these samples are taken.
  assert.equal(s.midCrossing, 'Drop to send', 'the sheet should not blink between two elements');
  assert.equal(s.overPanel, 'Drop to send', 'dragging over the panel is still dragging over the window');
  // The pointer coming to rest on the boundary itself: a dragleave and a
  // dragenter with no dragover behind them, because the next heartbeat can be
  // 550ms away. The dragenter is the only thing holding the sheet up here.
  assert.equal(
    s.restingAfterCrossing,
    'Drop to send',
    'a crossing that stops on the boundary should not blink'
  );
  assert.equal(s.afterCrossings, 'Drop to send', 'crossings should not accumulate into an early dismissal');

  // ---- the change of mind ------------------------------------------------
  // The report: a file carried back out of the window. Nothing announces it, so
  // the sheet has to come down on its own.
  assert.equal(s.afterLeaving, null, 'the sheet should go away when the file is carried back out');

  // And stay down wherever the window goes next, which is how it was noticed.
  for (const [room, step] of [
    ['a session', s.thenSession],
    ['an agent', s.thenAgent],
    ['a person', s.thenPerson],
  ]) {
    assert.ok(step.open, `${room} should be open, or an absent sheet proves nothing`);
    assert.equal(step.sheet, null, `the sheet should not survive into ${room}`);
  }

  // ---- the drag that stops without a word --------------------------------
  // Esc mid-drag, or a drop into another application: no dragleave, no dragend.
  assert.equal(s.overAgain, 'Drop to send', 'a second drag should raise the sheet again');
  assert.equal(s.afterSilence, null, 'a drag that goes silent should take the sheet with it');

  // ---- and the drop still works ------------------------------------------
  // A sheet that cannot get stuck is worth nothing if it stopped saying the
  // right thing, or if the file stopped arriving.
  assert.equal(
    s.overAgent,
    'Drop to give Tessie a document',
    'an agent reads a document rather than receiving a file'
  );
  assert.equal(s.afterDrop, null, 'dropping should put the sheet away');
  assert.deepEqual(
    s.sentFiles,
    [{ id: 'p1', paths: ['/home/agent/notes.txt'] }],
    'the dropped file should go to the open conversation'
  );
});
