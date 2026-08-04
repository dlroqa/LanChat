'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The sidebar's categories, mounted and driven.
//
// The arithmetic behind them is pinned in test/sidebarSections.test.js, which is
// where the pure part lives. What is left is everything that only exists once
// the panel is running: a category opening because a pointer stayed on it,
// shutting because the pointer left, staying open because a lock was clicked,
// moving because it was dragged, and a shut one lighting its own title until the
// message behind it is read.
//
// The harness lives in scripts/ so it can be run by hand while working on the
// panel; this is the same run, with assertions.

const SRC = path.join(__dirname, '..', 'src', 'renderer');

test('the app only raises its file sheet for files', () => {
  // Every drag anywhere in the window reaches the app root, including a category
  // on its way to a new place in the list. The sidebar stops its own drags from
  // getting that far, and this is the second half of the same guard — one that
  // still holds if a later panel starts a drag and forgets to.
  const app = fs.readFileSync(path.join(SRC, 'App.jsx'), 'utf8');
  const guard = app.slice(app.indexOf('const dragCarriesFiles'), app.indexOf('async function onDrop'));
  assert.match(guard, /types[^)]*\)\.includes\('Files'\)/, 'the drop sheet should only answer to files');
  // And every way the sheet goes up asks that one guard, rather than each
  // carrying its own copy of it — a second copy is a second chance to be wrong.
  for (const on of ['onDragEnter', 'onDragOver']) {
    const handler = app.slice(app.indexOf(`${on}={(e) => {`), app.indexOf(`${on}={(e) => {`) + 220);
    assert.match(handler, /dragCarriesFiles\(e\)/, `${on} should raise the sheet through the shared guard`);
  }
});

