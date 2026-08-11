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
let record = { agentIds: ['agent:1'], allAgents: false, mode: 'parallel', turns: 6 };
const patches = [];

const card = () => {
  const counsel = record.allAgents
    ? agents
    : record.agentIds.map((id) => agents.find((a) => a.id === id)).filter(Boolean);
  return {
    id: 'session:1', kind: 'session', name: 'why the turn moved', online: true,
    agentIds: record.agentIds, allAgents: record.allAgents, mode: record.mode, turns: record.turns,
    agentNames: counsel.map((a) => a.name),
    members: record.members || [],
    observer: record.observer || null,
    asking: record.asking || 'nobody',
    agentId: counsel[0] ? counsel[0].id : null,
    agentName: counsel[0] ? counsel[0].name : null,
  };
};

const placed = [];

const props = () => ({
  peer: card(),
  messages: [
    { id: 'm1', peerId: 'session:1', direction: 'out', kind: 'text', text: 'what should we call it?', ts: Date.now() - 60000 },
    { id: 'm2', peerId: 'session:1', direction: 'in', kind: 'text', text: 'Counsel mode.', ts: Date.now() - 50000, speaker: 'Tessie' },
    { id: 'm3', peerId: 'session:1', direction: 'in', kind: 'text', text: 'I would call it a round table.', ts: Date.now() - 49000, speaker: 'Hermes' },
  ],
  progress: {}, agents, mentionables: [], docs: [],
  // Online people, in the shape App publishes them. Only online ones reach the
  // picker — see invitablePeers in App.jsx.
  roomPeers: [
    { id: 'p-zima', name: 'Zima', online: true },
    { id: 'p-macpro', name: 'MacPro', online: true },
    { id: 'p-macmini', name: 'Macmini', online: true },
  ],
  onSetCounsel: (id, patch) => { patches.push(patch); record = { ...record, ...patch }; draw(); },
  onRenameSession: () => {}, onImportText: () => {}, onSend: () => {}, onAttach: () => {},
  // Where sessions are filed, so the header's folder picker has something to
  // offer and something to tick.
  folders: [
    { id: 'folder:1', name: 'Reading', sessionIds: ['session:1'] },
    { id: 'folder:2', name: 'Later', sessionIds: [] },
  ],
  onPlaceSession: (id, folderId) => { placed.push([id, folderId]); },
  onNewFolderFor: (id) => { placed.push(['new', id]); },
  onTyping: () => {}, onOpenFile: () => {}, onRevealFile: () => {},
  onClearHistory: () => {}, onExportHistory: () => {}, onVoiceCall: () => {}, onVideoCall: () => {},
});

const root = createRoot(document.getElementById('mount'));
const draw = () => root.render(h(ChatPane, props()));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Whether anything inside the menu is painted outside it.
//
// The bug this guards: a note long enough to matter sized its column past the
// menu's own width and drew across the conversation. Measured rather than eyed,
// because "looks fine on my screen" is exactly how it shipped the first time.
const overflowing = () => {
  const m = menu();
  if (!m) return null;
  const box = m.getBoundingClientRect();
  const out = [];
  for (const el of m.querySelectorAll('.agent-pick-name, .agent-pick-note')) {
    const r = el.getBoundingClientRect();
    if (r.right > box.right + 1 || r.left < box.left - 1) {
      out.push({ text: el.textContent.trim().slice(0, 40), right: Math.round(r.right), edge: Math.round(box.right) });
    }
  }
  return out;
};

