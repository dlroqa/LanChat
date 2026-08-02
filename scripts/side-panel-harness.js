'use strict';

// Drives the right column's two floors in a real browser.
//
// Everything the deck promises is geometry or computed style: that the two faces
// travel together by exactly one panel height, that the dictation card above
// them does not move when they do, that the parked floor is taken out of the
// reading order once it has gone, that the shortcut and the drag both reach the
// other floor and a small nudge does not, and that showing the hover hint cannot
// change the height of the bar it sits in. None of that can be read off the
// stylesheet — the faces are positioned by a custom property resolved three
// selectors up — and a DOM stand-in would only measure our own guess.
//
// So this mounts the real component, inside the real grid, over a real
// connection panel, and does what a person would do: presses the shortcut, drags
// the bar, nudges it, and hovers it.
//
//   node scripts/side-panel-harness.js [outDir]

const fs = require('node:fs');
const path = require('node:path');
const { chromiumPath, render, withScratchDir } = require('./lib/chromium.js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer');

const RUN = { width: 1120, height: 740, budget: 9000, args: ['--hide-scrollbars'] };
// Below the 980px break the whole column is display: none. The shortcut must be
// a no-op there rather than moving something nobody can see.
const NARROW = { width: 900, height: 700, budget: 6000, args: ['--hide-scrollbars'] };

function entry() {
  return `
import React from 'react';
import { createRoot } from 'react-dom/client';
import SidePanelDeck from ${JSON.stringify(path.join(SRC, 'components', 'SidePanelDeck.jsx'))};
import ConnectionPanel from ${JSON.stringify(path.join(SRC, 'components', 'ConnectionPanel.jsx'))};
import PttBar from ${JSON.stringify(path.join(SRC, 'components', 'PttBar.jsx'))};
import EmptyState from ${JSON.stringify(path.join(SRC, 'components', 'EmptyState.jsx'))};
window.__lanchat = { React, createRoot, SidePanelDeck, ConnectionPanel, PttBar, EmptyState };
`;
}

function buildBundle(dir) {
  const esbuild = require('esbuild');
  const entryFile = path.join(dir, 'entry.jsx');
  const outFile = path.join(dir, 'bundle.js');
  fs.writeFileSync(entryFile, entry());
  esbuild.buildSync({
    entryPoints: [entryFile],
    bundle: true,
    outfile: outFile,
    format: 'iife',
    loader: { '.js': 'jsx' },
    define: { 'process.env.NODE_ENV': '"production"' },
    absWorkingDir: ROOT,
    nodePaths: [path.join(ROOT, 'node_modules')],
    logLevel: 'silent',
  });
  return fs.readFileSync(outFile, 'utf8');
}

