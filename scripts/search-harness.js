'use strict';

// Drives the search box in a real browser, with everything it talks to mounted.
//
// The search is now three things at once: a filter over the sidebar's four
// categories, a scope that aims it at one of them, and a list of results in the
// middle panel. They have to agree — and the one that cannot be reasoned about
// at all is what happens to the conversation underneath. The results panel lies
// *over* ChatPane rather than replacing it, because the composer keeps the
// message being typed in its own state; whether that actually survives opening
// and closing a search is a question about a mounted React tree, and this is the
// only way to ask it.
//
// So this bundles Sidebar, ChatPane and SearchResults, wires them the way
// App.jsx wires them, and does what a person would do: starts writing a message,
// searches for somebody, narrows it to one category, walks the results with the
// arrow keys, opens one, and comes back.
//
//   node scripts/search-harness.js [outDir]

const fs = require('node:fs');
const path = require('node:path');
const { chromiumPath, render, withScratchDir } = require('./lib/chromium.js');
const { readPng, relativeLuminance } = require('./lib/png.js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer');

const RUN = { width: 1280, height: 800, budget: 40000, args: ['--hide-scrollbars'] };

// Points across the 620ms sweep, bunched at the start. The easing is fast-out,
// so the band has crossed most of the panel in the first third of the timeline;
// spacing these evenly would photograph an empty panel over and over and the
// moment that matters once. What is wanted is the stills where the light is
// under a word, since that is the only time it can cost anybody a reading —
// and each one costs a browser launch, so there are as few as will do.
const SHINE_FRAMES = [20, 60, 95, 125, 165, 240];

