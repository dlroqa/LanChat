'use strict';

// Measures the window's frame in a real browser.
//
// The app is three columns of scrolling panels inside a grid that is exactly as
// tall as the window. Whether the compose box is on screen, whether the peer list
// stops at the sidebar's bottom edge, and how wide each column ends up at a given
// window size are all decided by track sizing and by which flex children are
// allowed to shrink. None of that can be checked by reading the stylesheet — a
// rule can be present and still be overridden three tracks up — and a DOM
// stand-in would be measuring our own guess at the answer.
//
// So this builds a page holding the real stylesheet and the real markup with a
// long conversation and a long peer list in it, lays it out in headless chromium
// at several window sizes, and reports the geometry. Run it directly to also drop
// screenshots somewhere you can look at them:
//
//   node scripts/layout-harness.js [outDir]
//
// Pass a stylesheet to measure something other than the current one — this is how
// the fix was shown to be the fix, by running the harness against the styles as
// they were before it:
//
//   git show HEAD:src/renderer/styles.css > /somewhere/before.css
//   node scripts/layout-harness.js ~/out /somewhere/before.css

const fs = require('node:fs');
const path = require('node:path');
const { chromiumPath, render, withScratchDir } = require('./lib/chromium.js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer');

// The sizes worth knowing about: the smallest window the main process will allow
// (main.js sets minWidth/minHeight), the default it opens at, and two larger ones
// either side of where the side panel stops growing.
const SIZES = [
  { name: 'min', width: 820, height: 560 },
  { name: 'default', width: 1120, height: 740 },
  { name: 'wide', width: 1440, height: 900 },
  { name: 'widest', width: 1920, height: 1080 },
];

// Enough conversation and enough peers to overflow every panel at every size —
// the bug this exists to catch only appears once the content is taller than the
// window, because until then the row is big enough by accident.
const MESSAGES = 120;
const PEERS = 40;

// A status phrase long enough to be shrinking rather than sitting at the 17px
// cap, so the connection panel's type scale is observable. --label-fit is a
// calc() over a clamp(), and an unregistered custom property computes to its
// token stream rather than to a length — reading it back would hand you the
// expression as text. The font size it produces is both measurable and the
// thing anyone actually cares about.
const PROBE = 'Searching for every call site of resolveAgentApproval in the renderer';

function peerRow(i) {
  return `<div class="peer${i === 0 ? ' active' : ''}">
      <div class="avatar">P</div>
      <div class="meta"><div class="name"><span class="name-text">Peer ${i}</span></div>
      <div class="sub">macOS</div></div></div>`;
}

function bubble(i) {
  const side = i % 3 === 0 ? 'out' : 'in';
  return `<div class="bubble-row ${side}"><div class="bubble"><div class="text">Message ${i} — a line of conversation long enough to take a little width.</div></div></div>`;
}

// Mirrors App.jsx: sidebar, chat-wrap > chat > header + messages-wrap + composer,
// and the side panel. It has to. The whole point of measuring in a browser is
// that the geometry is real, and a harness that nests things differently from the
// components measures a fiction.
function buildPage(cssPath) {
  const css = fs.readFileSync(cssPath || path.join(SRC, 'styles.css'), 'utf8');

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${css}</style></head>
<body><div id="root"><div class="app">
  <div class="sidebar">
    <div class="me"><div class="avatar">M</div>
      <div class="meta"><div class="name">MacMini</div><div class="sub">macmini · macOS</div></div></div>
    <div class="sidebar-search"><input placeholder="Search people" /></div>
    <div class="peer-list">
      <div class="section-label">People</div>
      ${Array.from({ length: PEERS }, (_, i) => peerRow(i)).join('\n')}
    </div>
  </div>

  <div class="chat-wrap">
    <div class="chat">
      <div class="chat-header"><div class="avatar">H</div>
        <div class="meta"><div class="name">Hermes</div><div class="sub">Agent · shared by MacAir</div></div></div>
      <div class="messages-wrap">
        <div class="messages">
          ${Array.from({ length: MESSAGES }, (_, i) => bubble(i)).join('\n')}
        </div>
        <div class="typing"></div>
      </div>
      <div class="composer-wrap">
        <div class="composer">
          <button class="icon-btn">+</button>
          <textarea rows="1" placeholder="Type a message…"></textarea>
          <button class="send-btn">&gt;</button>
        </div>
      </div>
    </div>
  </div>

  <aside class="side-panel">
    <div class="agent-state"><span class="agent-state-label" style="--len:${PROBE.length}">${PROBE}</span></div>
  </aside>
</div></div>
<script>
  const rect = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
             top: Math.round(r.top), bottom: Math.round(r.bottom) };
  };

  const messages = document.querySelector('.messages');
  const peers = document.querySelector('.peer-list');
  const panel = document.querySelector('.side-panel');
  const out = {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    composer: rect('.composer-wrap'),
    messages: rect('.messages'),
    sidebar: rect('.sidebar'),
    chatWrap: rect('.chat-wrap'),
    sidePanel: panel && getComputedStyle(panel).display === 'none' ? null : rect('.side-panel'),
    peerList: rect('.peer-list'),
    // The scrollers must actually be scrolling. Otherwise a pass could mean
    // nothing more than that there was too little content to overflow anything,
    // which is the one case the bug does not show up in.
    messagesScrolls: messages.scrollHeight > messages.clientHeight + 1,
    peersScroll: peers.scrollHeight > peers.clientHeight + 1,
    // Nothing may extend the page itself. body is overflow:hidden, so anything
    // that does is content that has been pushed out of reach.
    pageOverflow: Math.round(document.documentElement.scrollHeight - window.innerHeight),
    textareaMaxHeight: getComputedStyle(document.querySelector('.composer textarea')).maxHeight,
    // The connection panel's type scale, as it lands on a phrase of a known
    // length, and whether the row it sits in still holds its fixed height.
    labelFontSize: parseFloat(getComputedStyle(document.querySelector('.agent-state-label')).fontSize),
    labelRow: rect('.agent-state'),
  };

  const pre = document.createElement('pre');
  pre.id = 'result';
  pre.textContent = JSON.stringify(out);
  document.body.appendChild(pre);
</script>
</body></html>`;
}

// The page does not vary by size — the window size is a browser flag, not
// markup — so it is written once and every size loads the same file.
async function runLayoutHarness(outDir, cssPath) {
  const chrome = chromiumPath();
  if (!chrome) return { skipped: 'no chromium on PATH' };

  return withScratchDir(outDir, 'lanchat-layout-', (dir, keep) => {
    const pageFile = path.join(dir, 'layout.html');
    fs.writeFileSync(pageFile, buildPage(cssPath));

    const sizes = {};
    for (const size of SIZES) {
      // One launch per size, measuring and — when the run is being kept to look
      // at — photographing the same layout. A launch is about three seconds and
      // everything else in here is milliseconds, so the count is the cost.
      sizes[size.name] = render(chrome, dir, pageFile, {
        width: size.width,
        height: size.height,
        args: ['--hide-scrollbars'],
        png: keep ? path.join(dir, `layout-${size.name}.png`) : null,
      });
    }
    return { sizes, dir: keep ? dir : null };
  });
}

module.exports = { runLayoutHarness, buildPage };

if (require.main === module) {
  runLayoutHarness(process.argv[2], process.argv[3])
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
