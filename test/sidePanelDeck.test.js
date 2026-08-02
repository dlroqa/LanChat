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
        view: 'notes',
        onView: () => {},
        dictation: React.createElement('div', { className: 'ptt-bar' }, 'Tap to dictate'),
        activity: React.createElement('div', { className: 'conn-panel' }, 'the activity panel'),
        tasks: React.createElement('div', { className: 'task-body' }, 'the task bar view'),
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

test('the task floor carries a second name, for the view rather than the floor', () => {
  // Two headings, not one that changes its mind: h2 names the floor you are
  // standing on, h3 names what is on it. The column's own title must go on
  // saying Task Bar whichever of the three views is up.
  for (const [view, name] of [
    ['notes', 'Notes'],
    ['agent', 'Agent Task'],
    ['schedule', 'Scheduled Task'],
  ]) {
    const html = deck({ up: true, view });
    assert.ok(html.includes('>Task Bar<'), `${view}: the column is still the Task Bar`);
    assert.match(
      html,
      new RegExp(`class="task-view-title"[^>]*>${name}<`),
      `${view}: and the floor is ${name}`
    );
    // The heading and the selected button are one answer given twice, so they
    // cannot disagree about which view is showing.
    assert.equal((html.match(/aria-selected="true"/g) || []).length, 1, `${view}: one view selected`);
  }
});