function entry() {
  return `
import React from 'react';
import { createRoot } from 'react-dom/client';
import Sidebar from ${JSON.stringify(path.join(SRC, 'components', 'Sidebar.jsx'))};
import ChatPane from ${JSON.stringify(path.join(SRC, 'components', 'ChatPane.jsx'))};
import SearchResults from ${JSON.stringify(path.join(SRC, 'components', 'SearchResults.jsx'))};
window.__lanchat = { React, createRoot, Sidebar, ChatPane, SearchResults };
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
<body><div id="root"></div>
<script>${bundle}</script>
<script>
const { React, createRoot, Sidebar, ChatPane, SearchResults } = window.__lanchat;
const h = React.createElement;

const sessions = [
  { id: 's1', title: 'why the turn moved', agentId: 'a1', createdAt: new Date(2026, 6, 1, 14, 32).getTime() },
  { id: 's2', title: 'kangkong', agentId: 'a1', createdAt: new Date(2025, 10, 23, 9, 5).getTime() },
];
const peers = [
  { id: 'a1', kind: 'agent', agentKind: 'acp', name: 'Tessie', online: true, viaName: 'Server' },
  { id: 'a2', kind: 'agent', agentKind: 'claude', name: 'Hermes', online: true, viaName: 'Server' },
  { id: 'p1', name: 'Elijah', hostname: 'elijah-pc', platform: 'win32', online: true, address: '100.64.0.5:47100' },
  { id: 'p2', name: 'Server', hostname: 'server', platform: 'linux', online: true, address: '100.64.0.7:47100' },
  { id: 'p3', name: 'MacPro', hostname: 'macpro', platform: 'darwin', online: false, address: '100.64.0.8:47100' },
];
const tailnet = [{ ip: '100.64.0.9', hostname: 'hermes-box', os: 'linux', online: true, hasApp: false }];

const messages = [];
for (let i = 0; i < 60; i += 1) {
  messages.push({ id: 'm' + i, ts: Date.now() - (60 - i) * 60000, direction: i % 3 === 0 ? 'out' : 'in',
    kind: 'text', text: 'Message ' + i + ' — an ordinary line of conversation with nothing in it.' });
}

// App.jsx's wiring, and nothing else of App.jsx: the search lives above both
// panels, the results lie over the pane rather than replacing it.
let host = null;
function Host() {
  const [search, setSearch] = React.useState({ q: '', scope: 'all' });
  const [selectedId, setSelectedId] = React.useState('s1');
  const [config, setConfig] = React.useState({ sidebarOrder: ['sessions','agents','people','tailnet'], sidebarLocked: [] });
  const [unread, setUnread] = React.useState({});
  const [summoned, setSummoned] = React.useState({});
  host = { search, setSearch, selectedId, setSelectedId, setUnread, setSummoned, config, setConfig };

  const peer = peers.find((p) => p.id === selectedId) || { id: selectedId, kind: 'session', name: 'why the turn moved', agentId: 'a1' };

  return h('div', { className: 'app' },
    h(Sidebar, {
      self: { id: 'me', name: 'MacMini', hostname: 'macmini', platform: 'darwin' },
      peers, tailnet, sessions,
      tailnetStatus: { ok: true, reason: null },
      selectedId, unread, summoned,
      queued: {}, authFailures: {}, showAddresses: false,
      sectionOrder: config.sidebarOrder,
      lockedSections: config.sidebarLocked,
      onSectionPrefs: (patch) => setConfig((c) => ({ ...c, ...patch })),
      search,
      onSearch: (patch) => setSearch((s) => ({ ...s, ...patch })),
      onSelect: (id) => { setSelectedId(id); setUnread((u) => ({ ...u, [id]: 0 })); },
      onOpenProfile: () => {}, onOpenDev: () => {}, onOpenSettings: () => {},
      onNewSession: () => {}, onAddPeer: () => {}, onRefresh: () => {}, onNewGroupCall: () => {},
    }),
    h('div', { className: 'chat-wrap' },
      h(ChatPane, {
        peer, messages, typing: false, awaiting: false, progress: {},
        agents: [{ id: 'a1', name: 'Tessie' }],
        onSend: () => {}, onAttach: () => {}, onTyping: () => {},
        onOpenFile: () => {}, onRevealFile: () => {}, onOpenLink: () => {},
        onClearHistory: () => {}, onExportHistory: () => {}, onImportText: () => {},
        onRenameSession: () => {}, onSetSessionAgent: () => {}, canFind: true,
      }),
      search.q.trim()
        ? h(SearchResults, {
            search, sessions, peers, tailnet, unread,
            order: config.sidebarOrder,
            onSelect: (id) => { setSelectedId(id); setUnread((u) => ({ ...u, [id]: 0 })); },
            onClose: () => setSearch((s) => ({ ...s, q: '' })),
          })
        : null
    ),
    h('aside', { className: 'side-panel' })
  );
}

const root = createRoot(document.getElementById('root'));
root.render(h(Host));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const REST = 600;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const sec = (id) => $('.sb-section[data-section="' + id + '"]');

// React ignores a plain assignment to a controlled input: the value has to be
// set through the prototype's own setter for its onChange to see it.
const setNative = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
const setNativeArea = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
async function type(el, text) {
  const setter = el.tagName === 'TEXTAREA' ? setNativeArea : setNative;
  setter.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(REST);
}
const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

function sidebarState() {
  const out = {};
  for (const el of $$('.sb-section')) {
    out[el.dataset.section] = {
      open: el.classList.contains('open'),
      quiet: el.classList.contains('quiet'),
      flashing: el.classList.contains('flash'),
      titleColor: getComputedStyle(el.querySelector('.sb-title')).color,
      rows: [...el.querySelectorAll('.sb-body-inner .peer .name-text')].map((n) => n.textContent),
    };
  }
  return out;
}

function resultsState() {
  const panel = $('.search-results');
  if (!panel) return null;
  const shine = $('.search-shine');
  const cs = shine && getComputedStyle(shine);
  return {
    head: $('.results-count').textContent,
    groups: $$('.result-group').map((g) => ({
      title: g.querySelector('.result-group-title').textContent,
      count: g.querySelector('.result-group-count').textContent,
      rows: [...g.querySelectorAll('.result')].map((r) => ({
        name: r.querySelector('.result-name').textContent,
        sub: r.querySelector('.result-sub').textContent,
        why: (r.querySelector('.result-why') || {}).textContent || null,
        marked: [...r.querySelectorAll('.result-hit')].map((m) => m.textContent),
        active: r.classList.contains('active'),
        inert: r.classList.contains('inert'),
      })),
    })),
    // The pane underneath is still mounted, which is the whole reason this is an
    // overlay rather than a replacement.
    paneBelow: Boolean($('.chat-wrap .chat')),
    shine: cs && { animation: cs.animationName, opacity: Number(cs.opacity), transform: cs.transform, z: cs.zIndex },
  };
}

const box = () => $('.sidebar-search input');
const composer = () => $('.composer textarea');
const scroller = () => $('.messages');

async function walk() {
  const steps = {};
  await wait(REST);

  // Something half-written, and a conversation scrolled away from its end. Both
  // must be exactly where they were left when the search closes.
  await type(composer(), 'half a sentence about');
  scroller().scrollTop = 120;
  await wait(REST);
  steps.before = { draft: composer().value, scrollTop: Math.round(scroller().scrollTop) };

  steps.placeholderAll = box().placeholder;

  // A search that reaches everything under the box, including the tailnet
  // device it could never touch before.
  await type(box(), 'hermes');
  steps.searchedHermes = { sidebar: sidebarState(), results: resultsState() };

  // A hit on something the row does not show: an address.
  await type(box(), '100.64.0.5');
  steps.searchedAddress = { sidebar: sidebarState(), results: resultsState() };

  // And on a connector kind.
  await type(box(), 'claude');
  steps.searchedConnector = { sidebar: sidebarState(), results: resultsState() };

  // A message arrives for somebody while the box is aimed elsewhere.
  await type(box(), 'kang');
  host.setUnread({ p1: 2 });
  await wait(REST);
  host.setSearch((s) => ({ ...s, scope: 'sessions' }));
  await wait(REST);
  steps.scopedSessions = {
    sidebar: sidebarState(),
    results: resultsState(),
    placeholder: box().placeholder,
    chip: ($('.scope-name') || {}).textContent || null,
  };

  // The menu is a picture of the panel: same categories, same order.
  $('.scope-chip').click();
  await wait(REST);
  steps.menu = {
    open: Boolean($('.scope-menu')),
    options: $$('.scope-item').map((i) => i.textContent),
    selected: $$('.scope-item.active').map((i) => i.textContent),
  };
  $$('.scope-item')[3].click();
  await wait(REST);
  steps.pickedThird = { scope: host.search.scope, placeholder: box().placeholder };

  // Escape undoes the search one step at a time.
  key(box(), 'Escape');
  await wait(REST);
  steps.escapedOnce = { q: host.search.q, scope: host.search.scope, results: Boolean($('.search-results')) };
  key(box(), 'Escape');
  await wait(REST);
  steps.escapedTwice = { q: host.search.q, scope: host.search.scope };

  // Everything back where it was: same draft, same place in the conversation.
  steps.after = { draft: composer().value, scrollTop: Math.round(scroller().scrollTop) };

  // Walking the results with the keys, then opening one with Enter.
  await type(box(), 'e');
  const first = resultsState();
  key(window, 'ArrowDown');
  await wait(120);
  key(window, 'ArrowDown');
  await wait(REST);
  steps.walked = { firstActive: first.groups[0].rows[0].active, results: resultsState() };
  const target = $$('.result')[2];
  const targetName = target.querySelector('.result-name').textContent;
  key(window, 'Enter');
  await wait(REST);
  steps.opened = {
    targetName,
    selectedId: host.selectedId,
    q: host.search.q,
    results: Boolean($('.search-results')),
    draft: composer().value,
  };

  // A device is not a conversation: clicking one opens nothing.
  await type(box(), 'hermes-box');
  const before = host.selectedId;
  const device = $$('.result').find((r) => r.classList.contains('inert'));
  if (device) device.click();
  await wait(REST);
  steps.clickedDevice = { was: before, now: host.selectedId, wasInert: Boolean(device) };

  return steps;
}

// One scene, held still, for a screenshot and for measuring the light.
async function scene(name) {
  await wait(REST);

  // The freeze goes in *before* the panel exists.
  //
  // A paused animation holds at its own local time, and a negative delay shifts
  // that timeline — so an element told to pause after it has already been
  // running freezes at "however long it ran, plus the delay", which under a
  // virtual clock is a different place every time. Applied first, the band is
  // created paused and lands exactly on the millisecond asked for.
  if (name.startsWith('shine')) {
    const delay = ${JSON.stringify(SHINE_FRAMES)}[Number(name.slice('shine'.length)) || 0];
    const style = document.createElement('style');
    style.textContent = '.search-shine { animation-play-state: paused !important;' +
      ' animation-delay: -' + delay + 'ms !important; }';
    document.head.appendChild(style);
  }

  host.setSearch({ q: 'e', scope: 'all' });
  await wait(REST);

  const out = resultsState();
  const box = (el) => {
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
  };
  out.shineRect = box($('.search-shine'));
  // Every kind of text the light passes under, not only the brightest. The
  // names are --fg and were never in danger; the line under them is --fg-muted
  // and the line under that is dimmer still, and it is the dimmest one that
  // decides how bright the band may be.
  out.textRects = [
    ...$$('.result-name').map((el) => ({ kind: 'name', ...box(el) })),
    // A session's date sits inside .result-name, so the name's own box cannot
    // speak for it: that box is measured by its brightest pixel, and the name is
    // --fg while the date is dimmer by design. Measured as its own box, or the
    // one piece of text in this panel that is allowed to be faint would be the
    // one piece never checked.
    ...$$('.result-name > .session-date').map((el) => ({ kind: 'date', ...box(el) })),
    ...$$('.result-sub').map((el) => ({ kind: 'sub', ...box(el) })),
    ...$$('.result-why').map((el) => ({ kind: 'why', ...box(el) })),
    ...$$('.result-group-title').map((el) => ({ kind: 'group', ...box(el) })),
  ];

  // A strip of the panel with no text in it, at the foot of the list where its
  // bottom padding is. Whatever the band is doing to the background, it is doing
  // it here too — so this is where its brightness can be read off the pixels
  // without a glyph's antialiased edge getting into the number.
  const panel = box($('.search-results'));
  out.probeRect = { x: panel.x + 2, y: panel.y + panel.h - 14, w: panel.w - 4, h: 8 };
  return out;
}

const MODE = (location.hash || '#walk').slice(1);
(MODE === 'walk' ? walk() : scene(MODE)).then((result) => {
  const pre = document.createElement('pre');
  pre.id = 'result';
  pre.textContent = JSON.stringify(result);
  document.body.appendChild(pre);
}).catch((err) => {
  const pre = document.createElement('pre');
  pre.id = 'result';
  pre.textContent = JSON.stringify({ error: String(err && err.stack || err) });
  document.body.appendChild(pre);
});
</script>
</body></html>`;
}