// `leaveUp` decides which floor the screenshot at the end of the run catches.
function buildPage(dir, bundle, leaveUp) {
  const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${css}</style></head>
<body><div id="root"><div class="app">
  <div class="sidebar"></div>
  <div class="chat-wrap"><div class="chat"><div class="messages-wrap"></div>
    <div class="composer"><textarea id="draft"></textarea></div></div></div>
  <aside class="side-panel" id="panel"></aside>
</div></div>
<script>${bundle}</script>
<script>
const { React, createRoot, SidePanelDeck, ConnectionPanel, PttBar, EmptyState } = window.__lanchat;
const h = React.createElement;
const LEAVE_UP = ${leaveUp ? 'true' : 'false'};
// What App hands the floor: one body per view, resolved outside the deck.
const BODIES = {
  notes: h(EmptyState, { title: 'No notes yet' }, 'Anything you write here stays on this machine.'),
  agent: h(EmptyState, { title: 'No tasks yet' }, 'Give an agent a standing job and run it from here.'),
  schedule: h(EmptyState, { title: 'Nothing scheduled' }, 'Tasks set to run on their own will be listed here.'),
};

// Two conversations to pick between, as the left panel would. The session is the
// one in the report; the person is the one whose card is the radio rather than
// the dictate card, so a selection is visible in both halves of the column.
const SESSION = { id: 'session:1', kind: 'session', name: 'New Session' };
const PERSON = { id: 'peer:1', name: 'Ada', online: true };
const idle = { transmitting: false, connecting: false, talkers: [], inboundStreams: [] };

let peer = SESSION;
let up = false;
let view = 'notes';
const root = createRoot(document.getElementById('panel'));
const draw = () => new Promise((r) => {
  root.render(h(SidePanelDeck, {
    up,
    onUp: (next) => { up = next; draw(); },
    view,
    onView: (next) => { view = next; draw(); },
    tasks: BODIES[view],
    dictation: h(PttBar, {
      peer, state: idle, keyName: 'meta', customCode: null,
      // What App passes: the dictate card where dictation is what the gesture
      // does, the radio card where it is not.
      dictation: peer.kind === 'session'
        ? { phase: 'idle', threadId: null, startedAt: 0, error: null }
        : null,
      cliReady: true,
      onHoldStart: () => {}, onHoldEnd: () => {}, onDictateToggle: () => {},
    }),
    activity: h(ConnectionPanel, {
      peer, stats: null, agentStatus: null,
      awaiting: false, typing: false, streaming: false, commits: 2,
    }),
  }));
  setTimeout(r, 60);
});
const select = async (next) => { peer = next; await draw(); await wait(150); };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => document.querySelector(s);
const deck = () => $('.panel-deck');
const grip = () => $('.panel-grip');
const face = (which) => $('.panel-face-' + which);
const box = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), height: Math.round(r.height) }; };
// translateY out of the computed matrix, which is what the browser resolved the
// custom properties to — the number the eye actually gets.
const shift = (el) => {
  const t = getComputedStyle(el).transform;
  if (!t || t === 'none') return 0;
  const m = t.match(/matrix\\(([^)]+)\\)/);
  return m ? Math.round(parseFloat(m[1].split(',')[5])) : null;
};
// Where a face is headed: the resolved --slide, in pixels. A percentage is
// against the face's own height, which a transform does not change.
const target = (el) => {
  const s = (getComputedStyle(el).getPropertyValue('--slide') || '0px').trim();
  return s.endsWith('%')
    ? Math.round((parseFloat(s) / 100) * el.getBoundingClientRect().height)
    : Math.round(parseFloat(s) || 0);
};

const state = () => ({
  title: $('.panel-title').textContent,
  deckClass: deck().className,
  slides: [
    getComputedStyle(face('activity')).getPropertyValue('--slide'),
    getComputedStyle(face('tasks')).getPropertyValue('--slide'),
  ],
  expanded: grip().getAttribute('aria-expanded'),
  label: grip().getAttribute('aria-label'),
  hint: $('.panel-grip-keys').textContent,
  activity: { shift: shift(face('activity')), visibility: getComputedStyle(face('activity')).visibility, hidden: face('activity').getAttribute('aria-hidden') },
  tasks: { shift: shift(face('tasks')), visibility: getComputedStyle(face('tasks')).visibility, hidden: face('tasks').getAttribute('aria-hidden') },
});

const key = (init) => window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
// A key press aimed at whatever holds focus, which is what a real one is. The
// window-level handler listens in capture, so it sees this on the way down with
// the focused element as the target — and the sideways keys are decided on
// exactly that: an arrow inside a text field belongs to the caret.
const keyOn = (el, init) => el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
const point = (type, y) => grip().dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: 40, clientY: y }));
const drag = async (dy, midway) => {
  const from = box(grip()).top + 20;
  point('pointerdown', from);
  for (let i = 1; i <= 4; i += 1) { point('pointermove', from + (dy * i) / 4); await wait(16); }
  // Read while the finger is still down, if the caller wants to know what a
  // half-finished pull looks like.
  const seen = midway ? midway() : null;
  point('pointerup', from + dy);
  grip().click();
  await wait(400);
  return seen;
};

// What the eye gets during a drag: where each floor is, and whether it is
// painting at all. The one being pulled in is still the parked one until the
// finger lifts — if it is hidden, the pull opens an empty strip.
const midDrag = () => ({
  pulled: getComputedStyle(deck()).getPropertyValue('--pull').trim(),
  transition: getComputedStyle(face('activity')).transitionDuration,
  activity: { shift: shift(face('activity')), visibility: getComputedStyle(face('activity')).visibility },
  tasks: { shift: shift(face('tasks')), visibility: getComputedStyle(face('tasks')).visibility },
});

