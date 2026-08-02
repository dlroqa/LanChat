'use strict';

const test = require('node:test');
const assert = require('node:assert');

// The Trash, mounted and driven.
//
// What main does with a deleted session is pinned in test/sessionsTrash.test.js.
// This is the other half — the half a person actually touches — and none of it
// is checkable without a browser: a button that has to open a panel, a delete
// that has to stop asking, a row whose "Recover to Sessions" has to put the
// session back somewhere it can be opened, and an Empty that has to ask before
// it takes anything away for good.
//
// The harness lives in scripts/ so it can be run by hand while working on the
// panel; this is the same run, with assertions.

test('mounted in a browser: deleting, recovering, and emptying the Trash', async () => {
  const { runTrashHarness } = require('../scripts/trash-harness.js');
  const result = await runTrashHarness();
  if (result.skipped) {
    // Chromium is not always present. Say so rather than reporting a pass that
    // never happened.
    console.log(`# skipped browser checks: ${result.skipped}`);
    return;
  }

  const s = result.steps;
  assert.deepEqual(s.errors, [], 'the window logged errors');

  // ---- at rest -------------------------------------------------------------
  // Three sessions in the roster, and a Trash button that is not shouting about
  // an empty Trash.
  assert.equal(s.start.buttonPressed, 'false');
  assert.equal(s.start.buttonCount, null, 'an empty Trash should not wear a nought');

  // ---- an empty Trash, opened ----------------------------------------------
  assert.equal(s.emptyTrash.title, 'Trash');
  assert.equal(s.emptyTrash.sub, 'Empty');
  assert.equal(s.emptyTrash.buttonPressed, 'true');
  assert.match(s.emptyTrash.emptyHint, /waits in the Trash/);
  // Delete all first, Restore all to its right — the arrangement in the design.
  assert.deepEqual(
    s.emptyTrash.actions.map((a) => [a.label, a.danger, a.disabled]),
    [
      ['Delete everything in the Trash for good', true, true],
      ['Restore all sessions', false, true],
    ],
    'both header actions should be present, in order, and off while there is nothing to act on'
  );
  // The roster is untouched by any of this: opening the Trash is not a filter.
  assert.equal(s.emptyTrash.sessions.length, s.start.sessions.length);

  // ---- deleting a session from its own header ------------------------------
  assert.deepEqual(s.afterDelete.asked, [], 'moving a session to the Trash must not ask');
  assert.deepEqual(s.afterDelete.deleted, ['session:1']);
  assert.ok(
    !s.afterDelete.sessions.some((t) => t.includes('Quakes')),
    'the deleted session should leave the roster'
  );
  assert.equal(s.afterDelete.buttonCount, '1', 'the button should say how many are waiting');

  // ---- and what is waiting there -------------------------------------------
  assert.equal(s.oneInTrash.sub, '1 deleted session');
  assert.deepEqual(s.oneInTrash.trashRows, [
    { name: 'Quakes', sub: 'Deleted 8/2/2026', restore: 'Recover to Sessions', canPurge: true },
  ]);
  assert.ok(
    s.oneInTrash.actions.every((a) => !a.disabled),
    'both header actions should wake up once there is something in the Trash'
  );

  // ---- the way back --------------------------------------------------------
  // Recovering puts the session in the roster and opens it, so the panel that
  // was showing the Trash is showing the recovered conversation.
  assert.deepEqual(s.afterRestore.restored, ['session:1']);
  assert.deepEqual(s.afterRestore.live, ['Quakes', 'Tides', 'Kangkong']);
  assert.equal(s.afterRestore.title, 'Quakes', 'recovering should open what it recovered');
  assert.equal(s.afterRestore.buttonPressed, 'false', 'and leave the Trash');
  assert.equal(s.afterRestore.buttonCount, null);

  // ---- emptying it ---------------------------------------------------------
  assert.equal(s.twoInTrash.sub, '2 deleted sessions');
  assert.equal(s.twoInTrash.trashRows.length, 2);
  assert.equal(s.afterPurgeAll.askedThen.length, 1, 'deleting for good must ask exactly once');
  assert.match(s.afterPurgeAll.askedThen[0], /Delete 2 sessions in the Trash for good\?/);
  assert.match(s.afterPurgeAll.askedThen[0], /cannot be undone/);
  assert.deepEqual(s.afterPurgeAll.dead, [], 'the Trash should be empty afterwards');
  assert.deepEqual(s.afterPurgeAll.live, ['Quakes'], 'and nothing outside it should have moved');
  assert.equal(s.afterPurgeAll.sub, 'Empty');

  // ---- and it looks like something -----------------------------------------
  // The toggle has to read as selected while the Trash is what the window is
  // showing. Measured off the screenshot rather than from getComputedStyle,
  // which reports this button transparent on a page where it plainly is not —
  // and against the Settings button beside it, so a stylesheet that failed to
  // load would fail here rather than quietly agreeing with itself.
  for (const [name, fill] of Object.entries(result.fills)) {
    assert.deepEqual(fill.plain, [21, 24, 33], `${name}: the control button should be unlit`);
    assert.notDeepEqual(fill.on, fill.plain, `${name}: the Trash toggle should not look like the rest`);
    // Blue, and clearly so: the accent, not a grey hover.
    assert.ok(fill.on[2] > fill.on[0] + 40, `${name}: the lit toggle should read blue, got ${fill.on}`);
  }
});