// Luminance percentiles over a rectangle of the screenshot.
function lums(png, { x, y, w, h }) {
  const out = [];
  for (let py = y; py < y + h; py += 1) {
    for (let px = x; px < x + w; px += 1) {
      if (px < 0 || py < 0 || px >= png.width || py >= png.height) continue;
      out.push(relativeLuminance(png, (py * png.width + px) * 4));
    }
  }
  out.sort((a, b) => a - b);
  const at = (p) => out[Math.min(out.length - 1, Math.max(0, Math.floor(out.length * p)))];
  return out.length
    ? { p1: at(0.01), p50: at(0.5), p99: at(0.99), max: out[out.length - 1], n: out.length }
    : null;
}

// Can a result still be read while the light is under it?
//
// Not measured slice by slice the way the sidebar's prism is. That method asks a
// different question — how the *dimmest hue* of a gradient painted on the glyphs
// fares — and it needs the ink and the background to sit side by side in a
// six-pixel column. Here the gradient is behind the text and the text is a name
// at normal weight in a wide box, so most columns hold no ink at all and the
// worst inked column is a glyph's faint edge: it reported 3.2:1 whatever colour
// the band was painted, which is the signature of a number that is not looking
// at the thing being changed.
//
// So the two halves are taken from where each is unambiguous: the band's
// brightness from a strip of panel with no text in it, and the ink from the
// cores of the glyphs. That is the ratio a reader actually gets.
// A word in a wide box is mostly *not* the word. `.result-sub` runs the width of
// the panel and holds "Windows" — well under 1% of its pixels are ink, so a 99th
// percentile of that box lands on the background and every line reported 1.0:1,
// which is the number a measurement gives when it is looking at background twice.
// The glyph core is the brightest pixel in the box, so that is what is taken.
function readability(png, probe, text) {
  const back = lums(png, probe);
  const ink = lums(png, text);
  if (!back || !ink) return null;
  return {
    band: back.max,
    ink: ink.max,
    contrast: (ink.max + 0.05) / (back.max + 0.05),
  };
}

