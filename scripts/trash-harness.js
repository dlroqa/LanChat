'use strict';

// The Trash, driven the way a person uses it.
//
// What the node tests prove is that main keeps the transcript and hands the two
// lists back correctly. None of that says the feature works: the button has to
// open the panel, deleting has to take the session out of the roster without a
// dialog, "Recover to Sessions" has to put it back where it can be opened
// again, and emptying the Trash has to ask first. All of that is wiring in
// App.jsx and markup in TrashPane.jsx, and all of it is invisible to a test that
// never mounts anything.
//
// So this mounts the real App against a stubbed `window.lanchat` whose trash
// channels behave the way main's do — including republishing both lists on
// every move — and then presses the buttons in order.
//
//   node scripts/trash-harness.js [outDir]
//
// Note for this sandbox: snap chromium cannot write into /tmp or dot-directories,
// so the working directory has to be somewhere ordinary — see lib/chromium.js.

const fs = require('node:fs');
const path = require('node:path');
const { chromiumPath, render, withScratchDir } = require('./lib/chromium.js');
const { readPng } = require('./lib/png.js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer');

const RUN = { width: 1280, height: 820, budget: 20000, args: ['--hide-scrollbars'] };

function entry() {
  return `
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from ${JSON.stringify(path.join(SRC, 'App.jsx'))};
window.__lanchat = { React, createRoot, App };
`;
}

// The music folder is found with `import.meta.glob`, which only Vite builds.
// Nothing here plays anything, so it is stood in for — see resend-harness.js,
// which does the same for the same reason.
const MUSIC_STUB = `
export const TRACKS = {};
export const TRACK_KEYS = [];
export const HAS_TRACK = false;
export const DEFAULT_TRACK = null;
export function trackKey(p) { return p; }
export function trackLabel(k) { return k; }
export function trackUrl() { return null; }
`;

async function buildBundle(dir) {
  const esbuild = require('esbuild');
  const entryFile = path.join(dir, 'entry.jsx');
  const outFile = path.join(dir, 'bundle.js');
  const musicFile = path.join(dir, 'agentMusicTrack.js');
  fs.writeFileSync(entryFile, entry());
  fs.writeFileSync(musicFile, MUSIC_STUB);
  await esbuild.build({
    entryPoints: [entryFile],
    bundle: true,
    outfile: outFile,
    format: 'iife',
    loader: { '.js': 'jsx' },
    define: { 'process.env.NODE_ENV': '"production"' },
    absWorkingDir: ROOT,
    nodePaths: [path.join(ROOT, 'node_modules')],
    logLevel: 'silent',
    plugins: [
      {
        name: 'music-stub',
        setup(build) {
          build.onResolve({ filter: /agentMusicTrack\.js$/ }, () => ({ path: musicFile }));
        },
      },
    ],
  });
  return fs.readFileSync(outFile, 'utf8');
}