// WCAG contrast between two computed colours, for the small text this adds.
const lum = (c) => {
  const [r, g, b] = c.match(/[\\d.]+/g).slice(0, 3).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (fg, bg) => {
  const a = lum(fg), b = lum(bg);
  return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
};

(async () => {
  const out = { steps: {} };
  await draw();
  await wait(200);

  const panelH = box(deck()).height;
  out.deckHeight = panelH;
  out.overflow = getComputedStyle(deck()).overflow;
  out.steps.atRest = state();
  const cardAtRest = box($('.ptt-bar'));
  out.steps.cardAtRest = cardAtRest;

  // ---- the transition each direction is given
  out.transitions = {
    down: getComputedStyle(face('activity')).transitionDuration + ' ' + getComputedStyle(face('activity')).transitionTimingFunction,
  };

  // ---- the shortcut, from the composer with a draft in it
  const draft = document.getElementById('draft');
  draft.value = 'half a sentence';
  draft.focus();
  key({ key: 'ArrowUp', ctrlKey: true });
  await wait(400);
  out.steps.afterShortcutUp = state();
  out.steps.draftAfterShortcut = draft.value;
  out.steps.cardAfterUp = box($('.ptt-bar'));
  out.transitions.up = getComputedStyle(face('tasks')).transitionDuration + ' ' + getComputedStyle(face('tasks')).transitionTimingFunction;

  key({ key: 'ArrowDown', ctrlKey: true });
  await wait(400);
  out.steps.afterShortcutDown = state();

  // ---- a plain arrow must not be taken from anyone
  key({ key: 'ArrowUp' });
  await wait(200);
  out.steps.plainArrowIgnored = $('.panel-title').textContent === 'Activity Panel';

  // ---- the three views, and the bare keys that step between them
  //
  // Bare left and right, so everything that decides whether they are ours has to
  // be checked here: the floor showing, what holds focus, and the window width
  // (that one in the narrow run below).
  const viewTitle = () => $('.task-view-title').textContent;
  const step = async (el, k) => { keyOn(el, { key: k }); await wait(120); };

  // Down, the sideways keys have nothing to answer: there is one view on the
  // other floor, and the Task Bar's three are not on screen at all.
  out.steps.acrossWhileDown = { floor: $('.panel-title').textContent, before: viewTitle() };
  await step(document.body, 'ArrowRight');
  out.steps.acrossWhileDown.after = viewTitle();

  // Up, but with the cursor in the composer. This is the one place the two
  // halves of the shortcut differ on purpose: ⌘↑ has always reached the deck
  // from inside a draft and still must, while a bare arrow there is the caret.
  draft.focus();
  keyOn(draft, { key: 'ArrowUp', ctrlKey: true });
  await wait(400);
  out.steps.acrossWhileTyping = { floor: $('.panel-title').textContent, before: viewTitle() };
  await step(draft, 'ArrowRight');
  out.steps.acrossWhileTyping.after = viewTitle();
  out.steps.acrossWhileTyping.draft = draft.value;
  draft.blur();

  // And now, with nothing else claiming the key, all the way round and back.
  const right = [];
  for (let i = 0; i < 4; i += 1) { await step(document.body, 'ArrowRight'); right.push(viewTitle()); }
  out.steps.cycleRight = right;
  const left = [];
  for (let i = 0; i < 4; i += 1) { await step(document.body, 'ArrowLeft'); left.push(viewTitle()); }
  out.steps.cycleLeft = left;
  // The body under the name is the one that name belongs to, so a title that
  // moved without its view would be caught here rather than looking right.
  out.steps.bodyWithTitle = { title: viewTitle(), body: face('tasks').textContent };

  // The floor's own chrome must not have pushed the pinned card above it. Where
  // the floor itself comes to rest is measured further down, with the motion
  // taken out — a face mid-slide reports the position it set off from.
  out.steps.cardWithTaskChrome = box($('.ptt-bar'));

  keyOn(document.body, { key: 'ArrowDown', ctrlKey: true });
  await wait(400);
  out.steps.backDown = $('.panel-title').textContent;

  // ---- the grip: a nudge below the threshold, then a real pull
  await drag(-10);
  out.steps.afterNudge = $('.panel-title').textContent;
  out.steps.midPullUp = await drag(-60, midDrag);
  out.steps.afterPullUp = $('.panel-title').textContent;
  out.steps.midPullDown = await drag(60, midDrag);
  out.steps.afterPullDown = $('.panel-title').textContent;

  // ---- and a click, which is the same gesture without the travel
  grip().click();
  await wait(300);
  out.steps.afterClick = $('.panel-title').textContent;
  grip().click();
  await wait(300);
  out.steps.afterSecondClick = $('.panel-title').textContent;

  // ---- picking a different conversation while the task bar is up
  //
  // The left panel keeps working, and the only thing that answers on this side
  // is the pinned card. The floor must not fall back on its own, and the panel
  // parked below must be the one now selected when it is pulled back up.
  grip().click();
  await wait(400);
  const cardText = () => $('.ptt-status').textContent;
  out.steps.selection = { startedOn: $('.panel-title').textContent, card: cardText() };
  await select(PERSON);
  out.steps.selection.afterPicking = {
    title: $('.panel-title').textContent,
    card: cardText(),
    cardBox: box($('.ptt-bar')),
    activityHolds: face('activity').textContent.includes('Latency'),
  };
  grip().click();
  await wait(400);
  out.steps.selection.afterComingBack = {
    title: $('.panel-title').textContent,
    showing: face('activity').textContent.includes('Latency') ? 'Ada' : 'stale',
  };
  await select(SESSION);
  await wait(150);

  // ---- the hint cannot resize the bar it lives in
  const hint = $('.panel-grip-keys');
  const gripBefore = box(grip());
  hint.style.opacity = '1';
  await wait(80);
  const gripAfter = box(grip());
  out.steps.hint = {
    position: getComputedStyle(hint).position,
    gripHeightBefore: gripBefore.height,
    gripHeightAfter: gripAfter.height,
    deckHeightUnchanged: box(deck()).height === panelH,
    text: hint.textContent,
  };
  hint.style.opacity = '';

  // ---- where the floors actually come to rest
  //
  // Read with the motion taken out. A transform transition is run by the
  // compositor, which does not tick under headless virtual time — so a reading
  // taken while one is in flight reports the position it started from, and any
  // number derived from it would be a fiction. What the transition itself is
  // given is reported above, straight off the computed style.
  const still = document.createElement('style');
  still.textContent = '.panel-deck-face { transition: none !important; }';
  document.head.appendChild(still);

  grip().click();
  await wait(150);
  out.resting = { up: state(), cardUp: box($('.ptt-bar')) };
  // The task floor, in view, with its heading and its row of buttons in it. It
  // is a deck face, pinned to every edge of the deck, so it must still be
  // exactly the deck — anything else and the travel below is measuring a box
  // other than the one the eye is looking at.
  out.resting.taskFace = box(face('tasks'));
  out.resting.deckBox = box(deck());
  // Read off the raw rects rather than the rounded boxes: a 1px border and a
  // fractional height would show up as a gap that is not there once each edge
  // has been rounded on its own.
  const edges = (el) => el.getBoundingClientRect();
  const gap = (a, b) => Math.round(edges(b).top - edges(a).bottom);
  out.resting.chrome = {
    title: box($('.task-view-title')),
    menu: box($('.task-view-menu')),
    body: box($('.task-view-body')),
    // The three parts, stacked with nothing between them and nothing left over
    // at either end: the floor is exactly its heading, its body and its buttons.
    gaps: {
      aboveTitle: Math.round(edges($('.task-view-title')).top - edges(face('tasks')).top),
      titleToBody: gap($('.task-view-title'), $('.task-view-body')),
      bodyToMenu: gap($('.task-view-body'), $('.task-view-menu')),
      belowMenu: Math.round(edges(face('tasks')).bottom - edges($('.task-view-menu')).bottom),
    },
    bodyOverflow: getComputedStyle($('.task-view-body')).overflowY,
    faceOverflow: getComputedStyle(face('tasks')).overflowY,
  };
  grip().click();
  await wait(150);
  out.resting.down = state();
  out.resting.cardDown = box($('.ptt-bar'));
  // Each floor is one panel height from where the other one is, and both are
  // that same height apart in either state: they move as a single surface, with
  // no gap opening between them.
  out.resting.travel = {
    activity: out.resting.down.activity.shift - out.resting.up.activity.shift,
    tasks: out.resting.down.tasks.shift - out.resting.up.tasks.shift,
    panelHeight: panelH,
  };
  still.remove();

  // ---- small text, dark panel: the two colours this adds
  const panelBg = getComputedStyle($('.side-panel')).backgroundColor;
  out.contrast = {
    title: contrast(getComputedStyle($('.panel-title')).color, panelBg),
    hint: contrast(getComputedStyle(hint).color, panelBg),
    // The floor's own heading is the same size on the same background, so it
    // has the same 4.5:1 to clear.
    view: contrast(getComputedStyle($('.task-view-title')).color, panelBg),
    fontSize: getComputedStyle($('.panel-title')).fontSize,
    viewFontSize: getComputedStyle($('.task-view-title')).fontSize,
  };

  // ---- the bar is a target, not a hairline
  out.steps.gripBox = box(grip());
  out.steps.bodyScrollsSideways = document.body.scrollWidth > document.body.clientWidth;

  if (LEAVE_UP && $('.panel-title').textContent !== 'Task Bar') { grip().click(); await wait(400); }
  if (!LEAVE_UP && $('.panel-title').textContent !== 'Activity Panel') { grip().click(); await wait(400); }
  out.steps.leftShowing = $('.panel-title').textContent;

  const pre = document.createElement('pre');
  pre.id = 'result';
  pre.textContent = JSON.stringify(out);
  document.body.appendChild(pre);
})();
</script>
</body></html>`;
}

// The narrow window: the column is gone, so the shortcut has nothing to move.
function buildNarrowPage(bundle) {
  const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${css}</style></head>
<body><div id="root"><div class="app">
  <div class="sidebar"></div><div class="chat-wrap"></div>
  <aside class="side-panel" id="panel"></aside>
</div></div>
<script>${bundle}</script>
<script>
const { React, createRoot, SidePanelDeck, ConnectionPanel, EmptyState } = window.__lanchat;
const h = React.createElement;
let up = false;
let view = 'notes';
const root = createRoot(document.getElementById('panel'));
const draw = () => new Promise((r) => {
  root.render(h(SidePanelDeck, {
    up, onUp: (n) => { up = n; draw(); }, dictation: null,
    view, onView: (n) => { view = n; draw(); },
    tasks: h(EmptyState, { title: 'No notes yet' }, 'Anything you write here stays on this machine.'),
    activity: h(ConnectionPanel, { peer: null }),
  }));
  setTimeout(r, 60);
});
(async () => {
  await draw();
  await new Promise((r) => setTimeout(r, 150));
  const out = { panelDisplay: getComputedStyle(document.getElementById('panel')).display };
  const press = (init) => document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  press({ key: 'ArrowUp', ctrlKey: true });
  await new Promise((r) => setTimeout(r, 250));
  out.stateAfterShortcut = up;
  // And the sideways pair is gone with the rest of the column. It is gated on
  // the same offsetParent, but on its own line of the handler, so it is asked
  // its own question here rather than being assumed to follow.
  press({ key: 'ArrowRight' });
  await new Promise((r) => setTimeout(r, 250));
  out.viewAfterShortcut = view;
  const pre = document.createElement('pre');
  pre.id = 'result';
  pre.textContent = JSON.stringify(out);
  document.body.appendChild(pre);
})();
</script>
</body></html>`;
}

