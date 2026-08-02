'use strict';

// The whole of it, done the way a person does it.
//
// The decision is pinned in test/resendLink.test.js and the way the bubble
// leaves is pinned by retire-harness.js. Neither of those touches the wiring in
// App.jsx — the link being made by the button, armed by the send, and spent by
// the event that comes back — and that wiring is the part with somewhere to go
// wrong: a link armed after the round trip instead of before it, an event read
// from the wrong field, a removal that leaves the message on disk.
//
// So this mounts the real App against a stubbed `window.lanchat` and does what
// the screenshot did: presses re-send on a question nothing answered, sends it
// again, and lets the answer arrive. What comes back is what is on screen
// afterwards and what main was asked to delete.
//
//   node scripts/resend-harness.js [outDir]
//
// Note for this sandbox: snap chromium cannot write into /tmp or dot-directories,
// so the working directory has to be somewhere ordinary — see lib/chromium.js.

const fs = require('node:fs');
const path = require('node:path');
const { chromiumPath, render, withScratchDir } = require('./lib/chromium.js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer');

const RUN = { width: 1280, height: 820, budget: 12000, args: ['--hide-scrollbars'] };

function entry() {
  return `
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from ${JSON.stringify(path.join(SRC, 'App.jsx'))};
window.__lanchat = { React, createRoot, App };
`;
}

// The one thing in the renderer that only Vite can build: the music folder is
// found with `import.meta.glob`, which esbuild leaves as written and the browser
// then calls as a function that is not there. Standing in for it here rather
// than reaching for Vite, because none of it is on the way to a bubble — the
// exports below are the whole of what App.jsx reads from it, with nothing to
// play, which is also what a clone without the audio builds to.
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
  const ASKED = 'I want you to check the latest earthquake around the world';

  // The stub goes in before the bundle: App reads window.lanchat as its module
  // body runs, so it has to be there already.
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${css}</style></head>
<body><div id="root"></div>
<script>
const ASKED = ${JSON.stringify(ASKED)};

// Two sessions, so the three things worth proving can be done in one browser:
// the answered re-send in the first, and in the second a run that came back with
// nothing and then a restore that was never sent.
const SESSIONS = [
  { id: 'session:1', title: 'Quakes' },
  { id: 'session:2', title: 'Tides' },
];

// Everything main was asked to do, in order, so the removal can be checked
// against the disk as well as against the screen.
const calls = { purge: [], sent: [], history: [] };
const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

// Each thread as history has it: one question, asked, and marked by main as one
// nothing came back from.
const histories = {};
for (const s of SESSIONS) {
  histories[s.id] = [
    { id: s.id + '/q1', peerId: s.id, direction: 'out', kind: 'text', text: ASKED,
      ts: Date.parse('2026-08-01T22:30:00Z'), failed: true },
  ];
}

let emit = () => {};
let sends = 0;

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
  listSessions: () => Promise.resolve(SESSIONS.map((s) => ({
    ...s, agentIds: ['agent:tessie'], mode: 'parallel', createdAt: Date.parse('2026-08-01T20:00:00Z'),
  }))),
  // Read on boot beside listSessions. Empty: this harness is about what a
  // question does after it is re-sent, and the Trash has nothing to say about
  // that — but the call has to be answerable, or App throws before it mounts.
  listTrash: () => Promise.resolve([]),
  // The Task Bar's notes, read on boot for the same reason and empty for the
  // same one: this harness has nothing to say about them, and an unanswerable
  // call throws before App mounts.
  listNotes: () => Promise.resolve([]),
  listNoteTrash: () => Promise.resolve([]),
  askableAgents: () => Promise.resolve([{ id: 'agent:tessie', name: 'Tessie' }]),
  getHistory: (id) => { calls.history.push(id); return Promise.resolve(histories[id] || []); },
  sessionRound: nothing,
  // The send main really does: a new message with a new id, which is the whole
  // reason the old one needs a link to it.
  sendChat: (peerId, text) => {
    calls.sent.push({ peerId, text });
    const msg = { id: peerId + '/n' + (sends += 1), peerId, direction: 'out', kind: 'text', text, ts: Date.now(), delivered: true };
    histories[peerId] = [...(histories[peerId] || []), msg];
    return Promise.resolve(msg);
  },
  purgeMessages: (id, ids) => {
    calls.purge.push({ id, ids });
    histories[id] = (histories[id] || []).filter((m) => !ids.includes(m.id));
    return Promise.resolve({ ok: true, removed: ids.length });
  },
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