async function buildPage(dir) {
  const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');
  const bundle = await buildBundle(dir);

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${css}</style></head>
<body><div id="root"></div>
<script>
// Three sessions, so a Trash with something in it is a list rather than a row.
const SEEDS = [
  { id: 'session:1', title: 'Quakes' },
  { id: 'session:2', title: 'Tides' },
  { id: 'session:3', title: 'Kangkong' },
];

const calls = { deleted: [], restored: [], purged: [], purgedAll: 0, restoredAll: 0 };
const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

// Main's half, as far as the window can tell it apart from the real one: one set
// of records with a deletedAt on the ones that have been thrown away, and both
// lists republished after every move. If App ever relied on its own optimistic
// copy instead of what comes back, this stub would catch it — the events below
// are the only thing that agrees with the buttons.
const records = SEEDS.map((s) => ({
  ...s, agentId: 'agent:tessie', agentIds: ['agent:tessie'], allAgents: false, mode: 'parallel',
  createdAt: Date.parse('2026-08-01T20:00:00Z'), updatedAt: Date.parse('2026-08-01T22:00:00Z'),
}));
const histories = {};
for (const s of SEEDS) {
  histories[s.id] = [
    { id: s.id + '/q1', peerId: s.id, direction: 'out', kind: 'text', text: 'what happened in ' + s.title,
      ts: Date.parse('2026-08-01T22:30:00Z') },
  ];
}

const live = () => records.filter((r) => !r.deletedAt);
const dead = () => records.filter((r) => r.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
const find = (id) => records.find((r) => r.id === id);

let emit = () => {};
const publish = () => { emit('sessions', live()); emit('trash', dead()); };

const noop = () => {};
const nothing = () => Promise.resolve(null);

window.lanchat = {
  getState: () => Promise.resolve({
    identity: { id: 'me', name: 'Me', platform: 'linux' },
    configured: true,
    config: { iceServers: [], muteNotifications: true },
    presence: [],
    peerAgents: {},
  }),
  listSessions: () => Promise.resolve(live()),
  listTrash: () => Promise.resolve(dead()),
  // Notes have a Trash of their own, and it is not the one under test here.
  // Answered so App can mount; empty so nothing of it is in the way.
  listNotes: () => Promise.resolve([]),
  listNoteTrash: () => Promise.resolve([]),
  // Agent tasks, read on boot and empty: not what is under test here.
  listTasks: () => Promise.resolve([]),
  // And the schedules that run them.
  listSchedules: () => Promise.resolve([]),
  deleteSession: (id) => {
    calls.deleted.push(id);
    const r = find(id);
    if (!r || r.deletedAt) return Promise.resolve({ ok: false });
    r.deletedAt = Date.parse('2026-08-02T09:15:00Z');
    publish();
    return Promise.resolve({ ok: true });
  },
  restoreSession: (id) => {
    calls.restored.push(id);
    const r = find(id);
    if (!r || !r.deletedAt) return Promise.resolve(null);
    delete r.deletedAt;
    publish();
    return Promise.resolve(r);
  },
  purgeSession: (id) => {
    calls.purged.push(id);
    const r = find(id);
    if (!r || !r.deletedAt) return Promise.resolve({ ok: false });
    records.splice(records.indexOf(r), 1);
    delete histories[id];
    publish();
    return Promise.resolve({ ok: true });
  },
  restoreAllSessions: () => {
    const n = dead().length;
    calls.restoredAll += 1;
    for (const r of dead()) delete r.deletedAt;
    publish();
    return Promise.resolve({ ok: true, count: n });
  },
  purgeAllSessions: () => {
    const n = dead().length;
    calls.purgedAll += 1;
    for (const r of dead()) { records.splice(records.indexOf(r), 1); delete histories[r.id]; }
    publish();
    return Promise.resolve({ ok: true, count: n });
  },
  askableAgents: () => Promise.resolve([{ id: 'agent:tessie', name: 'Tessie' }]),
  getHistory: (id) => Promise.resolve(histories[id] || []),
  sessionRound: nothing,
  sendChat: nothing,
  purgeMessages: nothing,
  onEvent: (fn) => { emit = (type, payload) => fn({ type, payload }); return noop; },
  setUnread: noop,
  sendTyping: noop,
  setConfig: nothing,
  linkStats: () => Promise.resolve([]),
  dictate: nothing,
  openExternal: noop,
  refresh: noop,
  setCallActive: noop,
  exitPip: noop,
};

// Every confirm is answered yes and recorded, so the questions the app asks can
// be counted. Which of them get asked at all is the point: moving to the Trash
// must not ask, and the two that cannot be undone must.
const asked = [];
window.confirm = (message) => { asked.push(message); return true; };
window.__asked = asked;
window.__calls = calls;
window.__errors = errors;
window.__live = () => live().map((r) => r.title);
window.__dead = () => dead().map((r) => r.title);
</script>
<script>${bundle}</script>
<script>
const { React, createRoot, App } = window.__lanchat;
createRoot(document.getElementById('root')).render(React.createElement(App));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => {
  for (const start = Date.now(); Date.now() - start < ms; ) {
    const v = fn();
    if (v) return v;
    await wait(20);
  }
  return null;
};
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const rect = (el) => { const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };

const trashBtn = () => document.querySelector('.me-actions .icon-btn[aria-pressed]');
// The pane's title, or null when there is no pane. Null-safe on purpose: these
// are polled from the moment a button is clicked, and React has not committed
// anything yet on the first look.
const paneTitle = () => {
  const el = document.querySelector('.chat-header .name');
  return el ? el.textContent : null;
};
const rows = () => [...document.querySelectorAll('.peer.session .name-text, .peer.session .name')]
  .map((n) => n.textContent.trim());

// What the window is showing, in the words on it — so a pane that rendered the
// wrong thing reads as the wrong thing rather than as a missing selector.
function view() {
  const head = document.querySelector('.chat-header');
  const btn = trashBtn();
  const actions = [...document.querySelectorAll('.chat-header .chat-actions .icon-btn')].map((b) => ({
    label: b.getAttribute('aria-label'),
    danger: b.classList.contains('danger'),
    disabled: b.disabled,
  }));
  return {
    title: head ? (head.querySelector('.name') || {}).textContent : null,
    sub: head ? (head.querySelector('.sub') || {}).textContent : null,
    actions,
    sessions: rows(),
    trashRows: [...document.querySelectorAll('.trash-row')].map((r) => ({
      name: r.querySelector('.name').textContent,
      sub: r.querySelector('.sub').textContent,
      restore: (r.querySelector('.trash-restore') || {}).textContent || null,
      canPurge: Boolean(r.querySelector('.icon-btn.danger')),
    })),
    emptyHint: (document.querySelector('.trash-empty') || {}).textContent || null,
    buttonPressed: btn ? btn.getAttribute('aria-pressed') : null,
    buttonCount: btn && btn.querySelector('.trash-count') ? btn.querySelector('.trash-count').textContent : null,
    buttonOn: btn ? btn.classList.contains('on') : null,
    // The toggle is meant to read as selected, the way an open conversation
    // does — and a class with no rule behind it looks identical in the DOM and
    // blank on screen, so the claim has to be settled in pixels.
    //
    // Where the toggle is on screen, so its fill can be read out of the
    // screenshot rather than asked of getComputedStyle. The two disagree here:
    // this page renders the button plainly lit, and the computed value comes
    // back transparent — so the pixels are what gets believed, which is the
    // rule everywhere else in these harnesses anyway.
    buttonRect: btn ? rect(btn) : null,
    // A control from the same row: the Settings button, which is never on. If
    // the two ever measure the same colour, the toggle is saying nothing.
    plainRect: (() => {
      const plain = document.querySelector('.me-actions .icon-btn:not([aria-pressed])');
      return plain ? rect(plain) : null;
    })(),
  };
}

function report(body) {
  const pre = document.createElement('pre');
  pre.id = 'result';
  pre.textContent = JSON.stringify(body);
  document.body.appendChild(pre);
}

async function open(title) {
  const row = await until(() =>
    [...document.querySelectorAll('.peer.session')].find((el) => el.textContent.includes(title))
  );
  if (row) click(row);
  return until(() => document.querySelector('.chat-header'));
}

// The button in a session's header that used to be the end of the session.
async function pressDelete() {
  const btn = await until(() =>
    [...document.querySelectorAll('.chat-header .chat-actions .icon-btn.danger')]
      .find((b) => (b.getAttribute('aria-label') || '').includes('Delete this session'))
  );
  if (btn) click(btn);
  await wait(120);
}

async function openTrash() {
  click(trashBtn());
  await until(() => paneTitle() === 'Trash');
  await wait(60);
}

const MODE = (location.hash || '#walk').slice(1);

async function walk() {
  const steps = {};
  await until(() => document.querySelector('.peer.session'));
  steps.start = view();

  // An empty Trash, opened. Both header actions are there and both are off.
  await openTrash();
  steps.emptyTrash = view();

  // Deleting a session from its own header. No question asked, and the roster
  // loses it while the count on the button picks it up.
  click(trashBtn());
  await open('Quakes');
  steps.inSession = view();
  await pressDelete();
  steps.afterDelete = view();
  steps.afterDelete.asked = [...window.__asked];
  steps.afterDelete.deleted = [...window.__calls.deleted];

  // The Trash with something in it.
  await openTrash();
  steps.oneInTrash = view();

  // And the way back. It puts the session in the roster and opens it, so the
  // panel that was showing the Trash is showing the recovered conversation.
  click(document.querySelector('.trash-row .trash-restore'));
  await until(() => paneTitle() && paneTitle() !== 'Trash');
  await wait(80);
  steps.afterRestore = view();
  steps.afterRestore.restored = [...window.__calls.restored];
  steps.afterRestore.live = window.__live();

  // Two more into the Trash, then Delete all — the one action that has to ask.
  await open('Tides');
  await pressDelete();
  await open('Kangkong');
  await pressDelete();
  await openTrash();
  steps.twoInTrash = view();

  const askedBefore = window.__asked.length;
  click([...document.querySelectorAll('.chat-header .chat-actions .icon-btn')]
    .find((b) => (b.getAttribute('aria-label') || '').includes('for good')));
  await until(() => window.__calls.purgedAll > 0);
  await wait(80);
  steps.afterPurgeAll = view();
  steps.afterPurgeAll.askedThen = window.__asked.slice(askedBefore);
  steps.afterPurgeAll.live = window.__live();
  steps.afterPurgeAll.dead = window.__dead();

  steps.errors = window.__errors;
  return steps;
}

// One scene, held still, for a screenshot.
async function scene(name) {
  await until(() => document.querySelector('.peer.session'));
  if (name === 'empty') await openTrash();
  if (name === 'full') {
    for (const title of ['Quakes', 'Tides']) {
      await open(title);
      await pressDelete();
    }
    await openTrash();
  }
  await wait(150);
  return view();
}

(MODE === 'walk' ? walk() : scene(MODE)).then(report).catch((e) => report({ threw: String(e) }));
</script>
</body></html>`;
}

// The colour a button is filled with, read off the picture.
//
// The corners rather than the middle: the middle of an icon button is the icon,
// and the glyph's own colour says nothing about whether the button behind it is
// lit. Four pixels a little way in from each corner are inside the rounded fill
// and clear of the stroke.
function fillOf(png, { x, y, w, h }, inset = 5) {
  const at = (px, py) => {
    const i = (py * png.width + px) * 4;
    return [png.data[i], png.data[i + 1], png.data[i + 2]];
  };
  const picks = [
    at(x + inset, y + inset),
    at(x + w - inset, y + inset),
    at(x + inset, y + h - inset),
    at(x + w - inset, y + h - inset),
  ];
  return picks[0].map((_, i) => Math.round(picks.reduce((s, p) => s + p[i], 0) / picks.length));
}

async function runTrashHarness(outDir) {
  const chrome = chromiumPath();
  if (!chrome) return { skipped: 'no chromium on PATH' };
  try {
    require.resolve('esbuild');
  } catch {
    return { skipped: 'no esbuild' };
  }

  return withScratchDir(outDir, 'lanchat-trash-', async (dir, keep) => {
    const page = path.join(dir, 'trash.html');
    fs.writeFileSync(page, await buildPage(dir));

    const steps = render(chrome, dir, page, RUN);

    // The scenes, each in its own browser, each leaving a picture behind: the
    // point of these is to be looked at as well as measured.
    const scenes = {};
    const fills = {};
    for (const name of ['empty', 'full']) {
      const png = path.join(dir, `${name}.png`);
      scenes[name] = render(chrome, dir, `${page}#${name}`, { ...RUN, png });
      const img = readPng(png);
      fills[name] = {
        on: img && scenes[name].buttonRect ? fillOf(img, scenes[name].buttonRect) : null,
        plain: img && scenes[name].plainRect ? fillOf(img, scenes[name].plainRect) : null,
      };
    }
    return { steps, scenes, fills, screenshots: keep ? dir : null };
  });
}

module.exports = { runTrashHarness, buildPage };

if (require.main === module) {
  runTrashHarness(process.argv[2])
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
