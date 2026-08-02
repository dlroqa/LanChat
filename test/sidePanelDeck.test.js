'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The right column's two floors, rendered from the real component.
//
// What is pinned here is the part of the feature that is a promise rather than a
// decision: the title names the floor showing, the dictation card is outside the
// deck so a pull can never take push-to-talk away, every kind of conversation
// goes behind the same title and grip, and the shortcut stays modifier-gated so
// it does not start taking arrow keys from the composer.

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// Same loader as dictateCard.test.js: the real files, transformed the way vite
// would, so what is asserted is what the app mounts rather than a fixture of it.
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

const SidePanelDeck = load(path.join(SRC, 'components', 'SidePanelDeck.jsx')).default;
const ConnectionPanel = load(path.join(SRC, 'components', 'ConnectionPanel.jsx')).default;

const readable = (html) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

function deck(props = {}) {
  return readable(
    renderToStaticMarkup(
      React.createElement(SidePanelDeck, {
        up: false,
        onUp: () => {},
        dictation: React.createElement('div', { className: 'ptt-bar' }, 'Tap to dictate'),
        activity: React.createElement('div', { className: 'conn-panel' }, 'the activity panel'),
        ...props,
      })
    )
  );
}

function panelFor(peer, extra = {}) {
  return React.createElement(ConnectionPanel, {
    peer,
    stats: null,
    agentStatus: null,
    awaiting: false,
    typing: false,
    streaming: false,
    commits: 0,
    ...extra,
  });
}

test('the title names the floor showing', () => {
  assert.ok(deck().includes('>Activity Panel<'), 'down, the column is the activity panel');
  assert.ok(deck({ up: true }).includes('>Task Bar<'), 'up, it is the task bar');
});

test('both floors are always mounted, and only one of them is showing', () => {
  const down = deck();
  assert.ok(down.includes('panel-face-activity'), 'the activity face');
  assert.ok(down.includes('panel-face-tasks'), 'and the task face, parked below it');
  // The parked floor keeps rendering: pulling it into view must not be the moment
  // its contents are built, or the panel would arrive empty and fill in after.
  assert.ok(down.includes('the activity panel'), 'the activity face holds what it was given');
  assert.ok(down.includes('Nothing running'), 'and the task face its empty state');

  // Which one is showing is a class on the deck, not a swap of the tree.
  assert.ok(down.includes('class="panel-deck"'), 'down is the deck on its own');
  assert.ok(deck({ up: true }).includes('class="panel-deck up"'), 'up is a class on it');
});

test('the parked floor is hidden from the reader as well as from the eye', () => {
  assert.match(
    deck(),
    /panel-deck-face panel-face-tasks" aria-hidden="true"/,
    'the task floor while it is parked'
  );
  assert.match(
    deck({ up: true }),
    /panel-deck-face panel-face-activity" aria-hidden="true"/,
    'and the activity floor once it is'
  );
});

test('the dictation card sits outside the deck, above it', () => {
  const html = deck();
  const card = html.indexOf('ptt-bar');
  const start = html.indexOf('panel-deck');
  assert.ok(card !== -1 && start !== -1 && card < start, 'the card is rendered before the deck');
  // The one thing the slider must never do: a pull cannot take the microphone
  // away, so the card is in both states and in neither face.
  assert.ok(deck({ up: true }).includes('ptt-bar'), 'and is still there with the task bar up');
});

test('with nothing selected the column is still titled and still has its grip', () => {
  // PttBar renders nothing without a peer. The panel would be headerless if the
  // title and the grip lived with the card rather than beside it.
  const html = deck({ dictation: null });
  assert.ok(html.includes('Activity Panel'), 'the title');
  assert.ok(html.includes('panel-grip'), 'the grip');
});

