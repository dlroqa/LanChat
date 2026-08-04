'use strict';

// Dragging a file into the window, and — the part that was broken — changing
// your mind about it.
//
// The sheet that says "Drop to send" is raised by a drag over the window. What
// nothing could check by reading App.jsx is when it comes down again: a
// `dragleave` fires for every element the pointer crosses on its way across the
// window, so a sheet that believed them would flicker, and a sheet that waited
// for the one that means "gone" would wait forever, because the file carried
// back out of the window is announced by nothing else. Getting that wrong left
// the sheet up over Sessions, Agents and People until the app was restarted.
//
// So this mounts the real App against a stubbed `window.lanchat` with a person,
// an agent and a session on the roster, and drags a real file over it with real
// DragEvents: in, across two panels, back out again, and away without a word.
// Then it opens each conversation in turn and looks for the sheet.
//
//   node scripts/drop-harness.js [outDir]
//
// Note for this sandbox: snap chromium cannot write into /tmp or dot-directories,
// so the working directory has to be somewhere ordinary — see lib/chromium.js.

const fs = require('node:fs');
const path = require('node:path');
const { chromiumPath, render, withScratchDir } = require('./lib/chromium.js');

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
// Nothing here plays anything, so it is stood in for — the same stub the trash
// and resend harnesses use, for the same reason.
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
// One of each kind of conversation, because the complaint was that the sheet
// followed the window from one to the next.
const PEERS = [
  { id: 'p1', name: 'MacAir', hostname: 'MacAir', platform: 'macOS', online: true, address: '100.0.0.2' },
  { id: 'agent:tessie', name: 'Tessie', kind: 'agent', agentKind: 'hermes', platform: 'linux',
    online: true, address: '100.0.0.3' },
];
const SESSIONS = [
  { id: 'session:1', title: 'Research about Ebola', agentId: 'agent:tessie', agentIds: ['agent:tessie'],
    allAgents: false, mode: 'parallel',
    createdAt: Date.parse('2026-08-02T20:00:00Z'), updatedAt: Date.parse('2026-08-02T22:00:00Z') },
];

const calls = { sentFiles: [], readDocs: [] };
const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

const noop = () => {};
const nothing = () => Promise.resolve(null);

window.lanchat = {
  getState: () => Promise.resolve({
    identity: { id: 'me', name: 'Macmini', platform: 'linux' },
    configured: true,
    config: { iceServers: [], muteNotifications: true },
    presence: PEERS,
    peerAgents: {},
  }),
  listSessions: () => Promise.resolve(SESSIONS),
  listTrash: () => Promise.resolve([]),
  listNotes: () => Promise.resolve([]),
  listNoteTrash: () => Promise.resolve([]),
  listTasks: () => Promise.resolve([]),
  listSchedules: () => Promise.resolve([]),
  askableAgents: () => Promise.resolve([{ id: 'agent:tessie', name: 'Tessie' }]),
  getHistory: () => Promise.resolve([]),
  // The two ends of a drop. main resolves the path of a dropped File since
  // Electron 32 removed file.path, so the stub answers the same way.
  getPathForFile: (f) => '/home/agent/' + f.name,
  sendFilePaths: (id, paths) => { calls.sentFiles.push({ id: id, paths: paths }); return Promise.resolve({ ok: true }); },
  readDocuments: (paths) => {
    calls.readDocs.push(paths);
    return Promise.resolve(paths.map((p) => ({ path: p, name: p.split('/').pop(), text: 'hello' })));
  },
  sessionRound: nothing,
  sendChat: nothing,
  purgeMessages: nothing,
  exportHistory: nothing,
  onEvent: () => noop,
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

// A drag carrying one real file, so \`types\` says 'Files' the way the window's
// own guard requires.
function fileDrag() {
  const dt = new DataTransfer();
  dt.items.add(new File(['# notes'], 'notes.txt', { type: 'text/plain' }));
  return dt;
}
const drag = (el, type, dt) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));

// What the sheet says, or null when there is no sheet. The words matter as well
// as its presence: they name the conversation the file would land in.
const sheet = () => {
  const el = document.querySelector('.drop-overlay');
  return el ? el.textContent.trim() : null;
};

const chat = () => document.querySelector('.chat-wrap');
const panel = () => document.querySelector('.sidebar') || document.querySelector('.side');

// By the name on the row and nothing else. Matching anywhere in a row's text
// picks the session out of the roster when its subtitle lists the agent it asks.
const row = (name) =>
  [...document.querySelectorAll('.peer')].find((el) => {
    const label = el.querySelector('.name-text') || el.querySelector('.name');
    return label && label.textContent.trim() === name;
  });

// Which conversation is open, so a sheet that is absent is absent from a room
// somebody is actually standing in.
const title = () => {
  const el = document.querySelector('.chat-header .name');
  return el ? el.textContent.trim() : null;
};

async function open(name) {
  const el = await until(() => row(name));
  if (el) click(el);
  await wait(80);
  return { open: title(), sheet: sheet() };
}

function report(body) {
  const pre = document.createElement('pre');
  pre.id = 'result';
  pre.textContent = JSON.stringify(body);
  document.body.appendChild(pre);
}

