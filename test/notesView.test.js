'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The notes view, and the one thing it must never do.
//
// Saving is debounced, which means that at any moment there is writing in the
// field that is not yet on disk. Every way out of the editor therefore has to
// flush before it goes: closing, switching notes, deleting, and the panel being
// taken away by a call. A missed flush would not fail loudly — it would lose
// the last sentence somebody typed, and only sometimes.
//
// So this drives the real component with real timers through a hand-rolled
// renderer, and asks what reached the save callback and when. The list-and-
// editor arrangement is checked off the static markup beside it.

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const esbuild = require('esbuild');
  const { code } = esbuild.transformSync(fs.readFileSync(file, 'utf8'), {
    loader: 'jsx',
    format: 'cjs',
  });
  const mod = { exports: {} };
  cache.set(file, mod.exports);
  new Function('module', 'exports', 'require', code)(mod, mod.exports, (id) => {
    if (id === 'react') return React;
    if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id));
    return require(id);
  });
  cache.set(file, mod.exports);
  return mod.exports;
}

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
//
// react-dom/server renders once and cannot be typed into. What the flushing
// needs is a mounted component whose effects and callbacks actually run, so the
// component is driven through a minimal hook runtime: it is called like the
// function it is, with useState/useRef/useEffect/useCallback backed by real
// storage, and re-called when a setter moves something.

function mount(Component, props) {
  const cells = [];
  let i = 0;
  let effects = [];
  const cleanups = [];
  let queued = false;
  let tree = null;

  const React_ = {
    useState(initial) {
      const at = i++;
      if (!(at in cells)) cells[at] = typeof initial === 'function' ? initial() : initial;
      const set = (next) => {
        const value = typeof next === 'function' ? next(cells[at]) : next;
        if (Object.is(value, cells[at])) return;
        cells[at] = value;
        render();
      };
      return [cells[at], set];
    },
    useRef(initial) {
      const at = i++;
      if (!(at in cells)) cells[at] = { current: initial };
      return cells[at];
    },
    useCallback(fn) {
      // Deliberately not memoised: what is being driven here is behaviour, and
      // a stale closure kept for identity's sake would be the bug rather than
      // the thing under test.
      i += 1;
      return fn;
    },
    useEffect(fn, deps) {
      const at = i++;
      const prev = cells[at];
      const changed = !prev || !deps || deps.some((d, k) => !Object.is(d, prev.deps[k]));
      cells[at] = { deps };
      if (changed) effects.push({ at, fn });
    },
  };

  function render() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      i = 0;
      effects = [];
      const original = { ...React };
      Object.assign(React, React_);
      try {
        tree = Component(props);
      } finally {
        Object.assign(React, original);
      }
      for (const e of effects) {
        const undo = e.fn();
        if (typeof undo === 'function') cleanups.push(undo);
      }
    });
  }

  // The first pass is synchronous, so a caller can reach into the tree at once.
  i = 0;
  const original = { ...React };
  Object.assign(React, React_);
  try {
    tree = Component(props);
  } finally {
    Object.assign(React, original);
  }
  for (const e of effects) {
    const undo = e.fn();
    if (typeof undo === 'function') cleanups.push(undo);
  }

  const settle = () => new Promise((r) => setTimeout(r, 0));
  return {
    get tree() {
      return tree;
    },
    settle,
    unmount: () => {
      for (const undo of cleanups.splice(0)) undo();
    },
  };
}

// Walks the rendered tree for the first element matching a predicate.
function find(node, pick) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, pick);
      if (hit) return hit;
    }
    return null;
  }
  if (pick(node)) return node;
  return find(node.props && node.props.children, pick);
}

const byClass = (name) => (n) =>
  n.props &&
  String(n.props.className || '')
    .split(' ')
    .includes(name);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
