'use strict';

// Drives the sidebar's four categories in a real browser, mounted for real.
//
// Almost nothing about a category can be checked by reading the component. A
// category opens because a pointer stayed on it for long enough; it shuts
// because the pointer left and did not come back; it stays open because a lock
// was clicked, and that lock has to survive the pointer leaving. The fold itself
// is a grid track animating to the height of contents nobody measured. And the
// flash is a gradient sweeping across text, which is either readable at every
// point in the sweep or it is not — a question about pixels, not about tokens.
//
// So this bundles Sidebar exactly as vite would, mounts it over a roster with
// unread messages in it, and does what a person would do: points at a heading,
// looks away, pins one open, drags one to the top, and leaves an unread message
// waiting behind a shut one.
//
//   node scripts/sidebar-harness.js [outDir]
//
// Note for this sandbox: snap chromium cannot write into /tmp or dot-directories,
// so the working directory has to be somewhere ordinary — see lib/chromium.js.

const fs = require('node:fs');
const path = require('node:path');
const { chromiumPath, render, withScratchDir } = require('./lib/chromium.js');
const { readPng, relativeLuminance } = require('./lib/png.js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer');

const RUN = { width: 1180, height: 760, budget: 8000, args: ['--hide-scrollbars'] };

// Where in the 2.6s sweep each still is taken. The gradient is 260% of the
// title's width, so a single frame only ever shows part of the prism — the
// darkest hue may be off the word entirely at the moment a screenshot lands.
const FRAMES = [0, 650, 1300, 1950, 2599];