async function walk() {
  const steps = {};
  await until(() => row('MacAir'));

  // ---- a person's chat ---------------------------------------------------
  await open('MacAir');
  steps.beforeAnything = sheet();

  const dt = fileDrag();
  drag(chat(), 'dragenter', dt);
  drag(chat(), 'dragover', dt);
  await wait(20);
  steps.overPerson = sheet();

  // Carried across the window: out of the conversation and over the panel. Each
  // crossing fires a dragleave, and the sheet must not blink on any of them —
  // sampled between the two events, which is where a flicker would be.
  drag(chat(), 'dragleave', dt);
  await wait(16);
  steps.midCrossing = sheet();
  drag(panel(), 'dragover', dt);
  await wait(20);
  steps.overPanel = sheet();

  // The crossing as the browser really sends it: leave and enter in one burst,
  // with no dragover behind them because the pointer has come to rest on the
  // boundary. The heartbeat is up to 550ms away, so only the dragenter can hold
  // the sheet up here — this is the sample that says it does.
  drag(panel(), 'dragleave', dt);
  drag(chat(), 'dragenter', dt);
  await wait(300);
  steps.restingAfterCrossing = sheet();

  // ...and back and forth, to be sure a crossing never accumulates.
  for (let i = 0; i < 3; i += 1) {
    drag(chat(), 'dragleave', dt);
    drag(panel(), 'dragenter', dt);
    await wait(16);
    drag(panel(), 'dragover', dt);
    await wait(16);
    drag(panel(), 'dragleave', dt);
    drag(chat(), 'dragenter', dt);
    await wait(16);
    drag(chat(), 'dragover', dt);
    await wait(16);
  }
  steps.afterCrossings = sheet();

  // ---- the change of mind ------------------------------------------------
  // The file is carried back out of the window: one last dragleave, and then
  // nothing at all. This is the report — the sheet has to go away by itself.
  drag(chat(), 'dragleave', dt);
  await wait(60);
  steps.justAfterLeaving = sheet();
  await wait(400);
  steps.afterLeaving = sheet();

  // And it must stay gone in every other room: Sessions, Agents, People.
  steps.thenSession = await open('Research about Ebola');
  steps.thenAgent = await open('Tessie');
  steps.thenPerson = await open('MacAir');

  // ---- the drag that stops without a word --------------------------------
  // Esc during a drag, or a drop into some other application: no dragleave, no
  // dragend, nothing. Only the silence says the drag is over.
  drag(chat(), 'dragenter', dt);
  drag(chat(), 'dragover', dt);
  await wait(20);
  steps.overAgain = sheet();
  await wait(1500);
  steps.afterSilence = sheet();

  // ---- and it still works ------------------------------------------------
  // A sheet that cannot get stuck is no use if the drop stopped working. Over
  // the agent, the words change to what a document does there.
  await open('Tessie');
  const overAgent = fileDrag();
  drag(chat(), 'dragenter', overAgent);
  drag(chat(), 'dragover', overAgent);
  await wait(20);
  steps.overAgent = sheet();

  await open('MacAir');
  const dropped = fileDrag();
  drag(chat(), 'dragenter', dropped);
  drag(chat(), 'dragover', dropped);
  await wait(20);
  drag(chat(), 'drop', dropped);
  await wait(80);
  steps.afterDrop = sheet();
  steps.sentFiles = window.__calls.sentFiles;

  steps.errors = window.__errors;
  return steps;
}

// One scene for a screenshot: the sheet up over a person's chat, with a file
// still held over the window.
//
// The heartbeat has to run until the shutter, which is the end of the virtual
// time budget rather than the moment this returns — a drag that stopped here
// would have put the sheet away by then, and the picture would be of an empty
// conversation. Which is the fix working, but not what the picture is for.
async function scene() {
  await until(() => row('MacAir'));
  await open('MacAir');
  const dt = fileDrag();
  drag(chat(), 'dragenter', dt);
  drag(chat(), 'dragover', dt);
  setInterval(() => drag(chat(), 'dragover', dt), 100);
  await wait(300);
  return { sheet: sheet() };
}

const MODE = (location.hash || '#walk').slice(1);
(MODE === 'walk' ? walk() : scene()).then(report).catch((e) => report({ threw: String(e) }));
</script>
</body></html>`;
}

async function runDropHarness(outDir) {
  const chrome = chromiumPath();
  if (!chrome) return { skipped: 'no chromium on PATH' };
  try {
    require.resolve('esbuild');
  } catch {
    return { skipped: 'no esbuild' };
  }

  return withScratchDir(outDir, 'lanchat-drop-', async (dir, keep) => {
    const page = path.join(dir, 'drop.html');
    fs.writeFileSync(page, await buildPage(dir));

    const steps = render(chrome, dir, page, RUN);
    // The sheet as a person sees it, in one picture beside the measurements.
    const png = path.join(dir, 'sheet.png');
    const shot = render(chrome, dir, `${page}#scene`, { ...RUN, png });
    return { steps, shot, screenshots: keep ? dir : null };
  });
}

module.exports = { runDropHarness, buildPage };

if (require.main === module) {
  runDropHarness(process.argv[2])
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
