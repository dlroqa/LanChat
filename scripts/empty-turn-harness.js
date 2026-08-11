'use strict';

// A turn with nothing in it, erasing itself — driven through the real App.
//
// The rule about which bubbles may go is pinned in test/emptyTurn.test.js, where
// it is a pure function and can be asked a hundred questions in a millisecond.
// What that cannot show is the part with a clock in it: a message arriving,
// being counted down in front of somebody, coming apart, and leaving the disk —
// and, just as important, the message beside it that does none of those things.
//
// So this drives the whole seam: the real App against a stubbed `window.lanchat`,
// two `chat` events pushed at it the way main pushes them, and the assertion
// that exactly one of the two is purged.
//
//   node scripts/empty-turn-harness.js [outDir]

const fs = require('node:fs');
const path = require('node:path');
const { chromiumPath, render, withScratchDir } = require('./lib/chromium.js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer');
const RUN = { width: 1280, height: 900, budget: 20000, args: ['--hide-scrollbars'] };

// The music module finds its tracks with import.meta.glob, which is Vite's and
// which esbuild leaves as written. Stood in for exactly as invite-harness.js
// does — none of it is on the way to a transcript.
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
// One shared session, the kind these lines are said in. The history starts empty
// and the two answers arrive as chat events, which is how main delivers them.
const record = {
  id: 'session:1', title: 'will it rain',
  agentIds: ['agent:mac', 'agent:zima'], allAgents: false, mode: 'dialogue', turns: 6,
  members: [], observer: { level: 'balanced', protective: false }, hostPeerId: null,
  createdAt: Date.now(),
};
const purged = [];
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
    presence: [],
    peerAgents: {},
  }),
  listSessions: () => Promise.resolve([record]),
  listTrash: () => Promise.resolve([]),
  listFolders: () => Promise.resolve([]),
  listNotes: () => Promise.resolve([]),
  listNoteTrash: () => Promise.resolve([]),
  listTasks: () => Promise.resolve([]),
  listSchedules: () => Promise.resolve([]),
  askableAgents: () => Promise.resolve([
    { id: 'agent:mac', name: 'Mac', ready: true },
    { id: 'agent:zima', name: 'Zima', ready: true },
  ]),
  getHistory: () => Promise.resolve([]),
  sessionRound: nothing,
  sessionShelf: () => Promise.resolve([]),
  sessionFloor: nothing,
  // The only call this harness is really about: what the window asks main to
  // take off the disk, and for which messages.
  purgeMessages: (id, ids) => { purged.push({ id, ids }); return Promise.resolve({ ok: true, removed: ids.length }); },
  onEvent: (fn) => { emit = (type, payload) => fn({ type, payload }); return noop; },
  setUnread: noop, sendTyping: noop, setConfig: nothing, linkStats: () => Promise.resolve([]),
  dictate: nothing, openExternal: noop, refresh: noop, setCallActive: noop, exitPip: noop,
  sendChat: nothing, shelfAction: nothing, floorAction: nothing,
};
window.__purged = purged;
window.__errors = errors;
window.__say = (msg) => emit('chat', msg);
</script>
<script>${bundle}</script>
<script>
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
const until = async (fn, ms = 8000) => {
  for (const start = Date.now(); Date.now() - start < ms; ) {
    const v = fn();
    if (v) return v;
    await wait(25);
  }
  return null;
};
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

// A bubble by its message id, and what the app is saying about it. By id rather
// than by the words in it: one of these two messages ends with the other one's
// entire text, which is the whole point of the pair.
const readBubble = (id) => {
  const el = document.querySelector('.bubble-row[data-speaking-id="' + id + '"]');
  if (!el) return null;
  return {
    erasing: el.classList.contains('erasing'),
    dissolving: el.classList.contains('dissolving'),
    caption: (el.querySelector('.bubble-erase') || {}).textContent || null,
    text: (el.querySelector('.bubble-text') || el.querySelector('.bubble') || {}).textContent || '',
  };
};

function report(body) {
  const pre = document.createElement('pre');
  pre.id = 'result';
  pre.textContent = JSON.stringify(body);
  document.body.appendChild(pre);
}

// The two answers, as main delivers them into a session: an agent's words, with
// the attribution main stamps on them.
const CLOSER = [
  "The answer's been given and independently verified - no rain for Brentwood through Thursday.",
  'Two agents confirming the same zero is where this one closes.',
  '',
  'nothing further.',
].join('\\n');

(async () => {
  const out = { mountError };
  try {
    if (mountError) throw new Error('App did not mount');
    const row = await until(() =>
      [...document.querySelectorAll('.peer.session')].find((el) => el.textContent.includes('will it rain'))
    );
    out.foundSession = Boolean(row);
    if (!row) throw new Error('the session row never appeared');
    click(row);
    await wait(300);

    // Zima's real answer, which happens to end on the closing line, and Mac's
    // bare one. Both are agent turns in the same room, arriving the same way.
    window.__say({ id: 'keep-me', peerId: 'session:1', direction: 'in', kind: 'text',
      text: CLOSER, ts: Date.now(), speaker: 'Zima', agentId: 'agent:zima' });
    window.__say({ id: 'erase-me', peerId: 'session:1', direction: 'in', kind: 'text',
      text: 'nothing further.', ts: Date.now() + 1, speaker: 'Mac', agentId: 'agent:mac' });

    // What each of them is doing a moment after arriving. One is counting down
    // in the open; the other is a message like any other.
    const counting = await until(() => {
      const b = readBubble('erase-me');
      return b && b.caption ? b : null;
    }, 4000);
    out.emptyAtFirst = counting;
    out.keptAtFirst = readBubble('keep-me');

    // Long enough for four seconds and the dissolve, with room to spare.
    await wait(6000);
    out.emptyAfter = readBubble('erase-me');
    out.keptAfter = readBubble('keep-me');
    out.purged = window.__purged;
    out.bubbles = [...document.querySelectorAll('.bubble-row')].length;
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

async function runEmptyTurnHarness(outDir) {
  const chrome = chromiumPath();
  if (!chrome) return { skipped: 'no chromium on this machine' };
  return withScratchDir(outDir, 'lanchat-empty-', async (dir, keep) => {
    const page = path.join(dir, 'page.html');
    fs.writeFileSync(page, await buildPage(dir));
    const result = render(chrome, dir, page, RUN);
    if (!result) return { skipped: 'the page produced no result' };
    return { ...result, dir: keep ? dir : null };
  });
}

module.exports = { runEmptyTurnHarness };

if (require.main === module) {
  runEmptyTurnHarness(process.argv[2])
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
