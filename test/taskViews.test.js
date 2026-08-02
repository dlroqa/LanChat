'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The three views on the Task Bar floor, and the arithmetic for stepping
// between them.
//
// Two things reach for that arithmetic — the row of icons at the foot of the
// floor and the arrow keys — and if they ever disagreed about what comes after
// what, the panel would move one way when clicked and another when typed at.
// They agree because there is only one implementation, and this is it. Loaded
// with the `export` keywords stripped, the way test/sidebarSections.test.js
// loads its module.

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const { TASK_VIEWS, TASK_VIEW_IDS, DEFAULT_TASK_VIEW, taskViewName, normalizeTaskView, stepTaskView } =
  new Function(
    `${fs.readFileSync(path.join(SRC, 'lib', 'taskViews.js'), 'utf8').replace(/^export\s+/gm, '')}
     return { TASK_VIEWS, TASK_VIEW_IDS, DEFAULT_TASK_VIEW, taskViewName, normalizeTaskView, stepTaskView };`
  )();

test('the three views are the ones the panel draws, in the order it draws them', () => {
  assert.deepEqual(TASK_VIEW_IDS, ['notes', 'agent', 'schedule']);
  assert.deepEqual(
    TASK_VIEWS.map((v) => v.name),
    ['Notes', 'Agent Task', 'Scheduled Task']
  );
  assert.equal(taskViewName('schedule'), 'Scheduled Task');
  assert.equal(taskViewName('nonsense'), '');
  assert.equal(DEFAULT_TASK_VIEW, 'notes');
  assert.ok(TASK_VIEW_IDS.includes(DEFAULT_TASK_VIEW), 'the default is one of them');
});

test('an unknown view falls back rather than rendering a floor with no name', () => {
  for (const junk of [null, undefined, '', 'notes ', 'Notes', 'nonsense', 0, {}]) {
    assert.equal(normalizeTaskView(junk), DEFAULT_TASK_VIEW, `${JSON.stringify(junk)} is not a view`);
  }
  for (const id of TASK_VIEW_IDS) assert.equal(normalizeTaskView(id), id, `${id} is left alone`);
});

test('stepping wraps at both ends', () => {
  assert.equal(stepTaskView('notes', 1), 'agent');
  assert.equal(stepTaskView('agent', 1), 'schedule');
  // Right off the last one comes back to the first: three views are a row you
  // cycle, and an arrow that did nothing would read as a key that had stopped.
  assert.equal(stepTaskView('schedule', 1), 'notes');

  assert.equal(stepTaskView('schedule', -1), 'agent');
  assert.equal(stepTaskView('agent', -1), 'notes');
  assert.equal(stepTaskView('notes', -1), 'schedule');
});

test('stepping is total: it always answers with a view', () => {
  // Whatever it is handed, and however far, the answer is somewhere the panel
  // can render — the fallback and the wrap in the same expression.
  assert.equal(stepTaskView('nonsense', 1), 'agent', 'junk steps on from the default');
  assert.equal(stepTaskView('notes', 0), 'notes');
  assert.equal(stepTaskView('notes', 3), 'notes', 'a full turn');
  assert.equal(stepTaskView('notes', 4), 'agent');
  assert.equal(stepTaskView('notes', -4), 'schedule', 'and backwards past the start');
  for (const delta of [null, undefined, NaN, 'x']) {
    assert.ok(TASK_VIEW_IDS.includes(stepTaskView('agent', delta)), `${delta} still lands on a view`);
  }
});