function entry() {
  return `
import React from 'react';
import { createRoot } from 'react-dom/client';
import Sidebar from ${JSON.stringify(path.join(SRC, 'components', 'Sidebar.jsx'))};
window.__lanchat = { React, createRoot, Sidebar };
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
<html><head><meta charset="utf-8"><style>${css}
/* The mount point is not the panel — Sidebar renders .sidebar itself, and that
   is the element the app's grid places. */
#side { display: contents; }
</style></head>
<body><div id="root"><div class="app" id="app">
  <div id="side"></div>
  <div class="chat-wrap"></div>
  <aside class="side-panel"></aside>
</div></div>
<script>${bundle}</script>
<script>
const { React, createRoot, Sidebar } = window.__lanchat;
const h = React.createElement;
const FRAMES = ${JSON.stringify(FRAMES)};

// A roster with one of everything the panel can draw: a session, two agents —
// one of them summoned and never opened — five people, and a tailnet device that
// is online without the app.
// Reassigned rather than mutated when a room arrives, the way App.jsx gets a
// whole new list every time main publishes the sessions. A push would leave the
// array identity unchanged, and the panel's memos read exactly that.
// (No backticks in here: this whole page is a template literal.)
let sessions = [
  { id: 's1', title: 'why the turn moved', agentId: 'a1' },
  { id: 's2', title: 'kangkong', agentId: 'a1' },
  { id: 's3', title: 'the third one', agentId: 'a1' },
];
// Where those sessions are filed. Two folders, one with something in it, so the
// walk below has both a populated folder and an empty one to drag between.
let folders = [
  { id: 'folder:1', name: 'Reading', sessionIds: ['s2'] },
  { id: 'folder:2', name: 'Later', sessionIds: [] },
];
const peers = [
  { id: 'a1', kind: 'agent', agentKind: 'acp', name: 'Tessie', online: true, viaName: 'Server' },
  { id: 'a2', kind: 'agent', agentKind: 'acp', name: 'Hermes', online: true, viaName: 'Server' },
  { id: 'p1', name: 'Elijah', hostname: 'elijah-pc', platform: 'win32', online: true },
  { id: 'p2', name: 'Server', hostname: 'server', platform: 'linux', online: true },
  { id: 'p3', name: 'MacPro', hostname: 'macpro', platform: 'darwin', online: false },
  { id: 'p4', name: 'Ana', hostname: 'ana-air', platform: 'darwin', online: true },
  { id: 'p5', name: 'Bo', hostname: 'bo-box', platform: 'linux', online: true },
];
const tailnet = [{ ip: '100.64.0.9', hostname: 'hermes', os: 'linux', online: true, hasApp: false }];

// What App.jsx holds and what it saves, mirrored: the panel is told the config
// and hands back a patch, and the patch is what the next render is drawn from.
let config = { sidebarOrder: ['sessions', 'agents', 'people', 'tailnet'], sidebarLocked: [] };
const saves = [];
let unread = {};
let summoned = {};
let selectedId = 'a1';
// The search box belongs to App now — the middle panel shows what it finds — so
// the panel is told what was typed rather than keeping it to itself.
let search = { q: '', scope: 'all' };

const props = () => ({
  self: { id: 'me', name: 'MacMini', hostname: 'macmini', platform: 'darwin' },
  peers, tailnet, sessions,
  tailnetStatus: { ok: true, reason: null },
  selectedId, unread, summoned,
  queued: {}, authFailures: {}, showAddresses: false,
  sectionOrder: config.sidebarOrder,
  lockedSections: config.sidebarLocked,
  onSectionPrefs: (patch) => { saves.push(patch); config = { ...config, ...patch }; draw(); },
  search,
  onSearch: (patch) => { search = { ...search, ...patch }; draw(); },
  onSelect: (id) => { selectedId = id; unread = { ...unread, [id]: 0 }; draw(); },
  onOpenProfile: () => {}, onOpenDev: () => {}, onOpenSettings: () => {},
  onNewSession: () => {}, onAddPeer: () => {}, onRefresh: () => {}, onNewGroupCall: () => {},
  // Main owns the folder list and pushes it back, so the fixture mutates its own
  // copy and redraws — the same shape onSectionPrefs above uses for the config.
  folders,
  onNewFolder: () => {
    const record = { id: 'folder:' + (folders.length + 1), name: 'New Folder', sessionIds: [] };
    folders = [record, ...folders];
    saves.push({ newFolder: record.id });
    draw();
    return Promise.resolve(record);
  },
  onRenameFolder: (id, name) => {
    folders = folders.map((f) => (f.id === id ? { ...f, name } : f));
    saves.push({ renameFolder: [id, name] });
    draw();
  },
  onDeleteFolder: (id) => {
    folders = folders.filter((f) => f.id !== id);
    saves.push({ deleteFolder: id });
    draw();
  },
  onMoveFolder: (id, toIndex) => {
    const rest = folders.filter((f) => f.id !== id);
    const moving = folders.find((f) => f.id === id);
    rest.splice(Math.max(0, Math.min(toIndex, rest.length)), 0, moving);
    folders = rest;
    saves.push({ moveFolder: [id, toIndex] });
    draw();
  },
  onPlaceSession: (id, folderId, index) => {
    folders = folders.map((f) => ({ ...f, sessionIds: f.sessionIds.filter((x) => x !== id) }));
    if (folderId) {
      folders = folders.map((f) => {
        if (f.id !== folderId) return f;
        const ids = [...f.sessionIds];
        ids.splice(index == null ? ids.length : index, 0, id);
        return { ...f, sessionIds: ids };
      });
    }
    saves.push({ placeSession: [id, folderId, index] });
    draw();
  },
});

const root = createRoot(document.getElementById('side'));
const draw = () => root.render(h(Sidebar, props()));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const REST = 600;

// Every fold, at its final height, immediately.
//
// A transition is interpolated at paint time, and a headless browser on a
// virtual clock hands out timers far more freely than it hands out frames — so a
// category read a second after it opened reports the height it had before it
// started, and one read after it shut still reports the height it had. Measuring
// that would be measuring the harness's own clock.
//
// What the walk below is about is the state machine — which categories are open,
// and why — so the tween is taken out and every measurement is of somewhere the
// panel has actually arrived. The tween itself is pinned in test/layout.test.js,
// where it is a claim about the stylesheet, and it is what the screenshots show.
const noTween = document.createElement('style');
noTween.textContent = '* { transition-duration: 0s !important; transition-delay: 0s !important; }';
document.head.appendChild(noTween);
const settle = async () => { draw(); await wait(REST); };

const sec = (id) => document.querySelector('.sb-section[data-section="' + id + '"]');
const head = (id) => sec(id).querySelector('.sb-head');
const rect = (el) => { const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };

// React synthesises enter/leave from the native over/out pair, so those are what
// a pointer actually arriving looks like from here.
const point = (el) => el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
const away = (el) => el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));

function state() {
  const out = { order: [...document.querySelectorAll('.sb-section')].map((s) => s.dataset.section), sections: {} };
  for (const el of document.querySelectorAll('.sb-section')) {
    const id = el.dataset.section;
    const body = el.querySelector('.sb-body');
    const title = el.querySelector('.sb-title');
    const cs = getComputedStyle(body);
    const ts = getComputedStyle(title);
    out.sections[id] = {
      classes: el.className,
      open: el.classList.contains('open'),
      locked: el.classList.contains('locked'),
      flashing: el.classList.contains('flash'),
      rows: cs.gridTemplateRows,
      rowsPx: Math.round(parseFloat(cs.gridTemplateRows) || 0),
      visibility: cs.visibility,
      rowsShown: el.querySelectorAll('.sb-body-inner .peer').length,
      badge: (el.querySelector('.sb-head .unread-dot') || {}).textContent || null,
      dot: Boolean(el.querySelector('.sb-head .sb-dot')),
      titleSize: ts.fontSize,
      titleWeight: ts.fontWeight,
      titleAnimation: ts.animationName,
      titleImage: ts.backgroundImage === 'none' ? 'none' : 'gradient',
      titleClip: ts.webkitBackgroundClip || ts.backgroundClip,
      // The pinned category has neither grip nor lock — there is no order to
      // move it in and nothing to keep open once the room has ended — so these
      // read null rather than throwing. For the four they are exactly what they
      // always were.
      pinned: el.classList.contains('pinned'),
      headBtn: Boolean(el.querySelector('.sb-head-btn')),
      headExpanded: (el.querySelector('.sb-head-btn') || { getAttribute: () => null }).getAttribute(
        'aria-expanded'
      ),
      lockPressed: (el.querySelector('.sb-lock') || { getAttribute: () => null }).getAttribute(
        'aria-pressed'
      ),
      // The grip, the lock and the roster's buttons are out of the way until
      // the category is being dealt with. :hover cannot be checked from here —
      // a dispatched mouseover moves no real pointer, so the pseudo-class never
      // matches — but :focus-within is the same rule and focus is real.
      // The glass under the title. It only exists while the category is
      // flashing, so on any other heading its content computes to none.
      // (No backticks in here: this whole page is a template literal.)
      plate: (() => {
        const cs = getComputedStyle(el.querySelector('.sb-head'), '::before');
        return {
          present: cs.content !== 'none',
          z: cs.zIndex,
          animation: cs.animationName,
          image: cs.backgroundImage === 'none' ? 'none' : 'gradient',
        };
      })(),
      gripOpacity: el.querySelector('.sb-grip')
        ? Number(getComputedStyle(el.querySelector('.sb-grip')).opacity)
        : null,
      lockOpacity: el.querySelector('.sb-lock')
        ? Number(getComputedStyle(el.querySelector('.sb-lock')).opacity)
        : null,
      actionsOpacity: Number(getComputedStyle(el.querySelector('.sb-actions')).opacity),
      actions: el.querySelectorAll('.sb-actions .icon-btn').length,
      rowTitles: [...el.querySelectorAll('.sb-body-inner .peer .name-text')].map((n) => n.textContent),
      rowsDraggable: [...el.querySelectorAll('.sb-body-inner .peer.session')].map((r) => r.draggable),
      rowSubs: [...el.querySelectorAll('.sb-body-inner .peer .sub')].map((n) => n.textContent),
    };
  }
  // The Sessions list, as folders and what is left over. rowsShown above now
  // counts filed rows too, which widens it rather than breaking it.
  out.folders = [...document.querySelectorAll('.sb-folder')].map((el) => {
    const body = el.querySelector('.sb-body');
    const cs = getComputedStyle(body);
    return {
      id: el.dataset.folder,
      name: (el.querySelector('.folder-name .name-text') || {}).textContent || null,
      editing: Boolean(el.querySelector('.folder-name-input')),
      count: (el.querySelector('.folder-count') || {}).textContent || null,
      open: el.classList.contains('open'),
      classes: el.className,
      rowsPx: Math.round(parseFloat(cs.gridTemplateRows) || 0),
      visibility: cs.visibility,
      headHeight: Math.round(el.querySelector('.folder-head').getBoundingClientRect().height),
      rowIds: [...el.querySelectorAll('.sb-body-inner .peer.session')].map((r) => r.dataset.row),
    };
  });
  // Folders come first inside the Sessions category, then everything in none of
  // them. Read from the DOM rather than from the fixture, so the order asserted
  // is the order drawn.
  const inner = document.querySelector('.sb-section[data-section="sessions"] .sb-body-inner');
  out.sessionsFirstChild = inner && inner.firstElementChild ? inner.firstElementChild.className : null;
  const hint = document.querySelector('.sb-section[data-section="sessions"] .empty-hint');
  out.sessionsHint = hint ? hint.textContent : null;
  out.sessionRowsShown = [...document.querySelectorAll('.sb-section[data-section="sessions"] .peer.session')].map((r) => r.dataset.row);
  const loose = document.querySelector('.loose-sessions');
  out.loose = loose
    ? {
        ids: [...loose.querySelectorAll('.peer.session')].map((r) => r.dataset.row),
        classes: loose.className,
        strip: Boolean(loose.querySelector('.loose-drop')),
      }
    : null;
  return out;
}

// Anything a category drag lets past would land on the app's file-drop sheet.
let reachedApp = 0;
document.getElementById('app').addEventListener('dragover', () => { reachedApp += 1; });

async function walk() {
  const steps = {};
  await settle();
  steps.initial = state();

  // Pointing at People: it opens, and the category holding the open conversation
  // stays open beside it.
  point(head('people'));
  await wait(REST);
  steps.hoverPeople = state();

  // Looking away again: it shuts, on its own, without anything being clicked.
  away(head('people'));
  await wait(REST);
  steps.awayFromPeople = state();

  // Pinning it: the lock is a separate target from the heading, and what it
  // pins has to outlast the pointer that clicked it.
  sec('people').querySelector('.sb-lock').click();
  await wait(REST);
  away(head('people'));
  await wait(REST);
  steps.lockedPeople = state();
  steps.lockedPeople.saved = JSON.parse(JSON.stringify(saves));

  // Dragging the tailnet heading to the top of the panel, over the sessions one.
  const dt = new DataTransfer();
  const before = rect(head('sessions'));
  head('tailnet').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  await wait(60);
  steps.dragging = state();
  sec('sessions').dispatchEvent(new DragEvent('dragover', {
    bubbles: true, dataTransfer: dt, clientX: before.x + 40, clientY: before.y + 2 }));
  await wait(60);
  steps.overSessions = state();
  sec('sessions').dispatchEvent(new DragEvent('drop', {
    bubbles: true, dataTransfer: dt, clientX: before.x + 40, clientY: before.y + 2 }));
  head('tailnet').dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  await wait(REST);
  steps.dropped = state();
  steps.dropped.saved = JSON.parse(JSON.stringify(saves));
  steps.dropped.reachedApp = reachedApp;

  // ---- folders ----------------------------------------------------------
  //
  // Sessions is pinned open first: a folder drag has to survive the pointer
  // wandering, and the walk below dispatches events at elements rather than
  // moving a pointer at all.
  sec('sessions').querySelector('.sb-lock').click();
  await wait(REST);
  steps.foldersAtRest = state();

  const folderHead = (id) => document.querySelector('[data-folder="' + id + '"] .folder-head');
  const row = (id) => document.querySelector('[data-row="' + id + '"]');
  const drag = (el, type, id) => {
    const carried = new DataTransfer();
    carried.setData(type, id);
    el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: carried }));
    return carried;
  };
  const over = (el, dt, atTop) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new DragEvent('dragover', {
      bubbles: true, dataTransfer: dt,
      clientX: r.x + 20, clientY: atTop ? r.y + 2 : r.y + r.height - 2 }));
  };
  const drop = (el, dt, atTop) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new DragEvent('drop', {
      bubbles: true, dataTransfer: dt,
      clientX: r.x + 20, clientY: atTop ? r.y + 2 : r.y + r.height - 2 }));
  };

  // Shutting one. The rows have to genuinely leave, not merely stop being seen.
  folderHead('folder:1').querySelector('.folder-twist').click();
  await wait(REST);
  steps.folderShut = state();
  folderHead('folder:1').querySelector('.folder-twist').click();
  await wait(REST);

  // Carrying a session. The single most important assertion in this file: the
  // category must stay open, or there is nothing left to drop onto.
  let fdt = drag(row('s1'), 'application/x-lanchat-session', 's1');
  await wait(60);
  steps.draggingSession = state();

  over(folderHead('folder:1'), fdt, false);
  await wait(60);
  steps.overFolder = state();

  drop(folderHead('folder:1'), fdt, false);
  row('s1').dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: fdt }));
  await wait(REST);
  steps.droppedIntoFolder = state();
  steps.droppedIntoFolder.reachedApp = reachedApp;

  // Reordering inside the folder: onto the top half of the first row.
  fdt = drag(row('s1'), 'application/x-lanchat-session', 's1');
  await wait(60);
  over(row('s2'), fdt, true);
  await wait(60);
  steps.overRow = state();
  drop(row('s2'), fdt, true);
  row('s1').dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: fdt }));
  await wait(REST);
  steps.reorderedInFolder = state();

  // And back out again, onto the loose region.
  fdt = drag(row('s1'), 'application/x-lanchat-session', 's1');
  await wait(60);
  const looseEl = document.querySelector('.loose-sessions');
  over(looseEl, fdt, false);
  await wait(60);
  steps.overLoose = state();
  drop(looseEl, fdt, false);
  row('s1').dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: fdt }));
  await wait(REST);
  steps.draggedOut = state();
  steps.draggedOut.reachedApp = reachedApp;

  // Carrying a folder: every folder renders shut while one is in the air, so the
  // list of drop targets is a stationary list of heads.
  fdt = drag(folderHead('folder:2'), 'application/x-lanchat-folder', 'folder:2');
  await wait(60);
  steps.draggingFolder = state();
  over(folderHead('folder:1'), fdt, true);
  await wait(60);
  steps.overFolderEdge = state();
  drop(folderHead('folder:1'), fdt, true);
  folderHead('folder:2').dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: fdt }));
  await wait(REST);
  steps.folderReordered = state();
  steps.folderReordered.reachedApp = reachedApp;

  // Renaming, in place. The row must be the same height being typed into as it
  // is being read, or the list jumps every time somebody names a folder.
  const readHeight = state().folders[0].headHeight;
  document.querySelector('.sb-folder .folder-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await wait(REST);
  steps.renaming = state();
  steps.renaming.readHeight = readHeight;
  const input = document.querySelector('.folder-name-input');
  const setText = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setText.call(input, 'Renamed');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
  await wait(REST);
  steps.renamed = state();
  steps.renamed.saved = JSON.parse(JSON.stringify(saves));

  // Searching flattens the lot: a search is a question about sessions, not about
  // where they were filed.
  search = { q: 'kangkong', scope: 'all' };
  await settle();
  steps.flattenedBySearch = state();
  search = { q: '', scope: 'all' };
  await settle();

  // The positive control the reachedApp counter never had. Without it, a zero
  // could mean the listener regressed rather than that nothing leaked.
  const fileDt = new DataTransfer();
  fileDt.items.add(new File(['x'], 'x.txt', { type: 'text/plain' }));
  document.getElementById('app').dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: fileDt }));
  await wait(60);
  steps.appStillListens = reachedApp;

  sec('sessions').querySelector('.sb-lock').click();
  await wait(REST);

  // A message arrives for somebody behind a shut heading. People is unpinned
  // first, so the category it lands in is one that is actually put away.
  sec('people').querySelector('.sb-lock').click();
  await wait(REST);
  unread = { p2: 3 };
  summoned = { a2: true };
  await settle();
  steps.flashing = state();

  // Reading it. Selecting the peer is what App does on a click, and it is the
  // only thing that stops the flash — hovering the category in between did not.
  point(head('people'));
  await wait(REST);
  steps.peeked = state();
  away(head('people'));
  await wait(REST);
  steps.stillFlashing = state();
  document.querySelector('.sb-section[data-section="people"] .sb-body-inner .peer:nth-child(2)').click();
  await wait(REST);
  steps.read = state();

  // The keyboard's half of the reorder, and of the hover. Focusing the grip
  // opens its category the way pointing at it does, and the arrow keys move the
  // category with the focus still on it — so it can be moved twice without
  // going looking for the button again.
  const grip = sec('sessions').querySelector('.sb-grip');
  grip.focus();
  await wait(REST);
  steps.gripFocused = state();
  steps.gripFocused.focusIn = document.activeElement.closest('.sb-section').dataset.section;
  grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await wait(REST);
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await wait(REST);
  steps.gripMoved = state();
  steps.gripMoved.focusIn = document.activeElement.closest('.sb-section').dataset.section;
  steps.gripMoved.saved = JSON.parse(JSON.stringify(saves));

  // Searching. A panel that keeps its lists shut while somebody types a name
  // into the box above them is a search that looks broken, so a category with a
  // match opens itself — and one without stays where it was.
  const box = document.querySelector('.sidebar-search input');
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setValue.call(box, 'eli');
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(REST);
  steps.searched = state();
  steps.searched.matches = [...document.querySelectorAll('.sb-section.open .sb-body-inner .peer .name-text')].map(
    (n) => n.textContent
  );

  // A room somebody else runs, arriving. Nothing is clicked to make this happen:
  // the invitation lands in the list the panel is given, exactly as it does when
  // it comes off a socket, and a category that was not there a moment ago has to
  // appear on its own — at the top, lit, above an arrangement of four the reader
  // made themselves.
  setValue.call(box, '');
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(REST);
  let room = {
    id: 'r1',
    title: 'kitchen wiring',
    hostPeerId: 'p1',
    accepted: false,
    members: [{ peerId: 'p1', state: 'joined' }],
    roomCounsel: [{ id: 'ax', name: 'Mac' }],
  };
  const roomIs = (patch) => {
    room = { ...room, ...patch };
    sessions = sessions.some((s) => s.id === room.id)
      ? sessions.map((s) => (s.id === room.id ? room : s))
      : [...sessions, room];
  };
  roomIs({});
  await settle();
  steps.roomArrived = state();

  // Opened by a click, which is the whole difference between this heading and
  // the four: they are opened by a pointer resting on them on its way past.
  document.querySelector('.sb-section[data-section="shared"] .sb-head-btn').click();
  await wait(REST);
  steps.roomOpened = state();

  // Answering it stops the flash, the same way reading a message does. The
  // category stays: the room is still live, and still not one of yours.
  roomIs({ accepted: true });
  await settle();
  steps.roomAnswered = state();

  // And the host ends it. The heading goes with the room, and the conversation
  // comes back as an ordinary session.
  roomIs({ members: [{ peerId: 'p1', state: 'left' }] });
  await settle();
  steps.roomEnded = state();

  return steps;
}

// One scene, held still, for a screenshot. The flash is paused on a chosen frame
// of its sweep: a running gradient photographed at whatever moment the shutter
// happened to fall proves nothing about the moments it did not.
async function scene(name) {
  await settle();
  if (name === 'hover') {
    point(head('people'));
    await wait(REST);
  }
  if (name === 'locked') {
    sec('agents').querySelector('.sb-lock').click();
    await wait(REST);
    sec('people').querySelector('.sb-lock').click();
    await wait(REST);
    away(head('people'));
    await wait(REST);
  }
  if (name.startsWith('flash')) {
    selectedId = 's1';
    unread = { p2: 3, a1: 1 };
    summoned = { a2: true };
    await settle();
    const delay = FRAMES[Number(name.slice('flash'.length)) || 0];
    const style = document.createElement('style');
    style.textContent = '.sb-section.flash .sb-title { animation-play-state: paused !important;' +
      ' animation-delay: -' + delay + 'ms !important; }';
    document.head.appendChild(style);
    await wait(REST);
  }
  if (name === 'control') {
    // The same word, the same size, unlit — so the measurement below is known to
    // report a sane number on text nobody is worried about.
    selectedId = 's1';
    await settle();
  }
  const out = state();
  const title = document.querySelector('.sb-section[data-section="people"] .sb-title');
  out.titleRect = rect(title);
  return out;
}

const MODE = (location.hash || '#walk').slice(1);
const report = (result) => {
  const pre = document.createElement('pre');
  pre.id = 'result';
  pre.textContent = JSON.stringify(result);
  document.body.appendChild(pre);
};
// A harness that dies silently reports nothing at all, and the caller sees only
// "cannot read properties of null" from a hundred lines away. Whatever went
// wrong comes back through the same channel the findings do.
(MODE === 'walk' ? walk() : scene(MODE)).then(report, (err) => {
  report({ error: String(err && err.stack ? err.stack : err) });
});
</script>
</body></html>`;
}