test('sessions, agents and people all go behind the same title and grip', () => {
  const kinds = [
    [{ id: 'session:1', kind: 'session', name: 'New Session' }, 'No agent yet'],
    [{ id: 'agent:1', kind: 'agent', name: 'Tessie', online: true }, 'Via'],
    [{ id: 'peer:1', name: 'Ada', online: true }, 'Latency'],
    [null, 'No conversation selected'],
  ];

  for (const [peer, mark] of kinds) {
    const html = deck({ activity: panelFor(peer) });
    const kind = peer ? peer.kind || 'person' : 'nothing selected';
    assert.ok(html.includes(mark), `${kind} keeps its own body`);
    assert.ok(html.includes('Activity Panel'), `${kind} is under the title`);
    assert.ok(html.includes('panel-grip'), `${kind} has the grip`);
    // And the floor it is on can be pulled away without taking the card with it.
    assert.ok(deck({ up: true, activity: panelFor(peer) }).includes('Task Bar'));
  }
});

test('the grip says what it does, in words and in keys', () => {
  const down = deck();
  assert.ok(down.includes('aria-expanded="false"'), 'shut');
  assert.ok(down.includes('Task Bar — '), 'the label names where a pull would go');
  assert.ok(/<kbd>[^<]+<\/kbd><kbd>↑<\/kbd>/.test(down), 'and the hint the key that gets there');

  const up = deck({ up: true });
  assert.ok(up.includes('aria-expanded="true"'), 'open');
  assert.ok(/<kbd>[^<]+<\/kbd><kbd>↓<\/kbd>/.test(up), 'the hint turns around with the state');

  // The hint repeats the button's own label, so it is decoration to a reader.
  assert.match(down, /class="panel-grip-keys" aria-hidden="true"/);
});

// ---- what the component must keep being ------------------------------------
// These read the sources rather than the render: they are the guards against a
// later edit quietly undoing a decision the render cannot show.

const deckSrc = fs.readFileSync(path.join(SRC, 'components', 'SidePanelDeck.jsx'), 'utf8');
const appSrc = fs.readFileSync(path.join(SRC, 'App.jsx'), 'utf8');
const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');

test('the shortcut stays modifier-gated', () => {
  // Plain arrows belong to the composer's mention menu, the search results and
  // the sidebar grips, none of which check modifiers. A downgrade here would
  // start stealing keys from whichever of them had focus.
  assert.match(deckSrc, /metaKey/);
  assert.match(deckSrc, /ctrlKey/);
  const guard = deckSrc.slice(deckSrc.indexOf('const onKey'), deckSrc.indexOf('window.addEventListener'));
  assert.ok(guard.includes('ArrowUp') && guard.includes('metaKey'), 'both in the same guard');
  assert.ok(guard.includes('offsetParent'), 'and it does nothing while the panel is not on screen');
});

test("the view is App state, not the deck's own", () => {
  // A call unmounts this panel. State held inside it would be lost across one,
  // and could be reset by a re-render on selection — the two things the feature
  // promises will not happen.
  assert.ok(!deckSrc.includes('useState'), 'the deck holds no copy of the view');
  assert.match(appSrc, /const \[taskBar, setTaskBar\] = useState\(false\)/);
  assert.match(appSrc, /up=\{taskBar\}/);
  assert.match(appSrc, /onUp=\{setTaskBar\}/);
});

test('the floors move on transform, and say so under reduced motion', () => {
  for (const sel of ['.panel-deck ', '.panel-deck-face ', '.panel-grip ', '.panel-grip-keys ']) {
    assert.ok(css.includes(`\n${sel}{`), `${sel.trim()} is styled`);
  }
  const face = css.slice(css.indexOf('.panel-deck-face {'), css.indexOf('.panel-grip {'));
  assert.ok(face.includes('transform: translateY('), 'the faces travel on transform');
  assert.ok(!/transition:[^;]*\b(height|top|width)\b/.test(face), 'and never animate layout');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n\s*\.panel-deck-face/);

  // One duration for both floors in each direction. Two would tear them apart
  // mid-slide, which is the one seam the pair cannot have.
  assert.match(face, /transition:\s*\n?\s*transform 160ms ease-in/, 'coming back');
  const going = css.slice(css.indexOf('.panel-deck.up .panel-deck-face {'));
  assert.match(going, /^[^}]*transform 220ms ease-out/, 'and going up, longer, on one curve');
  // The name arrives with the floor it names rather than swapping in place.
  assert.match(css, /@keyframes panel-title-in/);
  assert.match(css.slice(css.indexOf('.panel-title {')), /^[^}]*animation: panel-title-in/);
});

