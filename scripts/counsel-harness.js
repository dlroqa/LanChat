'use strict';

// Drives a session's agent picker in a real browser, mounted for real.
//
// The copy around a counsel is pinned in test/counsel.test.js, which is where
// the pure part lives. What is left is everything that only exists once the menu
// is running: it opens on a click and stays open through a tick — a multi-select
// that shut itself would make assembling a counsel three trips through the same
// menu — it shuts on Escape and on a click elsewhere, and un-ticking one agent
// while the session was set to ask everybody has to turn a standing instruction
// into a written-down list without the reader doing anything else.
//
// It also proves the thing a popup over a composer must never do: lose what
// somebody had already typed.
//
//   node scripts/counsel-harness.js [outDir]
//
// Note for this sandbox: snap chromium cannot write into /tmp or dot-directories,
// so the working directory has to be somewhere ordinary — see lib/chromium.js.

const fs = require('node:fs');
const path = require('node:path');
const { chromiumPath, render, withScratchDir } = require('./lib/chromium.js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer');

const RUN = { width: 1180, height: 760, budget: 8000, args: ['--hide-scrollbars'] };

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
  <div class="chat-wrap" id="mount"></div>
  <aside class="side-panel"></aside>
</div></div>
<script>${bundle}</script>
<script>
const { React, createRoot, ChatPane } = window.__lanchat;
const h = React.createElement;

// Three agents, in the shape main publishes them — see askable() in
// sessions/index.js. One is switched off and one belongs to a peer: a counsel is
// a standing choice about who to ask, so an agent that cannot answer right now
// has to stay tickable and be skipped rather than disappear from the list
// somebody is choosing from.
const agents = [
  { id: 'agent:1', name: 'Tessie', remote: false, ready: true, reason: null },
  { id: 'remote-agent:p1:agent:9', name: 'Hermes', remote: true, viaName: 'Server', ready: true, reason: null },
  { id: 'agent:3', name: 'Fable', remote: false, ready: false, reason: 'off' },
];

// The record, mirrored the way App.jsx mirrors it: the pane is handed a card,
// hands back a patch, and the next render is drawn from the patched record.
let record = { agentIds: ['agent:1'], allAgents: false, mode: 'parallel' };
const patches = [];

const card = () => {
  const counsel = record.allAgents
    ? agents
    : record.agentIds.map((id) => agents.find((a) => a.id === id)).filter(Boolean);
  return {
    id: 'session:1', kind: 'session', name: 'why the turn moved', online: true,
    agentIds: record.agentIds, allAgents: record.allAgents, mode: record.mode,
    agentNames: counsel.map((a) => a.name),
    agentId: counsel[0] ? counsel[0].id : null,
    agentName: counsel[0] ? counsel[0].name : null,
  };
};

const props = () => ({
  peer: card(),
  messages: [
    { id: 'm1', peerId: 'session:1', direction: 'out', kind: 'text', text: 'what should we call it?', ts: Date.now() - 60000 },
    { id: 'm2', peerId: 'session:1', direction: 'in', kind: 'text', text: 'Counsel mode.', ts: Date.now() - 50000, speaker: 'Tessie' },
    { id: 'm3', peerId: 'session:1', direction: 'in', kind: 'text', text: 'I would call it a round table.', ts: Date.now() - 49000, speaker: 'Hermes' },
  ],
  progress: {}, agents, mentionables: [], docs: [],
  onSetCounsel: (id, patch) => { patches.push(patch); record = { ...record, ...patch }; draw(); },
  onRenameSession: () => {}, onImportText: () => {}, onSend: () => {}, onAttach: () => {},
  onTyping: () => {}, onOpenFile: () => {}, onRevealFile: () => {},
  onClearHistory: () => {}, onExportHistory: () => {}, onVoiceCall: () => {}, onVideoCall: () => {},
});

const root = createRoot(document.getElementById('mount'));
const draw = () => root.render(h(ChatPane, props()));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const chip = () => document.querySelector('.agent-chip');
const menu = () => document.querySelector('.agent-menu');
const rows = () => [...document.querySelectorAll('.agent-menu [role="menuitemcheckbox"]')];
const modes = () => [...document.querySelectorAll('.agent-menu [role="menuitemradio"]')];
const rowNamed = (name) => rows().find((r) => r.querySelector('.agent-pick-name').textContent === name);

const click = (el) => {
  // Pointerdown as well as click: the menu shuts on pointerdown anywhere outside
  // it, and a click that skipped that event would never exercise the guard.
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};
const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

