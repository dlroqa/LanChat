'use strict';

// Inviting somebody into a session, driven through the real App.
//
// This exists because of a bug the picker's own harness could not see. That one
// mounts ChatPane and hands it `members` directly, so it proved the menu draws a
// roster, reports a tick, and emits the right patch — all true, and all beside
// the point. The card App builds for the pane is written field by field, and
// `members` was not one of the fields, so in the running app the roster was
// always empty and nothing could ever tick.
//
// The seam that broke is App → card → picker → patch → App → main, so that is
// what this drives: the real App against a stubbed `window.lanchat`, a real
// click on a real row, and the assertion that the tick comes back.
//
//   node scripts/invite-harness.js [outDir]

const fs = require('node:fs');
const path = require('node:path');
const { chromiumPath, render, withScratchDir } = require('./lib/chromium.js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer');
const RUN = { width: 1280, height: 900, budget: 12000, args: ['--hide-scrollbars'] };

// The music module finds its tracks with import.meta.glob, which is Vite's and
// which esbuild leaves as written — the browser then calls a function that is
// not there and the whole bundle fails to evaluate. Stood in for here exactly as
// scripts/resend-harness.js does, because none of it is on the way to a roster.
const MUSIC_STUB = `
export const TRACKS = {};
export const TRACK_KEYS = [];
export const HAS_TRACK = false;
export const DEFAULT_TRACK = null;
export function trackKey(p) { return p; }
export function trackLabel(k) { return k; }
export function trackUrl() { return null; }
`;

function entry() {
  return `
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from ${JSON.stringify(path.join(SRC, 'App.jsx'))};
window.__lanchat = { React, createRoot, App };
`;
}