test('both floors are always mounted, and only one of them is showing', () => {
  const down = deck();
  assert.ok(down.includes('panel-face-activity'), 'the activity face');
  assert.ok(down.includes('panel-face-tasks'), 'and the task face, parked below it');
  // The parked floor keeps rendering: pulling it into view must not be the moment
  // its contents are built, or the panel would arrive empty and fill in after.
  assert.ok(down.includes('the activity panel'), 'the activity face holds what it was given');
  assert.ok(down.includes('the task bar view'), 'and the task face what it was given too');

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

// Read with the line endings normalised. Git hands these files out with CRLF on
// Windows, where a pattern written around \n matches nothing and the assertion
// fails for a reason that has nothing to do with what it is asking about — which
// is exactly how it failed on the windows runner, and only there.
const source = (...where) => fs.readFileSync(path.join(SRC, ...where), 'utf8').replace(/\r\n/g, '\n');

const deckSrc = source('components', 'SidePanelDeck.jsx');
const appSrc = source('App.jsx');
const css = source('styles.css');

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

test('the sideways keys are bare, and gated instead', () => {
  // Left and right step the Task Bar's three views with no modifier held. That
  // is affordable only because every other arrow handler in this app — the
  // composer's mention menu, the search results, the sidebar grips — takes up
  // and down, so the one thing left and right can be taken from is a caret.
  // Both gates therefore have to be here, in the same handler as everything
  // else: the slice below runs from the first `const onKey` to the first
  // listener, and a second handler bolted on underneath would satisfy every
  // assertion above while leaving these keys ungated.
  const guard = deckSrc.slice(deckSrc.indexOf('const onKey'), deckSrc.indexOf('window.addEventListener'));
  assert.ok(guard.includes('ArrowLeft') && guard.includes('ArrowRight'), 'sideways, in the same guard');
  assert.ok(guard.includes('editing(e.target)'), 'and never taken from a caret');
  assert.ok(guard.includes('if (!up) return'), 'nor answered while the other floor is the one showing');
  // A held modifier is somebody else's shortcut, not a slower version of this
  // one — ⌘← is the start of the line, ⌥← the previous word.
  assert.match(guard, /if \(e\.metaKey \|\| e\.ctrlKey \|\| e\.altKey \|\| e\.shiftKey\) return;/);
  assert.match(deckSrc, /const editing = \(el\) =>/);
  assert.match(deckSrc, /input, textarea, select, \[contenteditable="true"\]/);
});

test("the view is App state, not the deck's own", () => {
  // A call unmounts this panel. State held inside it would be lost across one,
  // and could be reset by a re-render on selection — the two things the feature
  // promises will not happen.
  assert.ok(!deckSrc.includes('useState'), 'the deck holds no copy of the view');
  assert.match(appSrc, /const \[taskBar, setTaskBar\] = useState\(false\)/);
  assert.match(appSrc, /up=\{taskBar\}/);
  assert.match(appSrc, /onUp=\{setTaskBar\}/);

  // Which of the three views is showing is the same kind of thing one floor
  // down, and is held in the same place for the same reasons.
  assert.match(appSrc, /const \[taskView, setTaskView\] = useState\(DEFAULT_TASK_VIEW\)/);
  assert.match(appSrc, /view=\{taskView\}/);
  assert.match(appSrc, /onView=\{setTaskView\}/);
  // And not saved: the floor is not, and a view remembered under a floor nobody
  // is standing on is half a position restored.
  assert.ok(!/taskView/.test(source('..', 'main', 'config.js')), 'no such setting in the config defaults');
});

test('the floors move on transform, and say so under reduced motion', () => {
  for (const sel of [
    '.panel-deck ',
    '.panel-deck-face ',
    '.panel-grip ',
    '.panel-grip-keys ',
    '.task-view ',
    '.task-view-title ',
    '.task-view-body ',
    '.task-view-menu ',
  ]) {
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
  // And the floor's own name arrives with the view it names, the same way.
  assert.match(css.slice(css.indexOf('.task-view-title {')), /^[^}]*animation: panel-title-in/);
  const rmAt = css.indexOf('@media (prefers-reduced-motion: reduce) {\n  .panel-deck-face');
  const reduced = css.slice(rmAt, css.indexOf('\n}\n', rmAt));
  assert.ok(reduced.includes('.task-view-title'), 'and holds still where the other one does');

  // Only the body of the floor scrolls. Overflow on the floor itself would let
  // a long list carry the heading and the three buttons off the ends of it.
  const floor = css.slice(css.indexOf('.task-view {'), css.indexOf('.task-view-menu {'));
  assert.ok(!/^\s*overflow/m.test(css.slice(css.indexOf('.task-view {'), css.indexOf('.task-view-title {'))));
  assert.match(floor.slice(floor.indexOf('.task-view-body {')), /^[^}]*overflow-y: auto/);
  // Nothing new animates layout either, for the reason the faces do not.
  assert.ok(!/transition:[^;]*\b(height|top|width)\b/.test(floor));
});

test('the narrow-window block is still the last thing in the sheet', () => {
  // A media query adds no specificity, so anything after it wins over it.
  const narrow = css.lastIndexOf('@media (max-width: 980px)');
  assert.ok(narrow !== -1, 'the block is there');
  assert.ok(css.indexOf('.panel-deck {') < narrow, 'and the new block is above it');
  assert.ok(css.indexOf('.task-view-menu {') < narrow, 'the task floor too');
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
  assert.equal(r.narrow.viewAfterShortcut, 'notes', 'and no view either');
});

test('driven in a browser: bare left and right step the three views, and wrap', async () => {
  const r = await driven();
  if (skipped(r)) return;

  // Round one way and round the other, from Notes and back to it. Four presses
  // for three views, so the wrap is inside the reading rather than at its edge.
  assert.deepEqual(r.steps.cycleRight, ['Agent Task', 'Scheduled Task', 'Notes', 'Agent Task']);
  assert.deepEqual(r.steps.cycleLeft, ['Notes', 'Scheduled Task', 'Agent Task', 'Notes']);
  // The name and the body under it move together — a heading that stepped on
  // its own would look right and be a lie.
  assert.equal(r.steps.bodyWithTitle.title, 'Notes');
  assert.ok(r.steps.bodyWithTitle.body.includes('No notes yet'), 'the body is the one named');
});

test('driven in a browser: the sideways keys are not taken from a caret, or from the other floor', async () => {
  const r = await driven();
  if (skipped(r)) return;

  // Standing on the Activity Panel there is nothing sideways to reach.
  assert.equal(r.steps.acrossWhileDown.floor, 'Activity Panel');
  assert.equal(r.steps.acrossWhileDown.after, r.steps.acrossWhileDown.before, 'no view moved');

  // With the cursor in the composer the modifier pair still reaches the deck —
  // it always has — while the bare arrow beside it stays with the text.
  assert.equal(r.steps.acrossWhileTyping.floor, 'Task Bar', 'the modified pair still gets through');
  assert.equal(r.steps.acrossWhileTyping.after, r.steps.acrossWhileTyping.before, 'the bare one does not');
  assert.equal(r.steps.acrossWhileTyping.draft, 'half a sentence', 'and the draft is untouched');

  assert.equal(r.steps.backDown, 'Activity Panel', 'and the floor came back for the rest of the run');
});

test('driven in a browser: the floor keeps its chrome without taking the deck apart', async () => {
  const r = await driven();
  if (skipped(r)) return;

  // A heading and a row of buttons inside a face that is `inset: 0`: the face
  // is still exactly the deck, so the slide is still exactly one deck height.
  assert.deepEqual(r.resting.taskFace, r.resting.deckBox, 'the floor fills the deck');
  assert.equal(r.resting.travel.tasks, r.deckHeight, 'and travels the whole of it');
  // And nothing it adds reaches up past the deck into the pinned card.
  assert.deepEqual(r.steps.cardWithTaskChrome, r.steps.cardAtRest, 'the card is where it was');

  // The three parts of the floor stack with nothing between them and nothing
  // left over at either end: the floor is its heading, its body and its
  // buttons, and the body is whatever is left after the other two.
  assert.deepEqual(r.resting.chrome.gaps, { aboveTitle: 0, titleToBody: 0, bodyToMenu: 0, belowMenu: 0 });
  assert.ok(r.resting.chrome.body.height > 0, 'and there is a body to put a view in');

  // Only the body scrolls. On the floor itself, a long list would carry the
  // heading and the buttons off the ends of the one thing that has to stay put.
  assert.equal(r.resting.chrome.bodyOverflow, 'auto');
  assert.equal(r.resting.chrome.faceOverflow, 'visible', 'the floor itself never scrolls');
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
  // The floor's heading is the same size on the same background, so it answers
  // the same question rather than inheriting the answer.
  assert.equal(r.contrast.viewFontSize, r.contrast.fontSize, 'same size as the column title');
  assert.ok(r.contrast.view >= 4.5, `view title contrast ${r.contrast.view}:1`);
});