// The dimmest point of the prism, measured in vertical slices.
//
// The gradient runs across the word, so one contrast figure for the whole title
// would be the contrast of its brightest hue — which is not the one that decides
// whether the word can be read. Each slice is about one hue wide: its brightest
// pixel is the middle of a stroke in that hue, its darkest is the panel behind
// it, and the worst ratio among the slices that contain any ink at all is what
// the title is actually offering a reader.
function dimmestSlice(png, { x, y, w, h }, slice = 6) {
  let worst = Infinity;
  let inked = 0;
  for (let sx = x; sx < x + w; sx += slice) {
    const lums = [];
    for (let py = y; py < y + h; py += 1) {
      for (let px = sx; px < Math.min(sx + slice, x + w); px += 1) {
        if (px < 0 || py < 0 || px >= png.width || py >= png.height) continue;
        lums.push(relativeLuminance(png, (py * png.width + px) * 4));
      }
    }
    if (lums.length < 8) continue;
    lums.sort((a, b) => a - b);
    const back = lums[Math.floor(lums.length * 0.05)];
    const ink = lums[Math.floor(lums.length * 0.98)];
    const ratio = (ink + 0.05) / (back + 0.05);
    // A slice between two letters holds nothing but the panel, and a ratio of
    // about 1 from it would say the title was invisible when it is merely a gap.
    if (ratio < 1.6) continue;
    inked += 1;
    worst = Math.min(worst, ratio);
  }
  return { worst: inked ? worst : 0, slices: inked };
}