// Whether the menu can actually be seen, as opposed to merely existing.
//
// Worth measuring separately, and this is why: the subtitle a session's chip
// sits in clips to one line, so that a peer's platform or a queue position
// cannot push the header out of shape. A menu opening downwards out of that line
// is exactly what such a rule clips — it was in the DOM, correct in every
// respect, and painted nowhere. Presence is not visibility, and only one of them
// is what somebody clicking the chip is after.
function visible(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const box = { w: Math.round(r.width), h: Math.round(r.height) };
  // Walk the ancestors for anything that clips, and report the overlap with it.
  let clip = null;
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.overflow === 'visible' && cs.overflowY === 'visible') continue;
    const pr = p.getBoundingClientRect();
    const shown = Math.max(0, Math.min(r.bottom, pr.bottom) - Math.max(r.top, pr.top));
    clip = { by: p.className, shownPx: Math.round(shown), ofPx: box.h };
    break;
  }
  return { ...box, clip };
}

function state() {
  const m = menu();
  return {
    chip: chip().textContent.trim(),
    chipExpanded: chip().getAttribute('aria-expanded'),
    open: Boolean(m),
    menuBox: visible(m),
    role: m ? m.getAttribute('role') : null,
    rows: rows().map((r) => ({
      name: r.querySelector('.agent-pick-name').textContent,
      note: (r.querySelector('.agent-pick-note') || {}).textContent || null,
      checked: r.getAttribute('aria-checked'),
      role: r.getAttribute('role'),
      classes: r.className.trim(),
      disabled: r.disabled,
    })),
    modes: modes().map((r) => ({
      name: r.querySelector('.agent-pick-name').textContent,
      checked: r.getAttribute('aria-checked'),
    })),
    // What the rest of the window says about the same counsel, so the chip and
    // the composer can be caught disagreeing with each other.
    placeholder: document.querySelector('.composer textarea').placeholder,
    composerDisabled: document.querySelector('.composer textarea').disabled,
    draft: document.querySelector('.composer textarea').value,
    // Two agents answered in a row; each answer has to say whose it is.
    speakers: [...document.querySelectorAll('.bubble-speaker')].map((e) => e.textContent),
    grouped: [...document.querySelectorAll('.bubble-row')].map((e) => e.classList.contains('grouped')),
  };
}

(async () => {
  const steps = {};
  draw();
  await wait(120);

  // Somebody has already started typing. Nothing the menu does may cost them it.
  const box = document.querySelector('.composer textarea');
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setValue.call(box, 'half a question');
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(60);
  steps.typing = state();

  click(chip());
  await wait(60);
  steps.opened = state();

  // Ticking a second agent must not shut the menu.
  click(rowNamed('Hermes'));
  await wait(60);
  steps.twoTicked = state();

  // And nor must ticking the one that is switched off.
  click(rowNamed('Fable'));
  await wait(60);
  steps.offTicked = state();

  click(rowNamed('All agents'));
  await wait(60);
  steps.allAgents = state();

  // A run that only wants a picture stops here, with the menu open over the
  // conversation — which is the state worth looking at. The walk below shuts it,
  // and a screenshot of a shut menu says nothing.
  if (location.hash === '#shot') return;

  // The moment a standing instruction becomes a list: everybody who is here now,
  // less the one just un-ticked.
  click(rowNamed('Tessie'));
  await wait(60);
  steps.narrowed = state();

  click(modes().find((m) => m.querySelector('.agent-pick-name').textContent === 'In turn'));
  await wait(60);
  steps.relay = state();

  key(menu(), 'Escape');
  await wait(60);
  steps.escaped = state();

  // Open again, then click somewhere else entirely.
  click(chip());
  await wait(60);
  click(document.querySelector('.messages'));
  await wait(60);
  steps.clickedAway = state();

  const pre = document.createElement('pre');
  pre.id = 'result';
  pre.textContent = JSON.stringify({ steps, patches });
  document.body.appendChild(pre);
})();
</script></body></html>`;
}

async function runCounselHarness(outDir) {
  const chrome = chromiumPath();
  if (!chrome) return { skipped: 'no chromium on this machine' };

  return withScratchDir(outDir, 'lanchat-counsel-', async (dir, keep) => {
    const page = path.join(dir, 'page.html');
    fs.writeFileSync(page, buildPage(dir));
    const result = render(chrome, dir, page, RUN);
    if (!result) return { skipped: 'the page produced no result' };
    // A picture of the menu open, kept only when somebody asked for the output
    // to be kept — a test run has no use for it and should leave nothing behind.
    if (keep) {
      render(chrome, dir, `${page}#shot`, { ...RUN, dump: false, png: path.join(dir, 'picker.png') });
    }
    return { ...result, dir: keep ? dir : null };
  });
}

module.exports = { runCounselHarness, buildPage };

if (require.main === module) {
  runCounselHarness(process.argv[2])
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
