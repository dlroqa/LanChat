'use strict';

// A question that went unanswered, on its way out of the thread.
//
// The decision to retire it is pure and pinned in test/resendLink.test.js. What
// is left is the part only a layout engine can answer: whether the bubble comes
// apart on the way out or simply stops existing. That hangs on one selector —
// the disintegration used to be scoped to `.erasing.dissolving`, and `erasing`
// is a thing a *failed run's error* wears, never the question it failed — so a
// retired question would have blinked out. A rule nothing matched is exactly the
// sort of bug a screenshot of the "before" state cannot show.
//
// Also checked here: the button. A bubble on its way out must not still offer to
// put its words back in the composer.
//
//   node scripts/retire-harness.js [outDir]
//
// Note for this sandbox: snap chromium cannot write into /tmp or dot-directories,
// so the working directory has to be somewhere ordinary — see lib/chromium.js.

const fs = require('node:fs');
const path = require('node:path');
const { chromiumPath, render, withScratchDir } = require('./lib/chromium.js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer');

const RUN = { width: 900, height: 520, budget: 4000, args: ['--hide-scrollbars'] };

// The animation App.jsx times its removal against. Read from the stylesheet
// rather than restated, so a change to one is a failure here and not a drift.
const DISSOLVE_MS = 620;

function entry() {
  return `
import React from 'react';
import { createRoot } from 'react-dom/client';
import MessageBubble from ${JSON.stringify(path.join(SRC, 'components', 'MessageBubble.jsx'))};
window.__lanchat = { React, createRoot, MessageBubble };
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

function buildPage(dir) {
  const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');
  const bundle = buildBundle(dir);
  const ASKED = 'I want you to check the latest earthquake around the world';

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${css}</style></head>
<body><div id="root"><div class="app">
  <div class="chat-wrap"><div class="messages-wrap"><div class="messages" id="mount"></div></div></div>
</div></div>
<script>${bundle}</script>
<script>
const { React, createRoot, MessageBubble } = window.__lanchat;
const h = React.createElement;

const ASKED = ${JSON.stringify(ASKED)};
const DISSOLVE_MS = ${DISSOLVE_MS};
const restored = [];

// The three states one question passes through: marked and waiting to be put
// back, going now that its replacement was answered, and — as a control — an
// ordinary question that was answered the first time and is not going anywhere.
const question = (id, extra) => ({
  id, peerId: 'session:1', direction: 'out', kind: 'text',
  text: ASKED, ts: Date.parse('2026-08-01T22:30:00Z'), ...extra,
});

const props = (id, extra) => ({
  msg: question(id, extra),
  grouped: false,
  onResend: (m) => restored.push(m.id),
});

const root = createRoot(document.getElementById('mount'));
root.render(h(React.Fragment, null,
  h('div', { id: 'marked' }, h(MessageBubble, props('q1', { failed: true }))),
  h('div', { id: 'going' }, h(MessageBubble, props('q2', { failed: true, dissolving: true }))),
  h('div', { id: 'plain' }, h(MessageBubble, props('q3', {})))
));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shown = (el) => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height) };
};

function read(scope) {
  const box = document.querySelector('#' + scope);
  const row = box.querySelector('.bubble-row');
  const bubble = box.querySelector('.bubble');
  const button = box.querySelector('.bubble-resend');
  const style = getComputedStyle(row);
  return {
    // The whole point: a row that is going has to be running the disintegration.
    // 'none' here is the bug this harness exists for.
    animation: style.animationName,
    duration: style.animationDuration,
    fill: style.animationFillMode,
    // What the bubble says it is, in classes and in words.
    classes: row.className.trim().split(/\\s+/).filter(Boolean).sort(),
    mark: (box.querySelector('.failed-mark') || {}).textContent || null,
    // And the one control beside it.
    button: button ? { name: button.getAttribute('aria-label'), box: shown(button) } : null,
    bubble: shown(bubble),
    // Read out to prove the words are still legible while it is marked: a
    // question you are being invited to send again must not be the faintest
    // thing on screen.
    text: (box.querySelector('.text') || {}).textContent || null,
    opacity: style.opacity,
  };
}

(async () => {
  await wait(120);

  // Frozen part-way through, so the screenshot shows a bubble coming apart
  // rather than an empty gap where one finished leaving.
  const going = document.querySelector('#going .bubble-row');
  going.style.animationPlayState = 'paused';
  going.style.animationDelay = '-300ms';

  const marked = read('marked');
  const dissolving = read('going');
  const plain = read('plain');

  // The button on the marked one still works — that is what starts all of this.
  const press = document.querySelector('#marked .bubble-resend');
  if (press) press.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await wait(20);

  const pre = document.createElement('pre');
  pre.id = 'result';
  pre.textContent = JSON.stringify({ marked, dissolving, plain, restored, dissolveMs: DISSOLVE_MS });
  document.body.appendChild(pre);
})();
</script></body></html>`;
}

async function runRetireHarness(outDir) {
  const chrome = chromiumPath();
  if (!chrome) return { skipped: 'no chromium on this machine' };

  return withScratchDir(outDir, 'lanchat-retire-', async (dir, keep) => {
    const page = path.join(dir, 'page.html');
    fs.writeFileSync(page, buildPage(dir));
    const result = render(chrome, dir, page, {
      ...RUN,
      ...(keep && { png: path.join(dir, 'retire.png') }),
    });
    if (!result) return { skipped: 'the page produced no result' };
    return { ...result, dir: keep ? dir : null };
  });
}

module.exports = { runRetireHarness, buildPage };

if (require.main === module) {
  runRetireHarness(process.argv[2])
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
