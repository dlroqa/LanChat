'use strict';

const test = require('node:test');
const assert = require('node:assert');

// Inviting somebody, driven through the real App.
//
// This file exists because of a bug that every other test passed straight over.
// The picker's own harness mounts ChatPane and hands it `members` directly, so
// it proved the roster draws, reports a tick and emits the right patch — all
// true, and all beside the point. The card App builds for the pane is written
// field by field, `members` was not one of the fields, and in the running app
// the roster was therefore always empty and nothing could ever change.
//
// So the seam under test is the whole of it: App builds a card, the picker draws
// a row, a real click emits a patch, App routes it to main, main edits the
// record and republishes, and App has to render the result. A test that skips
// any link in that chain is a test that would have passed while the feature was
// broken.

let run = null;
function driven() {
  const { runInviteHarness } = require('../scripts/invite-harness.js');
  run ||= runInviteHarness();
  return run;
}

test('mounted in a browser: inviting somebody online reaches main and comes back', async () => {
  const s = await driven();
  if (s.skipped) {
    console.log(`# skipped browser checks: ${s.skipped}`);
    return;
  }
  assert.equal(s.mountError, null, 'the app should mount');
  assert.deepEqual(s.errors, [], 'and raise nothing while it runs');

  // The roster is drawn from the card, which is where the field was missing.
  assert.equal(s.rosterDrawn, true, 'somebody online appears on the roster');
  assert.equal(s.beforeNote, 'Invite', 'and the row says what pressing it will do');
  assert.equal(s.beforeChecked, 'false');

  // The click really reached main, with the session and the person named.
  assert.deepEqual(s.calls, [{ call: 'invite', id: 'session:1', peerId: 'p-zima' }]);
  assert.deepEqual(s.members, ['p-zima:invited'], 'and the record gained them');

  // The half that was broken: main published the change and the window drew it.
  // Before the card carried `members` this stayed on "Invite" forever, which is
  // exactly what somebody using it saw.
  assert.equal(s.afterNote, 'invited — waiting for an answer', 'the row reflects what main now holds');
  // Still not ticked, and that is right: an invitation is not membership, so the
  // tick waits for them to accept rather than appearing because we asked.
  assert.equal(s.afterChecked, 'false', 'asking somebody is not the same as them being here');
});