async function buildBundle(dir) {
  const esbuild = require('esbuild');
  const entryFile = path.join(dir, 'entry.jsx');
  const outFile = path.join(dir, 'bundle.js');
  const musicFile = path.join(dir, 'music-stub.js');
  fs.writeFileSync(musicFile, MUSIC_STUB);
  fs.writeFileSync(entryFile, entry());
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
// One observed session, and two people online. The record is what main holds;
// inviting somebody edits it there and republishes, exactly as ipc.js does.
let record = {
  id: 'session:1', title: 'where to put the lock',
  agentIds: ['agent:tessie'], allAgents: false, mode: 'observer', turns: 6,
  members: [], observer: { level: 'balanced', protective: false }, hostPeerId: null,
  createdAt: Date.now(),
};
const calls = [];
const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

let emit = () => {};
const noop = () => {};
const nothing = () => Promise.resolve(null);

window.lanchat = {
  getState: () => Promise.resolve({
    identity: { id: 'me', name: 'Me', platform: 'linux' },
    configured: true,
    config: { iceServers: [], muteNotifications: true },
    // Two people online, which is what a roster is built from.
    presence: [
      { id: 'p-zima', name: 'Zima', online: true, platform: 'darwin' },
      { id: 'p-macmini', name: 'Macmini', online: true, platform: 'darwin' },
    ],
    peerAgents: {},
  }),
  listSessions: () => Promise.resolve([record]),
  listTrash: () => Promise.resolve([]),
  listFolders: () => Promise.resolve([]),
  listNotes: () => Promise.resolve([]),
  listNoteTrash: () => Promise.resolve([]),
  listTasks: () => Promise.resolve([]),
  listSchedules: () => Promise.resolve([]),
  askableAgents: () => Promise.resolve([{ id: 'agent:tessie', name: 'Tessie', ready: true }]),
  getHistory: () => Promise.resolve([]),
  sessionRound: nothing,
  sessionShelf: () => Promise.resolve([]),
  sessionFloor: nothing,
  // What main really does: the roster is edited on the record and the whole
  // list is published back, which is the path App is supposed to render from.
  inviteToSession: (id, peerId) => {
    calls.push({ call: 'invite', id, peerId });
    record = { ...record, members: [...record.members, { peerId, name: null, state: 'invited', at: Date.now() }] };
    emit('sessions', [record]);
    return Promise.resolve(true);
  },
  removeFromSession: (id, peerId) => {
    calls.push({ call: 'remove', id, peerId });
    record = { ...record, members: record.members.filter((m) => m.peerId !== peerId) };
    emit('sessions', [record]);
    return Promise.resolve(true);
  },
  setSessionCounsel: (patch) => {
    calls.push({ call: 'counsel', patch });
    return Promise.resolve(record);
  },
  onEvent: (fn) => { emit = (type, payload) => fn({ type, payload }); return noop; },
  setUnread: noop, sendTyping: noop, setConfig: nothing, linkStats: () => Promise.resolve([]),
  dictate: nothing, openExternal: noop, refresh: noop, setCallActive: noop, exitPip: noop,
  sendChat: nothing, shelfAction: nothing, floorAction: nothing,
};
window.__calls = calls;
window.__errors = errors;
window.__joined = () => record.members.map((m) => m.peerId + ':' + m.state);
</script>
<script>${bundle}</script>
<script>
// Everything below is defensive on purpose.
//
// A bundle that throws while evaluating leaves window.__lanchat undefined, and
// destructuring it aborts this whole block — so the page ends with no result and
// the failure looks exactly like a browser that never started. That is the least
// useful thing a harness can do, so every step reports instead of throwing.
let mountError = null;
const bundleLoaded = Boolean(window.__lanchat && window.__lanchat.App);
const React = bundleLoaded ? window.__lanchat.React : null;
const createRoot = bundleLoaded ? window.__lanchat.createRoot : null;
const App = bundleLoaded ? window.__lanchat.App : null;
if (!bundleLoaded) {
  mountError = 'the bundle did not evaluate: ' + JSON.stringify(window.__errors || []);
} else {
  try {
    createRoot(document.getElementById('root')).render(React.createElement(App));
  } catch (err) {
    mountError = String((err && err.stack) || err);
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => {
  for (const start = Date.now(); Date.now() - start < ms; ) {
    const v = fn();
    if (v) return v;
    await wait(25);
  }
  return null;
};
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

const menu = () => document.querySelector('.agent-menu');
const personRow = (name) =>
  [...(menu() ? menu().querySelectorAll('.agent-pick') : [])].find(
    (b) => (b.querySelector('.agent-pick-name') || {}).textContent === name
  );

function report(body) {
  const pre = document.createElement('pre');
  pre.id = 'result';
  pre.textContent = JSON.stringify(body);
  document.body.appendChild(pre);
}

(async () => {
  const out = { mountError };
  try {
    if (mountError) throw new Error('App did not mount');
    // Into the session, then open the menu.
    // The sidebar row for a session, by the class the sidebar really uses — see
    // scripts/resend-harness.js, which opens one the same way.
    const row = await until(() =>
      [...document.querySelectorAll('.peer.session')].find((el) =>
        el.textContent.includes('where to put the lock')
      )
    );
    out.foundSession = Boolean(row);
    if (!row) throw new Error('the session row never appeared');
    click(row);
    await wait(250);
    const chip = await until(() => document.querySelector('.agent-chip'));
    out.foundChip = Boolean(chip);
    if (!chip) throw new Error('the agents chip never appeared');
    click(chip);
    await wait(250);

    const before = personRow('Zima');
    out.rosterDrawn = Boolean(before);
    out.beforeChecked = before ? before.getAttribute('aria-checked') : null;
    out.beforeNote = before ? (before.querySelector('.agent-pick-note') || {}).textContent : null;

    // The click a person actually makes.
    click(before);
    // The tick has to come back through main's published list, which is the
    // whole path that was broken: the record gained a member and the card the
    // pane is handed did not carry it.
    const ticked = await until(() => {
      const r = personRow('Zima');
      return r && r.getAttribute('aria-checked') === 'true' ? r : null;
    }, 4000);
    out.afterChecked = ticked ? 'true' : (personRow('Zima') || {}).getAttribute?.('aria-checked') || null;
    out.afterNote = (personRow('Zima')?.querySelector('.agent-pick-note') || {}).textContent || null;
    out.calls = window.__calls;
    out.members = window.__joined();
    out.errors = window.__errors;
  } catch (err) {
    out.threw = String((err && err.message) || err);
    out.errors = window.__errors;
  }
  report(out);
})();
</script>
</body></html>`;
}

async function runInviteHarness(outDir) {
  const chrome = chromiumPath();
  if (!chrome) return { skipped: 'no chromium on this machine' };
  return withScratchDir(outDir, 'lanchat-invite-', async (dir, keep) => {
    const page = path.join(dir, 'page.html');
    fs.writeFileSync(page, await buildPage(dir));
    const result = render(chrome, dir, page, RUN);
    if (!result) return { skipped: 'the page produced no result' };
    return { ...result, dir: keep ? dir : null };
  });
}

module.exports = { runInviteHarness };

if (require.main === module) {
  runInviteHarness(process.argv[2])
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
