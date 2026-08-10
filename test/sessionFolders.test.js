'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Sessions, filed.
//
// The rules worth pinning here are the ones that come from the choice the model
// makes: a folder holds an ordered list of session ids, and a session record
// knows nothing about folders. Everything below is a consequence of that, and
// each consequence is a thing that would be a bug if it went the other way.
//
// ESM for the renderer, so the imports come off and the `export` keywords are
// stripped and the module is evaluated — exactly as sidebarSections.test.js
// does. Nothing runs at module scope, so React never has to exist.
const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const SRC = fs.readFileSync(path.join(RENDERER, 'lib', 'sessionFolders.js'), 'utf8');
const { folderOf, filedIds, folderSessions, looseSessions, dropIndex, moveFolder, isNoopPlace } =
  new Function(
    `${SRC.replace(/^import[^;]+;$/gm, '').replace(/^export\s+/gm, '')}
   return { folderOf, filedIds, folderSessions, looseSessions, dropIndex, moveFolder, isNoopPlace };`
  )();

const session = (id, updatedAt) => ({ id, title: id, updatedAt });
const byId = (list) => new Map(list.map((s) => [s.id, s]));

// ------------------------------------------------------------------ membership

test('a session belongs to the first folder that claims it', () => {
  // A hand-edited file could list the same session twice. The alternative to
  // picking a winner is drawing the same row in two places, both of which look
  // authoritative.
  const folders = [
    { id: 'folder:1', name: 'One', sessionIds: ['s1'] },
    { id: 'folder:2', name: 'Two', sessionIds: ['s1', 's2'] },
  ];
  assert.equal(folderOf(folders, 's1').id, 'folder:1');
  assert.equal(folderOf(folders, 's2').id, 'folder:2');
  assert.equal(folderOf(folders, 'nobody'), null);
  assert.equal(folderOf(folders, null), null, 'nothing selected is not in a folder');
  assert.deepEqual([...filedIds(folders)].sort(), ['s1', 's2']);
});

test('nothing filed means nothing changes', () => {
  const list = [session('a', 3), session('b', 2)];
  assert.deepEqual(looseSessions(list, []), list, 'no folders, and the list is the list');
  assert.deepEqual(filedIds([]).size, 0);
  assert.deepEqual(folderSessions(null, byId(list)), []);
});

test('a folder draws its sessions in its own order, and the loose list keeps its', () => {
  // The two halves are ordered by different things on purpose: inside a folder
  // it is the order you dragged them into, outside it is still most recently
  // used first, which is what main sorted them by and what nothing here re-sorts.
  const list = [session('newest', 3), session('middle', 2), session('oldest', 1)];
  const folders = [{ id: 'folder:1', name: 'F', sessionIds: ['oldest', 'newest'] }];
  assert.deepEqual(
    folderSessions(folders[0], byId(list)).map((s) => s.id),
    ['oldest', 'newest'],
    'the folder keeps the order it was given, not the sort'
  );
  assert.deepEqual(
    looseSessions(list, folders).map((s) => s.id),
    ['middle'],
    'and what is left is still in the order it arrived'
  );
});

// This is the whole trash story, and it needs no code of its own anywhere: a
// trashed session leaves the live list, so it stops being drawn while its id
// waits in the array exactly where it was.
test('a session in the Trash leaves its folder without losing its place', () => {
  const folder = { id: 'folder:1', name: 'F', sessionIds: ['a', 'gone', 'b'] };
  const alive = [session('a', 3), session('b', 2)];
  assert.deepEqual(
    folderSessions(folder, byId(alive)).map((s) => s.id),
    ['a', 'b'],
    'it is simply not drawn'
  );

  const restored = [session('a', 3), session('gone', 1), session('b', 2)];
  assert.deepEqual(
    folderSessions(folder, byId(restored)).map((s) => s.id),
    ['a', 'gone', 'b'],
    'and it comes back between the two it was between, with nothing written'
  );
});