async function runSidePanelHarness(outDir) {
  const chrome = chromiumPath();
  if (!chrome) return { skipped: 'no chromium on PATH' };
  try {
    require('esbuild');
  } catch {
    return { skipped: 'esbuild not installed' };
  }

  return withScratchDir(outDir, 'lanchat-side-panel-', (dir, keep) => {
    const bundle = buildBundle(dir);

    const downFile = path.join(dir, 'panel-down.html');
    fs.writeFileSync(downFile, buildPage(dir, bundle, false));
    const down = render(chrome, dir, downFile, {
      ...RUN,
      png: keep ? path.join(dir, 'panel-down.png') : null,
    });

    // The same run again, left on the other floor, only for the picture.
    let up = null;
    if (keep) {
      const upFile = path.join(dir, 'panel-up.html');
      fs.writeFileSync(upFile, buildPage(dir, bundle, true));
      up = render(chrome, dir, upFile, { ...RUN, png: path.join(dir, 'panel-up.png'), dump: false });
    }

    const narrowFile = path.join(dir, 'panel-narrow.html');
    fs.writeFileSync(narrowFile, buildNarrowPage(bundle));
    const narrow = render(chrome, dir, narrowFile, { ...NARROW });

    return { ...(down || { empty: true }), narrow, leftUp: up, dir: keep ? dir : null };
  });
}

module.exports = { runSidePanelHarness };

if (require.main === module) {
  runSidePanelHarness(process.argv[2])
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
