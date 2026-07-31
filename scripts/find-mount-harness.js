'use strict';

// Drives the find bar in a real browser, mounted in the real pane.
//
// Everything the bar does is a conversation between three things that only exist
// once the app is running: React state, a scroll container with more content in
// it than fits, and a keyboard. Whether Ctrl+F opens it, whether the arrows walk
// the hits in the order they are read, whether the view moves to the hit, and —
// the one that matters most — whether a message arriving mid-search yanks the
// reader back to the bottom, are all questions about a mounted component.
//
// So this bundles ChatPane exactly as vite would, mounts it over a long
// conversation, and does what a person would do: presses Ctrl+F, types a word,
// steps through the matches, gets interrupted by an answer, and presses Escape.
//
//   node scripts/find-mount-harness.js [outDir]

const fs = require('node:fs');
const path = require('node:path');
const { chromiumPath, render, withScratchDir } = require('./lib/chromium.js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer');

const RUN = { width: 1100, height: 720, budget: 8000, args: ['--hide-scrollbars'] };

// Long enough to scroll, with the word scattered through it rather than only at
// the end — a search that could be satisfied by what is already on screen would
// prove nothing about moving to what is not.
const HITS_AT = [3, 17, 42, 61, 88];

function entry() {
  return `
import React from 'react';
import { createRoot } from 'react-dom/client';
import ChatPane from ${JSON.stringify(path.join(SRC, 'components', 'ChatPane.jsx'))};
window.__lanchat = { React, createRoot, ChatPane };
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
    // The entry sits in the scratch directory, which is nowhere near the
    // project's node_modules — so react has to be pointed at.
    nodePaths: [path.join(ROOT, 'node_modules')],
    logLevel: 'silent',
  });
  return fs.readFileSync(outFile, 'utf8');
}

function buildPage(dir) {
  const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');
  const bundle = buildBundle(dir);

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${css}</style></head>
<body><div id="root"><div class="app">
  <div class="sidebar"></div>
  <div class="chat-wrap" id="pane"></div>
  <aside class="side-panel"></aside>
</div></div>
<script>${bundle}</script>
<script>
const { React, createRoot, ChatPane } = window.__lanchat;
const h = React.createElement;
const HITS_AT = ${JSON.stringify(HITS_AT)};
const DAY = 24 * 60 * 60 * 1000;

// A conversation long enough to have scrolled away from its own beginning.
function messages(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      id: 'm' + i,
      ts: Date.now() - (n - i) * 60000 - DAY,
      direction: i % 3 === 0 ? 'out' : 'in',
      kind: 'text',
      text: HITS_AT.includes(i)
        ? 'Message ' + i + ' — about kangkong, which is water spinach.'
        : 'Message ' + i + ' — an ordinary line of conversation with nothing in it.',
    });
  }
  return out;
}

const peer = { id: 's1', kind: 'session', name: 'Kangkong', agentId: 'a1' };
const props = (msgs) => ({
  peer,
  messages: msgs,
  typing: false,
  awaiting: false,
  progress: {},
  agents: [{ id: 'a1', name: 'Tessie' }],
  onSend: () => {}, onAttach: () => {}, onTyping: () => {},
  onOpenFile: () => {}, onRevealFile: () => {}, onOpenLink: () => {},
  onClearHistory: () => {}, onExportHistory: () => {}, onImportText: () => {},
  onRenameSession: () => {}, onSetSessionAgent: () => {},
  canFind: true,
});

// Mounted inside the grid the app mounts it in. On its own the pane has no
// height to be bounded by, the scroller never overflows, and every question
// below about where the view is would be a question about a page that scrolls
// as a whole — which is not the thing being tested.
const root = createRoot(document.getElementById('pane'));
const draw = (msgs) => new Promise((r) => { root.render(h(ChatPane, props(msgs))); setTimeout(r, 60); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (sel) => document.querySelector(sel);
const scroller = () => $('.messages');
const count = () => ($('.find-count') || {}).textContent;
const currentHit = () => $('mark.find-hit.current');
// How far the current hit is from the middle of the scroller. The bar floats
// over the top of it, so a hit centred is a hit nobody has to hunt for.
const offCentre = () => {
  const hit = currentHit();
  if (!hit) return null;
  const box = scroller().getBoundingClientRect();
  const seen = hit.getBoundingClientRect();
  return Math.round(seen.top + seen.height / 2 - (box.top + box.height / 2));
};
// React does not see a value assigned straight onto the input.
const type = (text) => {
  const input = $('.find-input');
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const key = (target, init) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

(async () => {
  const out = { steps: {} };
  const list = messages(100);
  await draw(list);

  const s = scroller();
  out.scrolls = s.scrollHeight > s.clientHeight + 1;
  out.startedAtBottom = Math.abs(s.scrollHeight - s.scrollTop - s.clientHeight) < 2;

  // ---- Ctrl+F opens it
  key(window, { key: 'f', ctrlKey: true });
  await wait(60);
  out.steps.openedByShortcut = Boolean($('.find-bar'));

  // ---- typing a word counts it
  type('kangkong');
  await wait(80);
  out.steps.count = count();
  out.steps.marks = document.querySelectorAll('mark.find-hit').length;
  out.steps.landedOn = currentHit() && currentHit().dataset.hit;
  out.steps.landedCentred = offCentre();
  out.steps.scrollTopAfterQuery = Math.round(s.scrollTop);
  out.steps.movedOffBottom = s.scrollHeight - s.scrollTop - s.clientHeight > 2;

  // ---- the up arrow walks back through the conversation
  $('button[aria-label="Previous match"]').click();
  await wait(80);
  out.steps.afterPrev = { count: count(), hit: currentHit() && currentHit().dataset.hit, offCentre: offCentre() };
  const wentUp = s.scrollTop;

  // ---- and Shift+Enter does the same thing from the keyboard
  key($('.find-input'), { key: 'Enter', shiftKey: true });
  await wait(80);
  out.steps.afterShiftEnter = { count: count(), hit: currentHit() && currentHit().dataset.hit };
  out.steps.keyboardMovedToo = Math.round(s.scrollTop) !== Math.round(wentUp);

  // ---- an answer arriving must not drag the reader back to the bottom
  const held = Math.round(s.scrollTop);
  await draw([...list, { id: 'later', ts: Date.now(), direction: 'in', kind: 'text', text: 'A new answer arrives.' }]);
  await wait(80);
  out.steps.heldPosition = Math.round(s.scrollTop) === held;
  out.steps.stillAwayFromBottom = s.scrollHeight - s.scrollTop - s.clientHeight > 2;
  out.steps.countAfterArrival = count();

  // ---- wrapping around the ends
  const first = $('button[aria-label="Next match"]');
  for (let i = 0; i < 8; i += 1) { first.click(); await wait(30); }
  out.steps.afterWrapping = { count: count(), hit: currentHit() && currentHit().dataset.hit };

  // ---- Escape closes it and puts the cursor back where typing happens
  key($('.find-input'), { key: 'Escape' });
  await wait(80);
  out.steps.closed = !$('.find-bar');
  out.steps.marksCleared = document.querySelectorAll('mark.find-hit').length;
  out.steps.focusAfterClose = document.activeElement && document.activeElement.tagName;

  // ---- and it opens again, from the button beside the name. Left open on
  // purpose: the screenshot is taken when the run ends, and a picture of the
  // bar is the point of keeping one.
  $('.find-btn').click();
  await wait(60);
  type('kangkong');
  await wait(80);
  out.steps.reopened = { open: Boolean($('.find-bar')), count: count() };

  const pre = document.createElement('pre');
  pre.id = 'result';
  pre.textContent = JSON.stringify(out);
  document.body.appendChild(pre);
})();
</script>
</body></html>`;
}

async function runFindMountHarness(outDir) {
  const chrome = chromiumPath();
  if (!chrome) return { skipped: 'no chromium on PATH' };
  try {
    require('esbuild');
  } catch {
    return { skipped: 'esbuild not installed' };
  }

  return withScratchDir(outDir, 'lanchat-find-mount-', (dir, keep) => {
    const pageFile = path.join(dir, 'mount.html');
    fs.writeFileSync(pageFile, buildPage(dir));
    const result = render(chrome, dir, pageFile, {
      ...RUN,
      png: keep ? path.join(dir, 'mount.png') : null,
    });
    return { ...(result || { empty: true }), dir: keep ? dir : null };
  });
}

module.exports = { runFindMountHarness };

if (require.main === module) {
  runFindMountHarness(process.argv[2])
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