test('mounted in a browser: pointing, pinning, dragging, and a title that keeps flashing until it is read', async () => {
  const { runSidebarHarness } = require('../scripts/sidebar-harness.js');
  const result = await runSidebarHarness();
  if (result.skipped) {
    // Chromium is not always present. Say so rather than reporting a pass that
    // never happened.
    console.log(`# skipped browser checks: ${result.skipped}`);
    return;
  }

  const s = result.steps;
  const open = (step, id) => step.sections[id].open;
  const shown = (step, id) => step.sections[id];

  // ---- at rest -----------------------------------------------------------
  // Four headings, and only the category holding the open conversation is
  // showing anything. The selected thread is an agent, so Agents is the one.
  assert.deepEqual(s.initial.order, ['sessions', 'agents', 'people', 'tailnet']);
  assert.equal(open(s.initial, 'agents'), true, 'the category holding the open conversation should be open');
  for (const id of ['sessions', 'people', 'tailnet']) {
    assert.equal(open(s.initial, id), false, `${id} should start shut`);
    assert.equal(
      shown(s.initial, id).rowsPx,
      0,
      `${id} is shut but still ${shown(s.initial, id).rowsPx}px tall`
    );
    // Shut means gone, not merely clipped: rows left visible are rows still in
    // the tab order and still read out by a screen reader.
    assert.equal(shown(s.initial, id).visibility, 'hidden', `${id} is shut but its rows are still visible`);
  }
  assert.ok(shown(s.initial, 'agents').rowsPx > 0, 'the open category should have the height of its rows');

  // A heading, not a label. It was 11px uppercase --fg-faint, which made the one
  // piece of text the panel always shows the quietest thing in it.
  assert.equal(shown(s.initial, 'people').titleSize, '15px');
  assert.equal(shown(s.initial, 'people').titleWeight, '700');

  // And nothing beside it. The grip, the lock and the roster's three buttons are
  // things done to a category rather than things it is saying, so at rest the
  // panel is four words — which is what was asked for.
  for (const id of ['sessions', 'agents', 'people', 'tailnet']) {
    const at = shown(s.initial, id);
    assert.equal(at.gripOpacity, 0, `${id}: the grip should be out of the way at rest`);
    assert.equal(at.lockOpacity, 0, `${id}: the lock should be out of the way at rest`);
    assert.equal(at.actionsOpacity, 0, `${id}: the heading's buttons should be out of the way at rest`);
  }
  assert.equal(
    shown(s.initial, 'people').actions,
    3,
    'the group-call, refresh and add buttons stay on People'
  );

  // ---- pointing ----------------------------------------------------------
  assert.equal(open(s.hoverPeople, 'people'), true, 'pointing at a heading should open it');
  assert.ok(shown(s.hoverPeople, 'people').rowsPx > 0, 'and it should be showing its rows');
  assert.equal(open(s.hoverPeople, 'agents'), true, 'without shutting the conversation you are in');

  assert.equal(open(s.awayFromPeople, 'people'), false, 'looking away should shut it again');
  assert.equal(shown(s.awayFromPeople, 'people').visibility, 'hidden');

  // ---- pinning -----------------------------------------------------------
  // The lock is a separate target from the heading, and what it pins has to
  // outlast the pointer that clicked it.
  assert.equal(
    open(s.lockedPeople, 'people'),
    true,
    'a locked category should stay open with the pointer gone'
  );
  assert.equal(shown(s.lockedPeople, 'people').locked, true);
  assert.equal(shown(s.lockedPeople, 'people').lockPressed, 'true', 'the lock should say it is pressed');
  assert.deepEqual(
    s.lockedPeople.saved.at(-1),
    { sidebarLocked: ['people'] },
    'and it should have been saved'
  );
  assert.equal(open(s.lockedPeople, 'sessions'), false, 'locking one category leaves the others shut');

  // ---- dragging ----------------------------------------------------------
  // Everything shuts while a category is being carried, locks included: four
  // headings are a short list to drop into, and a list that grew and shrank
  // under the pointer would be a moving target.
  for (const id of ['sessions', 'agents', 'people', 'tailnet']) {
    assert.equal(open(s.dragging, id), false, `${id} should be shut while a category is being dragged`);
  }
  assert.equal(
    shown(s.overSessions, 'sessions').classes.includes('drop-before'),
    true,
    'the top half of a heading should offer to take the category above it'
  );

  assert.deepEqual(
    s.dropped.order,
    ['tailnet', 'sessions', 'agents', 'people'],
    'the category should have moved'
  );
  assert.deepEqual(s.dropped.saved.at(-1), { sidebarOrder: ['tailnet', 'sessions', 'agents', 'people'] });
  assert.equal(s.dropped.reachedApp, 0, 'no part of a category drag should reach the app’s file-drop sheet');
  assert.equal(open(s.dropped, 'people'), true, 'and the lock survives the drag');

  // ---- the flash ---------------------------------------------------------
  // Shut, with three unread messages behind it. The count is beside the title as
  // well, which is what makes the motion safe to depend on: nothing is said only
  // by the light.
  assert.equal(shown(s.flashing, 'people').flashing, true, 'a shut category with unread should flash');
  assert.equal(shown(s.flashing, 'people').badge, '3', 'and say how many');
  assert.equal(shown(s.flashing, 'people').titleImage, 'gradient', 'the flash is a prism across the title');
  assert.match(shown(s.flashing, 'people').titleClip, /text/, 'clipped to the glyphs, which stay opaque');
  assert.equal(shown(s.flashing, 'agents').flashing, false, 'an open category does not flash');

  // The glass the lit letters sit on. Behind the text rather than over it, and
  // lit by the *same* animation as the title — one light crossing the row, not
  // two that happen to overlap.
  const plate = shown(s.flashing, 'people').plate;
  assert.equal(plate.present, true, 'a flashing heading should have its plate');
  assert.equal(plate.z, '-1', 'the plate belongs behind the text, never over it');
  assert.equal(plate.image, 'gradient', 'and it carries the travelling band');
  assert.equal(plate.animation, 'sb-prism', 'plate and title share one light source');
  assert.equal(shown(s.flashing, 'agents').plate.present, false, 'a category not flashing has no plate');

  // Looking at it is not reading it. The flash pauses while the category is
  // open — there is nothing to point at when the rows are on screen — and comes
  // back when the pointer leaves, because nothing has changed.
  assert.equal(shown(s.peeked, 'people').flashing, false);
  assert.equal(shown(s.stillFlashing, 'people').flashing, true, 'a peek should not count as having read it');
  assert.equal(shown(s.stillFlashing, 'people').badge, '3');

  // Opening the conversation is what stops it.
  assert.equal(shown(s.read, 'people').flashing, false, 'reading the message should stop the flash');
  assert.equal(shown(s.read, 'people').badge, null);

  // And the case with nothing to count: an agent that was summoned writes no
  // message, so its category says so with a dot instead of a number.
  assert.equal(shown(s.read, 'agents').flashing, true, 'a summoned agent should still raise its category');
  assert.equal(shown(s.read, 'agents').badge, null);
  assert.equal(shown(s.read, 'agents').dot, true);

  // ---- the keyboard ------------------------------------------------------
  // Drag-and-drop is never the only way to do this.
  assert.equal(open(s.gripFocused, 'sessions'), true, 'focusing a category should open it, as pointing does');
  assert.equal(s.gripFocused.focusIn, 'sessions');
  assert.equal(
    shown(s.gripFocused, 'sessions').gripOpacity,
    1,
    'and its controls should come out to be used'
  );
  assert.equal(shown(s.gripFocused, 'sessions').lockOpacity, 1);
  assert.equal(
    shown(s.gripFocused, 'tailnet').gripOpacity,
    0,
    'while the ones nobody is dealing with stay away'
  );
  assert.deepEqual(
    s.gripMoved.order,
    ['tailnet', 'agents', 'people', 'sessions'],
    'the arrow keys should move it'
  );
  assert.deepEqual(s.gripMoved.saved.at(-1), { sidebarOrder: ['tailnet', 'agents', 'people', 'sessions'] });
  assert.equal(s.gripMoved.focusIn, 'sessions', 'and the focus should travel with the category');

  // ---- searching ---------------------------------------------------------
  // A panel that kept its lists shut while a name was being typed into the box
  // above them would read as a search that had failed. A category with a match
  // opens itself; one without stays shut.
  assert.equal(open(s.searched, 'people'), true, 'a category with a match should open itself');
  assert.deepEqual(s.searched.matches, ['Elijah'], 'and show what was found, and only that');
  assert.equal(open(s.searched, 'agents'), false, 'a category with nothing in it stays shut');

  // ---- the prism, in pixels ----------------------------------------------
  // Measured off the screenshots rather than off the tokens: the title is text
  // being read, and what decides whether it can be is what the compositor put on
  // the screen. Each still is a different point in the sweep, and the figure is
  // the dimmest slice of the word in that still — not its brightest.
  const frames = Object.keys(result.contrast).filter((k) => k.startsWith('flash'));
  assert.ok(frames.length >= 5, 'the sweep should be sampled at several points');
  for (const name of frames) {
    const c = result.contrast[name];
    assert.ok(c && c.slices >= 4, `${name}: the title was not found in the screenshot`);
    assert.ok(c.worst >= 4.5, `${name}: the dimmest part of the prism is ${c.worst.toFixed(2)}:1`);
  }
  // The same word unlit, measured the same way — so a passing number above is
  // known to be a measurement rather than a method that reports 8 for anything.
  assert.ok(result.contrast.control.worst > 4.5, 'the control title should measure comfortably too');

  // With motion turned off at the browser, the sweep stops and the prism stays.
  assert.equal(result.reduced.titleAnimation, 'none', 'the sweep should stop for a reader who asked it to');
  assert.equal(result.reduced.titleImage, 'gradient', 'but the title stays lit');
  assert.equal(result.reduced.badge, '3', 'and the count is still there to be read');
  assert.ok(result.reduced.contrast.worst >= 4.5, `held still it measures ${result.reduced.contrast.worst}`);
});