test('the narrow-window block is still the last thing in the sheet', () => {
  // A media query adds no specificity, so anything after it wins over it.
  const narrow = css.lastIndexOf('@media (max-width: 980px)');
  assert.ok(narrow !== -1, 'the block is there');
  assert.ok(css.indexOf('.panel-deck {') < narrow, 'and the new block is above it');
  assert.ok(!css.slice(narrow).includes('\n@media'), 'nothing follows it');
});

// ---- in a browser -----------------------------------------------------------
// The markup above says what is rendered. Where the two floors come to rest,
// whether the card above them holds still while they move, and whether a drag
// of ten pixels is ignored while one of sixty is not, are questions about a
// mounted component in a laid-out window — so they are asked in one.
//
// One run, shared: two browser launches and about ten seconds.

let browserRun = null;
function driven() {
  const { runSidePanelHarness } = require('../scripts/side-panel-harness.js');
  browserRun ||= runSidePanelHarness();
  return browserRun;
}

// Chromium is not always present. Say so rather than reporting a pass that never
// happened — everything above still runs.
function skipped(result) {
  if (!result.skipped) return false;
  console.log(`# skipped browser checks: ${result.skipped}`);
  return true;
}

test('driven in a browser: the floors come to rest one panel height apart', async () => {
  const r = await driven();
  if (skipped(r)) return;

  assert.equal(r.overflow, 'hidden', 'the deck clips what is parked outside it');
  assert.equal(r.resting.travel.activity, r.deckHeight, 'the activity floor travels one height');
  assert.equal(r.resting.travel.tasks, r.deckHeight, 'and the task floor the same one');
  assert.equal(r.resting.up.activity.shift, -r.deckHeight, 'up, the activity floor is above');
  assert.equal(r.resting.up.tasks.shift, 0, 'and the task floor is in view');
  assert.equal(r.resting.down.tasks.shift, r.deckHeight, 'down, the task floor is below');
  assert.equal(r.resting.down.activity.shift, 0, 'and the activity floor is in view');

  // Parked is hidden, in both senses.
  assert.equal(r.resting.up.activity.visibility, 'hidden');
  assert.equal(r.resting.down.tasks.visibility, 'hidden');
});

test('driven in a browser: the dictation card does not move when the floors do', async () => {
  const r = await driven();
  if (skipped(r)) return;

  assert.deepEqual(r.resting.cardUp, r.resting.cardDown, 'same top, same height, both floors');
  assert.deepEqual(r.steps.cardAtRest, r.steps.cardAfterUp, 'and across the shortcut too');
});

test('driven in a browser: the shortcut reaches it, a plain arrow does not', async () => {
  const r = await driven();
  if (skipped(r)) return;

  assert.equal(r.steps.afterShortcutUp.title, 'Task Bar');
  assert.equal(r.steps.afterShortcutDown.title, 'Activity Panel');
  // Pressed with a draft in the composer, focused: the modifier is what keeps
  // this clear of the message being typed.
  assert.equal(r.steps.draftAfterShortcut, 'half a sentence', 'the draft is untouched');
  assert.ok(r.steps.plainArrowIgnored, 'a bare arrow belongs to whatever has focus');
  // And it does nothing at a width where the column is not on screen at all.
  assert.equal(r.narrow.panelDisplay, 'none');
  assert.equal(r.narrow.stateAfterShortcut, false, 'no floor moved behind the media query');
});