// --------------------------------------------------------------- the drop index

test('a drop lands where it was aimed', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(dropIndex(ids, 'x', 'a', true), 0, 'before the first');
  assert.equal(dropIndex(ids, 'x', 'a', false), 1, 'after the first');
  assert.equal(dropIndex(ids, 'x', 'c', false), 3, 'after the last');
  assert.equal(dropIndex(ids, 'x', 'nobody', false), 3, 'onto nothing is the end');
});

// The off-by-one this arithmetic exists to avoid. Locate the target first and a
// session dragged *downward* within its own folder lands a slot short, because
// the index it was measured against still counted itself.
test('a session dragged down past its neighbour ends up past it', () => {
  const ids = ['a', 'b', 'c'];
  // 'a' dropped on the lower half of 'b' should end up between b and c.
  const at = dropIndex(ids, 'a', 'b', false);
  const rest = ids.filter((x) => x !== 'a');
  rest.splice(at, 0, 'a');
  assert.deepEqual(rest, ['b', 'a', 'c']);
});

test('a session dragged up past its neighbour ends up before it', () => {
  const ids = ['a', 'b', 'c'];
  const at = dropIndex(ids, 'c', 'b', true);
  const rest = ids.filter((x) => x !== 'c');
  rest.splice(at, 0, 'c');
  assert.deepEqual(rest, ['a', 'c', 'b']);
});

test('a session dropped on itself stays exactly where it was', () => {
  const ids = ['a', 'b', 'c'];
  for (const before of [true, false]) {
    const at = dropIndex(ids, 'b', 'b', before);
    const rest = ids.filter((x) => x !== 'b');
    rest.splice(at, 0, 'b');
    assert.deepEqual(rest, ['a', 'b', 'c'], `before=${before}`);
  }
});

// ------------------------------------------------------------- moving a folder

test('a folder moves to where it was dropped, and clamps rather than falling off', () => {
  const folders = [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }];
  const ids = (list) => list.map((f) => f.id);
  assert.deepEqual(ids(moveFolder(folders, 'f3', 0)), ['f3', 'f1', 'f2']);
  assert.deepEqual(ids(moveFolder(folders, 'f1', 2)), ['f2', 'f3', 'f1']);
  assert.deepEqual(ids(moveFolder(folders, 'f1', 99)), ['f2', 'f3', 'f1'], 'past the end is the end');
  assert.deepEqual(ids(moveFolder(folders, 'f3', -5)), ['f3', 'f1', 'f2'], 'and past the start is the start');
  assert.deepEqual(ids(moveFolder(folders, 'f2', 1)), ids(folders), 'where it already is changes nothing');
  assert.deepEqual(ids(moveFolder(folders, 'nobody', 0)), ids(folders));
  assert.notEqual(moveFolder(folders, 'f1', 2), folders, 'and the original list is never mutated');
});

// ------------------------------------------------------ a drop that changes nothing

test('a drag that ends where it started writes nothing', () => {
  // Not politeness: writing the same value again publishes three lists and
  // redraws the panel, for a drag that did not move anything.
  const folders = [
    { id: 'folder:1', name: 'One', sessionIds: ['a', 'b'] },
    { id: 'folder:2', name: 'Two', sessionIds: [] },
  ];
  assert.equal(isNoopPlace(folders, 'a', 'folder:1', 0), true, 'same folder, same slot');
  assert.equal(isNoopPlace(folders, 'a', 'folder:1', 1), false, 'same folder, another slot');
  assert.equal(isNoopPlace(folders, 'a', 'folder:2', 0), false, 'another folder');
  assert.equal(isNoopPlace(folders, 'a', null, null), false, 'out of a folder is a change');
  assert.equal(isNoopPlace(folders, 'loose', null, null), true, 'and loose to loose is not');
});

// ------------------------------------------------------------------ the styles