async function runSidebarHarness(outDir) {
  const chrome = chromiumPath();
  if (!chrome) return { skipped: 'no chromium on PATH' };
  try {
    require.resolve('esbuild');
  } catch {
    return { skipped: 'no esbuild' };
  }

  return withScratchDir(outDir, 'lanchat-sidebar-', async (dir, keep) => {
    const page = path.join(dir, 'sidebar.html');
    const html = buildPage(dir);
    fs.writeFileSync(page, html);
    // The page is one long template literal, so a stray backtick or a name used
    // twice is a parse error that chromium reports by rendering nothing at all —
    // which arrives here as `null` from a hundred lines away. Checked before the
    // browser is launched, so a typo says it is a typo.
    const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
    const probe = path.join(dir, 'walk-check.js');
    fs.writeFileSync(probe, script);
    try {
      require('node:child_process').execFileSync(process.execPath, ['--check', probe], { stdio: 'pipe' });
    } catch (err) {
      throw new Error('the harness page does not parse:\n' + String(err.stderr || err.message));
    }

    // The walk waits out a dozen folds, one after another. Virtual time makes
    // that cost almost nothing in wall time, but the budget still has to cover
    // it — a page cut off mid-walk reports nothing at all rather than half.
    const steps = render(chrome, dir, page, { ...RUN, budget: 40000 });

    // The scenes, each in its own browser: one run leaves one screenshot behind,
    // and the point of these is to be looked at as well as measured.
    const scenes = {};
    const shots = {};
    for (const name of ['collapsed', 'hover', 'locked', 'control', ...FRAMES.map((_, i) => `flash${i}`)]) {
      const png = path.join(dir, `${name}.png`);
      scenes[name] = render(chrome, dir, `${page}#${name}`, { ...RUN, png });
      shots[name] = png;
    }

    // The prism, at five points across its sweep, against the same word unlit.
    const contrast = {};
    for (const name of Object.keys(scenes)) {
      const img = readPng(shots[name]);
      const box = scenes[name] && scenes[name].titleRect;
      contrast[name] = img && box ? dimmestSlice(img, box) : null;
    }

    // And once more with motion turned off at the browser, which is the only way
    // to see what a reader who has asked for that actually gets.
    const stillPage = `${page}#flash0`;
    const still = render(chrome, dir, stillPage, {
      ...RUN,
      args: [...RUN.args, '--force-prefers-reduced-motion'],
      png: path.join(dir, 'reduced.png'),
    });
    const reduced = {
      titleAnimation: still.sections.people.titleAnimation,
      titleImage: still.sections.people.titleImage,
      badge: still.sections.people.badge,
      contrast: dimmestSlice(readPng(path.join(dir, 'reduced.png')), still.titleRect),
    };

    return { steps, scenes, contrast, reduced, screenshots: keep ? dir : null };
  });
}

module.exports = { runSidebarHarness, buildPage, dimmestSlice };

if (require.main === module) {
  runSidebarHarness(process.argv[2])
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