test('driven in a browser: a nudge is not a pull', async () => {
  const r = await driven();
  if (skipped(r)) return;

  assert.equal(r.steps.afterNudge, 'Activity Panel', 'ten pixels is a slipped click');
  assert.equal(r.steps.afterPullUp, 'Task Bar', 'sixty is a pull');
  assert.equal(r.steps.afterPullDown, 'Activity Panel', 'and it comes back the same way');
  assert.equal(r.steps.afterClick, 'Task Bar', 'a click is the gesture without the travel');
  assert.equal(r.steps.afterSecondClick, 'Activity Panel');
});

test('driven in a browser: a half-finished pull shows the floor it is pulling in', async () => {
  const r = await driven();
  if (skipped(r)) return;

  // The seam this guards: the incoming floor is still the parked one until the
  // finger lifts, and while it was `visibility: hidden` a drag opened an empty
  // strip that only filled in once the gesture was let go of.
  for (const [way, m] of [
    ['up', r.steps.midPullUp],
    ['down', r.steps.midPullDown],
  ]) {
    assert.equal(m.activity.visibility, 'visible', `pulling ${way}: the activity floor paints`);
    assert.equal(m.tasks.visibility, 'visible', `pulling ${way}: the task floor paints too`);
    // Under the finger, and exactly one panel apart: no gap opens between them.
    assert.equal(m.transition, '0s', `pulling ${way}: the deck tracks the pointer, untweened`);
    assert.equal(m.tasks.shift - m.activity.shift, r.deckHeight, `pulling ${way}: no seam`);
  }
  assert.equal(r.steps.midPullUp.pulled, '-60px', 'and the offset is the distance dragged');
  assert.equal(r.steps.midPullDown.pulled, '60px');
});

test('driven in a browser: picking a conversation does not knock the task bar down', async () => {
  const r = await driven();
  if (skipped(r)) return;

  const sel = r.steps.selection;
  assert.equal(sel.startedOn, 'Task Bar');
  assert.equal(sel.afterPicking.title, 'Task Bar', 'the floor stays where it was put');
  // The one thing on this side that answers a selection: the pinned card, which
  // swaps from the session's dictate card to the person's radio card.
  assert.equal(sel.card, 'Tap to dictate');
  assert.match(sel.afterPicking.card, /Hold .* to talk/);
  assert.deepEqual(sel.afterPicking.cardBox, { top: 43, height: 76 }, 'in the same box');
  // And the floor underneath kept up, so pulling it back shows the conversation
  // now selected rather than the one selected when it went away.
  assert.ok(sel.afterPicking.activityHolds, 'the parked panel followed the selection');
  assert.equal(sel.afterComingBack.title, 'Activity Panel');
  assert.equal(sel.afterComingBack.showing, 'Ada');
});

test('driven in a browser: the hint appears without resizing anything', async () => {
  const r = await driven();
  if (skipped(r)) return;

  assert.equal(r.steps.hint.position, 'absolute');
  assert.equal(r.steps.hint.gripHeightAfter, r.steps.hint.gripHeightBefore, 'the bar keeps its height');
  assert.ok(r.steps.hint.deckHeightUnchanged, 'and the deck above it is not resized');
  assert.ok(r.steps.hint.text.includes('Task Bar'), 'it names where the pull would go');
  // The bar is a target, not a hairline.
  assert.ok(r.steps.gripBox.height >= 44, `grip is ${r.steps.gripBox.height}px tall`);
  assert.ok(!r.steps.bodyScrollsSideways, 'and nothing it adds pushes the window sideways');
});

test('driven in a browser: the small text it adds is readable on the panel', async () => {
  const r = await driven();
  if (skipped(r)) return;

  // 11.5px is small text, which needs 4.5:1.
  assert.ok(r.contrast.title >= 4.5, `title contrast ${r.contrast.title}:1`);
  assert.ok(r.contrast.hint >= 4.5, `hint contrast ${r.contrast.hint}:1`);
});
