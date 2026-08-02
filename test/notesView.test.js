'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { renderToStaticMarkup } = require('react-dom/server');
const React = require('react');
const { load, mount, find, byClass, wait } = require('../scripts/lib/reactDrive.js');

// The notes view, and the one thing it must never do.
//
// Saving is debounced, which means that at any moment there is writing in the
// field that is not yet on disk. Every way out of the editor therefore has to
// flush before it goes: closing, switching notes, deleting, losing focus, and
// being unmounted, which is what a call arriving does to this whole panel. A
// missed flush would not fail loudly — it would lose the last sentence somebody
// typed, and only sometimes.
//
// So the driven half below runs the real component with real timers and asks
// what reached the save callback and when. The arrangement of the list and the
// editor is checked off the static markup beside it.

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const NotesView = load(path.join(SRC, 'components', 'NotesView.jsx')).default;

const readable = (html) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

const NOTES = [
  { id: 'note:a', title: 'Tap washer', preview: 'The kitchen tap drips.', updatedAt: 1_760_000_000_000 },
  { id: 'note:b', title: 'Untitled note', preview: '', updatedAt: 1_759_000_000_000 },
];

function draw(props = {}) {
  return readable(
    renderToStaticMarkup(
      React.createElement(NotesView, {
        notes: NOTES,
        trash: [],
        onCreate: async () => null,
        onRead: async () => null,
        onSave: () => {},
        onDelete: () => {},
        onRestore: () => {},
        onPurge: () => {},
        ...props,
      })
    )
  );
}

test('the list shows what a row is recognisable by', () => {
  const html = draw();
  assert.ok(html.includes('2 notes'), 'how many there are');
  assert.ok(html.includes('Tap washer'), 'the title');
  assert.ok(html.includes('The kitchen tap drips.'), 'and the first line of the writing');
  // A note nothing has been typed into has no preview, and says so by falling
  // back to when it was last touched rather than showing an empty line.
  assert.ok(!html.includes('<div class="note-row-sub"></div>'), 'no blank sub-line');
  // Every destructive control is named, because it is an icon and the name is
  // the only thing it has.
  assert.ok(html.includes('aria-label="Move Tap washer to the Trash"'));
});

test('an empty list says which kind of empty it is', () => {
  assert.ok(draw({ notes: [] }).includes('No notes yet'));
  const trash = draw({ notes: [], trash: [] });
  assert.ok(!trash.includes('Nothing deleted'), 'the Trash is not what an empty list shows');
});

test('the Trash button is dead while the Trash is empty, and offered when it is not', () => {
  // Disabled rather than hidden: a button that vanishes when there is nothing
  // to do teaches nobody where it was.
  const trashButton = (html) => html.match(/<button[^>]*aria-label="Deleted notes"[^>]*>/)[0];
  assert.ok(trashButton(draw({ trash: [] })).includes('disabled'));
  const withTrash = draw({ trash: [{ id: 'note:c', title: 'Gone', deletedAt: 1_760_000_000_000 }] });
  assert.ok(!trashButton(withTrash).includes('disabled'), 'reachable once there is something in it');
});

// ---- driven, with real timers ------------------------------------------------

function editing(saves = [], note = { id: 'note:a', title: 'Tap washer', body: 'first line' }) {
  const view = mount(NotesView, {
    notes: NOTES,
    trash: [],
    onCreate: async () => null,
    onRead: async () => note,
    onSave: (id, patch) => saves.push({ id, ...patch }),
    onDelete: () => {},
    onRestore: () => {},
    onPurge: () => {},
  });
  return view;
}

async function open(view) {
  const row = find(view.tree, byClass('note-row-face'));
  await row.props.onClick();
  await view.settle();
}