// The event main sends when the round is over, in the shape sessions/index.js
// publishes it — the closing view, plus the failedRef it carries only when the
// whole round came back with nothing.
window.__round = (sessionId, extra) => emit('session-round', {
  id: 'r1', sessionId, mode: 'parallel', open: false, messageId: sessionId + '/n1',
  asked: [{ agentId: 'agent:tessie', name: 'Tessie' }],
  running: [], answered: [], failed: [], empty: [], missed: [], next: [], failedRef: null,
  ...extra,
});
window.__history = (id) => (histories[id] || []).map((m) => m.id);
window.__calls = calls;
window.__errors = errors;
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

// What the conversation holds, by what each bubble says about itself.
const thread = () => [...document.querySelectorAll('.messages .bubble-row')].map((row) => ({
  text: (row.querySelector('.text') || {}).textContent || null,
  failed: Boolean(row.querySelector('.failed-mark')),
  dissolving: row.classList.contains('dissolving'),
  animation: getComputedStyle(row).animationName,
  resendable: Boolean(row.querySelector('.bubble-resend')),
}));

// Whatever happens, the page reports. A driver that threw half-way and left no
// <pre> behind is indistinguishable from a browser that never started, and the
// difference is the whole of what went wrong.
function report(body) {
  const pre = document.createElement('pre');
  pre.id = 'result';
  pre.textContent = JSON.stringify(body);
  document.body.appendChild(pre);
}

// Opening one of the sessions in the sidebar, by its name.
async function open(title) {
  const row = await until(() =>
    [...document.querySelectorAll('.peer.session')].find((el) => el.textContent.includes(title))
  );
  if (row) click(row);
  return until(() => document.querySelector('.messages .bubble-row'));
}

// Pressing the button on the question that failed.
async function pressResend() {
  const button = await until(() => document.querySelector('.bubble-resend'));
  if (button) click(button);
  const box = await until(() => {
    const el = document.querySelector('textarea[aria-label="Message"]');
    return el && el.value ? el : null;
  });
  return box ? box.value : null;
}

// And sending what it put there.
async function pressSend() {
  const before = window.__calls.sent.length;
  const send = await until(() => {
    const el = document.querySelector('.send-btn');
    return el && !el.disabled ? el : null;
  });
  if (send) click(send);
  await until(() => window.__calls.sent.length > before);
  await wait(60);
}

(async () => {
  const steps = {};

  // --- answered: the sequence in the screenshot ---
  //
  // Everything here is what somebody looking at it would do next.
  await open('Quakes');
  steps.opened = thread();
  steps.restored = await pressResend();
  steps.afterRestore = thread();
  await pressSend();
  steps.afterSend = thread();

  // The second run comes back with an answer. In a session it is the closing
  // round that says so — one agent of three answering finishes nothing.
  window.__round('session:1', { answered: ['agent:tessie'] });
  await wait(80);
  // Caught mid-removal: the old question should be coming apart, not already
  // gone. This is the frame the whole feature is about.
  steps.going = thread();
  await wait(900);
  steps.settled = thread();
  steps.leftOnDisk = window.__history('session:1');

  // --- came back with nothing: the old question stays ---
  await open('Tides');
  await pressResend();
  await pressSend();
  window.__round('session:2', { answered: [], empty: ['agent:tessie'] });
  await wait(900);
  steps.afterEmpty = thread();

  // --- restored and never sent: nothing may be retired on its behalf ---
  //
  // Straight after the empty run above, so this also proves the link that run
  // spent cannot be spent twice.
  await pressResend();
  window.__round('session:2', { answered: ['agent:tessie'] });
  await wait(900);
  steps.afterUnsent = thread();
  steps.tidesOnDisk = window.__history('session:2');

  report({ ...steps, calls: window.__calls, errors: window.__errors, asked: ASKED });
})().catch((e) => report({ threw: String((e && e.stack) || e), errors: window.__errors }));
</script></body></html>`;
}

async function runResendHarness(outDir) {
  const chrome = chromiumPath();
  if (!chrome) return { skipped: 'no chromium on this machine' };

  return withScratchDir(outDir, 'lanchat-resend-', async (dir, keep) => {
    const page = path.join(dir, 'page.html');
    fs.writeFileSync(page, await buildPage(dir));
    const result = render(chrome, dir, page, {
      ...RUN,
      ...(keep && { png: path.join(dir, 'resend.png') }),
    });
    if (!result) return { skipped: 'the page produced no result' };
    return { ...result, dir: keep ? dir : null };
  });
}

module.exports = { runResendHarness, buildPage };

if (require.main === module) {
  runResendHarness(process.argv[2])
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