async function runSearchHarness(outDir) {
  const chrome = chromiumPath();
  if (!chrome) return { skipped: 'no chromium on PATH' };
  try {
    require.resolve('esbuild');
  } catch {
    return { skipped: 'no esbuild' };
  }

  return withScratchDir(outDir, 'lanchat-search-', async (dir, keep) => {
    const page = path.join(dir, 'search.html');
    fs.writeFileSync(page, buildPage(dir));

    let retries = 0;
    let steps = render(chrome, dir, page, { ...RUN });
    if (!steps) {
      retries += 1;
      steps = render(chrome, dir, page, { ...RUN });
    }

    // The light, frozen at nine points of its travel, so the frame where it is
    // under a name is measured rather than hoped for.
    const shine = [];
    for (let i = 0; i < SHINE_FRAMES.length; i += 1) {
      const png = path.join(dir, `shine${i}.png`);
      let state = render(chrome, dir, `${page}#shine${i}`, { ...RUN, png });
      // A still is one browser launch, and `npm test` runs several
      // browser-heavy files at once — on a loaded machine a page occasionally
      // comes back with nothing at all rather than with an answer. That is the
      // machine, not the panel, so it is tried once more and the retry is
      // counted: a run that needed one still has to produce the same numbers.
      if (!state) {
        retries += 1;
        state = render(chrome, dir, `${page}#shine${i}`, { ...RUN, png });
      }
      if (!state || state.error) {
        shine.push({ frame: SHINE_FRAMES[i], error: (state && state.error) || 'no answer from the page' });
        continue;
      }
      const img = readPng(png);
      // Every piece of text this still has the band more than half under, so the
      // worst of them is measured rather than the first.
      const band = state.shineRect;
      const overlap = (b) => Math.max(0, Math.min(b.x + b.w, band.x + band.w) - Math.max(b.x, band.x));
      const under = state.textRects.filter((b) => b.w > 8 && overlap(b) > b.w * 0.5);
      shine.push({
        frame: SHINE_FRAMES[i],
        band,
        under: under.map((b) => ({ kind: b.kind, y: b.y })),
        read: img ? under.map((b) => ({ kind: b.kind, ...readability(img, state.probeRect, b) })) : [],
      });
    }

    // And with motion turned off at the browser, where the band must simply
    // never be seen rather than parking across the panel.
    const still = render(chrome, dir, `${page}#shine0`, {
      ...RUN,
      args: [...RUN.args, '--force-prefers-reduced-motion'],
      png: path.join(dir, 'reduced.png'),
    });

    return { steps, shine, retries, reduced: still && still.shine, screenshots: keep ? dir : null };
  });
}

module.exports = { runSearchHarness, buildPage };

if (require.main === module) {
  runSearchHarness(process.argv[2])
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
