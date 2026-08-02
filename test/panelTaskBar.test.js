'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The Task Bar floor: a name at the top, a body, three views along the bottom.
//
// What is pinned here is the part a reader depends on. The buttons are icons
// with no words beside them, so their labels are not decoration — they are the
// only name each button has, and an unlabelled one is a button nobody can ask
// for. And exactly one of the three is the selected tab at any moment, because
// the heading above claims to name the view showing: two selected, or none,
// would make that heading a guess.

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// The same loader sidePanelDeck.test.js uses: the real files, transformed the
// way vite would, so what is asserted is what the app mounts.
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

const TaskBarFace = load(path.join(SRC, 'components', 'TaskBarFace.jsx')).default;
const EmptyState = load(path.join(SRC, 'components', 'EmptyState.jsx')).default;

const readable = (html) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

function face(props = {}) {
  return readable(
    renderToStaticMarkup(
      React.createElement(
        TaskBarFace,
        { view: 'notes', onView: () => {}, ...props },
        React.createElement('div', null, 'the body of the view')
      )
    )
  );
}

const NAMES = { notes: 'Notes', agent: 'Agent Task', schedule: 'Scheduled Task' };

test('the heading names the view showing', () => {
  for (const [view, name] of Object.entries(NAMES)) {
    assert.match(face({ view }), new RegExp(`class="task-view-title"[^>]*>${name}<`), name);
  }
  // A view id that means nothing still leaves a floor with a name on it.
  assert.match(face({ view: 'nonsense' }), /class="task-view-title"[^>]*>Notes</);
});

test('the body it is given is the body it shows', () => {
  assert.ok(face().includes('the body of the view'));
  assert.match(face(), /class="task-view-body" role="tabpanel" aria-labelledby="task-view-title"/);
});

test('three views, each with a name a reader can reach', () => {
  const html = face();
  assert.match(html, /class="task-view-menu" role="tablist"/);
  const tabs = html.match(/role="tab"/g) || [];
  assert.equal(tabs.length, 3, 'three of them');
  for (const name of Object.values(NAMES)) {
    // Icon-only: the label is the button's only name, and the title says the
    // same word to a mouse that cannot read an aria-label.
    assert.ok(html.includes(`aria-label="${name}"`), `${name} is labelled`);
    assert.ok(html.includes(`title="${name}"`), `${name} has a tooltip`);
  }
});

test('exactly one view is selected, and it is the one the heading names', () => {
  for (const view of Object.keys(NAMES)) {
    const html = face({ view });
    assert.equal((html.match(/aria-selected="true"/g) || []).length, 1, `${view}: one selected`);
    assert.equal((html.match(/aria-selected="false"/g) || []).length, 2, `${view}: two not`);
    // The selected one is the one wearing the toggle class, and the one that
    // holds the row's single tab stop.
    const selected = html.match(/<button[^>]*aria-selected="true"[^>]*>/)[0];
    assert.ok(selected.includes(`aria-label="${NAMES[view]}"`), `${view}: the right one`);
    assert.ok(selected.includes('icon-btn on'), `${view}: says so in the class`);
    assert.ok(selected.includes('tabindex="0"'), `${view}: and holds the tab stop`);
    assert.equal((html.match(/tabindex="-1"/g) || []).length, 2, `${view}: the others are passed over`);
  }
});

test('the empty state is one component now, and says its piece without a title twice', () => {
  const html = readable(
    renderToStaticMarkup(React.createElement(EmptyState, { title: 'No notes yet' }, 'Write one.'))
  );
  assert.match(html, /class="panel-empty"/);
  assert.match(html, /class="pulse-ring" aria-hidden="true"/);
  assert.ok(html.includes('<h4>No notes yet</h4>'));
  assert.ok(html.includes('<p>Write one.</p>'));

  // Beside a list of real rows the ring is a distraction with nothing in it, so
  // it can be left off — and then nothing of it is rendered at all.
  const bare = readable(
    renderToStaticMarkup(React.createElement(EmptyState, { title: 'Quiet', ring: false }))
  );
  assert.ok(!bare.includes('pulse-ring'), 'no ring');
  assert.ok(!bare.includes('<p>'), 'and no empty paragraph where the sentence would go');
  assert.ok(bare.includes('<h4>Quiet</h4>'));
});