// Whether a row can actually be pressed, as opposed to merely being drawn.
//
// The other half of the same bug: the menu grew taller than the window and its
// last rows were painted under the composer — present, correct, unclickable.
// elementFromPoint is what the mouse would hit.
const reachable = (name) => {
  const m = menu();
  if (!m) return null;
  const row = [...m.querySelectorAll('.agent-pick')].find(
    (b) => (b.querySelector('.agent-pick-name') || {}).textContent === name
  );
  if (!row) return { found: false };
  row.scrollIntoView({ block: 'nearest' });
  const r = row.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { found: true, disabled: row.disabled, hit: Boolean(hit && row.contains(hit)) };
};

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
    // The turn budget, which exists only while the mode that spends it is
    // chosen. Reported as null the rest of the time rather than left out, so an
    // assertion can tell "not shown" from "the harness forgot to look".
    turns: (() => {
      const el = document.querySelector('.agent-turns-box');
      if (!el) return null;
      return {
        count: el.querySelector('.agent-turns-count').textContent,
        role: el.getAttribute('role'),
        label: el.getAttribute('aria-label'),
        live: el.querySelector('.agent-turns-count').getAttribute('aria-live'),
        // Every child of the menu, by role. The list is what proves nothing in
        // it is a role a menu will not announce.
        stepRoles: [...el.querySelectorAll('.agent-turns-step')].map((b) => b.getAttribute('role')),
        // Whether either end of the range is refusing to go further, which is
        // the whole of what makes this a bounded control rather than a box.
        downOff: el.querySelector('.agent-turns-step').disabled,
        upOff: [...el.querySelectorAll('.agent-turns-step')].pop().disabled,
      };
    })(),
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

  // The mode that keeps going, and the budget that stops it. The stepper appears
  // with the choice rather than sitting greyed out beside the other two modes,
  // so it is worth proving it is actually there and actually bounded.
  click(modes().find((m) => m.querySelector('.agent-pick-name').textContent === 'Between themselves'));
  await wait(60);
  steps.dialogue = state();

  // Down to the floor, one press past it. The second press must do nothing.
  for (let i = 0; i < 6; i += 1) {
    click(document.querySelector('.agent-turns-step'));
    await wait(20);
  }
  steps.turnsFloor = state();

  // And back up, using the keyboard this time — a spinbutton that only answers
  // the mouse is a spinbutton nobody on a keyboard can set.
  key(document.querySelector('.agent-turns-box'), 'ArrowUp');
  await wait(60);
  steps.turnsKeyed = state();

  key(menu(), 'Escape');
  await wait(60);
  steps.escaped = state();

  // Open again, then click somewhere else entirely.
  click(chip());
  await wait(60);
  click(document.querySelector('.messages'));
  await wait(60);
  steps.clickedAway = state();

  // The move-to-folder menu. The one thing about it that cannot be read off the
  // stylesheet is whether it actually escapes the header: the session subtitle
  // clips to one line, and a menu opening out of a clipped box is invisible
  // while being present, correct and in the DOM.
  // (No backticks in here: this whole page is a template literal.)
  const fbtn = document.querySelector('.folder-picker .icon-btn');
  fbtn.click();
  await wait(120);
  const fmenu = document.querySelector('.folder-menu');
  const header = document.querySelector('.chat-header');
  const mr = fmenu.getBoundingClientRect();
  const hr = header.getBoundingClientRect();
  // Spread over state() so the draft-survives-everything loop in the test covers
  // this popup too: opening a menu over the composer must not eat what is typed.
  steps.folderMenu = {
    ...state(),
    folderOpen: Boolean(fmenu),
    items: [...fmenu.querySelectorAll('.folder-item')].map((b) => b.textContent.trim()),
    ticked: [...fmenu.querySelectorAll('[aria-selected="true"] .folder-item-text')].map((n) => n.textContent),
    // Escaped the header rather than being clipped by it, and still on screen.
    belowHeader: mr.bottom > hr.bottom,
    visible: mr.height > 0 && mr.width > 0,
    insideWindow: mr.right <= window.innerWidth + 1 && mr.left >= -1,
    // Before the Upload button, which is where the row's other session action is.
    beforeUpload: (() => {
      const btns = [...document.querySelectorAll('.chat-actions > *')];
      const picker = btns.findIndex((b) => b.classList.contains('folder-picker'));
      return picker === 0 && btns.length > 1;
    })(),
  };
  document.querySelector('.folder-item').click();
  await wait(120);
  steps.folderPicked = {
    ...state(),
    placed: JSON.parse(JSON.stringify(placed)),
    closed: !document.querySelector('.folder-menu'),
  };

  // ---- observing, and the roster it brings with it ----
  //
  // The menu grew two modes, a checkbox under one of them and a list of people.
  // These are the two things that broke when it did, and neither is visible to a
  // test that only reads the DOM.
  chip().click();
  await wait(120);
  record = { ...record, mode: 'observer' };
  draw();
  await wait(160);
  steps.observing = {
    ...state(),
    // Nothing painted outside the card. The list is the offenders, so a failure
    // names the sentence that escaped rather than merely saying one did.
    overflow: overflowing(),
    // The rows the composer was drawn over. Every one of them must be something
    // the mouse can actually hit.
    people: ['Zima', 'MacPro', 'Macmini'].map((n) => ({ name: n, ...reachable(n) })),
    interrupts: reachable('Allow interruptions'),
    // The menu keeps itself inside the window now rather than running past the
    // bottom of it.
    insideWindow: (() => {
      const r = menu().getBoundingClientRect();
      return r.bottom <= window.innerHeight + 1;
    })(),
    scrolls: menu().scrollHeight > menu().clientHeight,
  };

  // Pressing a person emits an invitation rather than a counsel change.
  const before = patches.length;
  const macpro = [...menu().querySelectorAll('.agent-pick')].find(
    (b) => (b.querySelector('.agent-pick-name') || {}).textContent === 'MacPro'
  );
  macpro.scrollIntoView({ block: 'nearest' });
  macpro.click();
  await wait(120);
  // Spread over state() like every other step: the test loops the whole set
  // asserting the half-written question survived each interaction, and inviting
  // somebody is an interaction the composer must live through too.
  steps.invited = { ...state(), patch: patches[before] || null };

  // ---- who may ask ----
  //
  // The rule the menu grew last: three settings, and under the third a tick on
  // each person's own row. Both are laid out beside things that were already
  // tight — a pill on a row whose name can be long, in a card 300px wide — so
  // what is measured here is the part no test of the markup can see: that
  // nothing escapes the card, and that every one of it can be pressed.
  chip().click();
  await wait(120);
  record = {
    ...record,
    asking: 'chosen',
    members: [
      { peerId: 'p-zima', name: 'Zima', state: 'joined', ask: true },
      { peerId: 'p-macpro', name: 'MacPro', state: 'joined', ask: false },
      { peerId: 'p-macmini', name: 'Macmini', state: 'invited', ask: false },
    ],
  };
  draw();
  await wait(160);
  const pill = (name) => {
    const row = [...menu().querySelectorAll('.agent-person')].find(
      (li) => (li.querySelector('.agent-pick-name') || {}).textContent === name
    );
    if (!row) return { found: false };
    const btn = row.querySelector('.agent-ask');
    if (!btn) return { found: true, pill: false };
    btn.scrollIntoView({ block: 'nearest' });
    const r = btn.getBoundingClientRect();
    const box = menu().getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      found: true,
      pill: true,
      checked: btn.getAttribute('aria-checked'),
      label: btn.getAttribute('aria-label'),
      // Inside the card it belongs to, and hittable where it is drawn.
      inside: r.right <= box.right + 1 && r.left >= box.left - 1,
      reachable: Boolean(hit && btn.contains(hit)),
      height: Math.round(r.height),
    };
  };
  steps.asking = {
    ...state(),
    settings: modes()
      .map((r) => ({
        name: r.querySelector('.agent-pick-name').textContent,
        checked: r.getAttribute('aria-checked'),
      }))
      .filter((r) => ['Only me', 'Anyone in the room', 'The people I tick'].includes(r.name)),
    // Above the rows whose ticks it governs: a control that makes ticks appear
    // has to come before the things it makes appear.
    beforeRoster: (() => {
      const all = [...menu().children];
      const rule = all.findIndex((li) => li.textContent === 'The people I tick');
      const person = all.findIndex((li) => li.classList.contains('agent-person'));
      return rule > -1 && person > rule;
    })(),
    overflow: overflowing(),
    ticked: pill('Zima'),
    unticked: pill('MacPro'),
    // Somebody who was asked and never answered is not in the room, and a tick
    // beside their name would offer a permission to a person who is not there.
    invited: pill('Macmini'),
    reachableRows: ['Zima', 'MacPro'].map((n) => ({ name: n, ...reachable(n) })),
  };

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