test('driven: typing saves once it stops, and not on every letter', async () => {
  const saves = [];
  const view = editing(saves);
  await open(view);

  const body = find(view.tree, byClass('note-body'));
  assert.equal(body.props.value, 'first line', 'the editor opened on what was written');

  for (const text of ['first lines', 'first lines ', 'first lines a', 'first lines an', 'first lines and']) {
    find(view.tree, byClass('note-body')).props.onChange({ target: { value: text } });
    await view.settle();
    await wait(40);
  }
  assert.deepEqual(saves, [], 'nothing yet: this is one sentence being typed');

  await wait(700);
  assert.equal(saves.length, 1, 'one save for the lot of it');
  assert.equal(saves[0].body, 'first lines and', 'carrying the last letter typed');
  assert.ok(!saves[0].final, 'a pause is not a finish');
  view.unmount();
});

test('driven: every way out of the editor flushes what is in it first', async () => {
  // Closing.
  {
    const saves = [];
    const view = editing(saves);
    await open(view);
    find(view.tree, byClass('note-body')).props.onChange({ target: { value: 'unsaved words' } });
    await view.settle();
    find(view.tree, byClass('icon-btn')).props.onClick();
    await view.settle();
    assert.deepEqual(saves, [{ id: 'note:a', title: 'Tap washer', body: 'unsaved words', final: true }]);
    // And the flush cancelled the timer rather than racing it.
    await wait(700);
    assert.equal(saves.length, 1, 'the debounced save did not fire on top');
    assert.ok(find(view.tree, byClass('note-list')), 'and the list is back');
    view.unmount();
  }

  // Losing focus.
  {
    const saves = [];
    const view = editing(saves);
    await open(view);
    const body = find(view.tree, byClass('note-body'));
    body.props.onChange({ target: { value: 'half a thought' } });
    await view.settle();
    find(view.tree, byClass('note-body')).props.onBlur();
    assert.equal(saves.length, 1);
    assert.equal(saves[0].body, 'half a thought');
    assert.ok(saves[0].final);
    view.unmount();
  }

  // Being unmounted, which is what a call arriving does to this whole panel.
  {
    const saves = [];
    const view = editing(saves);
    await open(view);
    find(view.tree, byClass('note-body')).props.onChange({ target: { value: 'mid sentence' } });
    await view.settle();
    view.unmount();
    assert.equal(saves.length, 1, 'the panel going away is not a reason to lose it');
    assert.equal(saves[0].body, 'mid sentence');
    assert.ok(saves[0].final);
  }
});

test('driven: deleting the open note saves it before it goes, and closes the editor', async () => {
  const saves = [];
  const deleted = [];
  const view = mount(NotesView, {
    notes: NOTES,
    trash: [],
    onCreate: async () => null,
    onRead: async () => ({ id: 'note:a', title: 'Tap washer', body: 'first line' }),
    onSave: (id, patch) => saves.push({ id, ...patch }),
    onDelete: (id) => deleted.push(id),
    onRestore: () => {},
    onPurge: () => {},
  });
  await open(view);
  find(view.tree, byClass('note-body')).props.onChange({ target: { value: 'last words' } });
  await view.settle();

  find(view.tree, byClass('danger')).props.onClick();
  await view.settle();

  // The save lands before the delete: a write arriving afterwards would touch a
  // record already in the Trash and bring it back out with a timestamp nobody
  // could explain.
  assert.equal(saves.length, 1);
  assert.equal(saves[0].body, 'last words');
  assert.deepEqual(deleted, ['note:a']);
  assert.ok(find(view.tree, byClass('note-list')), 'and it does not sit in an editor for a deleted note');
  view.unmount();
});

test('driven: the title is saved the same way the body is', async () => {
  const saves = [];
  const view = editing(saves);
  await open(view);
  find(view.tree, byClass('note-title')).props.onChange({ target: { value: 'Washer size' } });
  await view.settle();
  await wait(700);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].title, 'Washer size');
  assert.equal(saves[0].body, 'first line', 'and carries the body it did not touch');
  view.unmount();
});