const CSS = fs
  .readFileSync(path.join(RENDERER, 'styles.css'), 'utf8')
  // The Windows runner checks out CRLF, and a regex written for one newline does
  // not match the other.
  .replace(/\r\n/g, '\n');

const ruleFor = (selector) => {
  const at = CSS.indexOf(`\n${selector} {`);
  assert.ok(at > 0, `${selector} is in the stylesheet`);
  return CSS.slice(at, CSS.indexOf('\n}', at));
};

test('a folder folds the same way a category does', () => {
  // Reused, not reimplemented. `.sb-body` is unscoped so a folder inherits the
  // shut state — the 0fr grid track and `visibility: hidden` — which is what
  // makes a shut folder's rows genuinely leave the tab order rather than merely
  // being invisible.
  const base = ruleFor('.sb-body');
  assert.match(base, /grid-template-rows:\s*0fr/, 'the shut state is on the unscoped rule');
  assert.match(base, /visibility:\s*hidden/);
  const open = ruleFor('.sb-folder.open > .sb-body');
  assert.match(open, /grid-template-rows:\s*1fr/);
  assert.match(open, /visibility:\s*visible/);
  assert.doesNotMatch(open, /display:\s*none/, 'a fold, not a switch');
});

test('the category fold is left alone', () => {
  // test/layout.test.js finds this rule by its exact text. A folder is not a
  // category, so it gets a sibling rule rather than a widened selector.
  assert.ok(CSS.includes('\n.sb-section.open > .sb-body {'), 'still there, still exactly this');
});

test('a folder head is not a second sticky row', () => {
  // `.sb-head` is sticky at z-index 1. A sticky row nested inside it would sit
  // on top of the rows it is meant to be heading.
  assert.match(ruleFor('.sb-head'), /position:\s*sticky/, 'the category head still is');
  assert.doesNotMatch(ruleFor('.folder-head'), /position:\s*sticky/);
});

test('dropping into a folder is a region, and between rows is an edge', () => {
  // Never draw an insertion point where the order is not the user's to set. A
  // drop onto a folder appends; a drop between two rows lands between them.
  const into = ruleFor('.sb-folder.drop-into > .folder-head');
  assert.doesNotMatch(into, /inset 0 -?2px 0/, 'no caret on a drop that appends');
  assert.match(ruleFor('.sb-folder.drop-before > .folder-head'), /inset 0 2px 0/);
  assert.match(ruleFor('.peer.session.drop-after'), /inset 0 -2px 0/);
  const loose = ruleFor('.loose-sessions.drop-out');
  assert.doesNotMatch(loose, /inset 0 -?2px 0/, 'the loose list sorts itself — it has no positions');
});

test('renaming a folder does not make the row jump', () => {
  // The rule SessionTitle already follows: both states share a height and a left
  // edge, so the row is the same shape whether it is being read or typed into.
  const shared = ruleFor('.folder-name,\n.folder-name-input');
  assert.match(shared, /height:\s*20px/);
  assert.match(shared, /line-height:\s*20px/);
  assert.match(shared, /padding:\s*0/);
});

test('a session row can be dragged without selecting its text', () => {
  assert.match(ruleFor('.peer.session'), /user-select:\s*none/);
});

test('the move-to-folder menu escapes the header rather than being clipped by it', () => {
  const menu = ruleFor('.folder-menu');
  assert.match(menu, /position:\s*absolute/);
  assert.match(menu, /right:\s*0/, 'it hangs off the right edge, where its button is');
  assert.match(menu, /z-index:\s*20/);
  assert.match(ruleFor('.folder-picker'), /position:\s*relative/, 'anchored to its own button');
  // The trap this is guarding: `.chat-header .sub` clips to one line, and the
  // session subtitle has to undo it for the agent picker. None of the boxes this
  // menu actually hangs inside may start doing the same.
  for (const selector of ['.chat-header', '.chat-actions', '.chat-wrap']) {
    assert.doesNotMatch(ruleFor(selector), /overflow:\s*hidden/, `${selector} must not clip the menu`);
  }
});
