'use strict';

// Photographs the find bar, and reads its highlight back out of the picture.
//
// A search marks words inside two very different bubbles: an incoming one on
// --surface, and an outgoing one on --primary, which is a saturated blue. The
// highlight is a warm tint over whichever of those it lands on, and a tint is
// not a colour anybody can reason about — it is the result of compositing, and
// the only honest way to know what it came out as is to look at the pixels a
// browser actually painted.
//
// So this lays the real stylesheet out in headless chromium, screenshots it, and
// measures the contrast between the marked text and the fill behind it in both
// bubbles. Every reading comes with a control: the same sentence unmarked, whose
// contrast the app has always shipped. A method that cannot see the control is
// passing is a method whose answer about the highlight means nothing.
//
// Run it directly to keep the screenshot and look at it:
//
//   node scripts/find-harness.js [outDir]

const fs = require('node:fs');
const path = require('node:path');
const { chromiumPath, render, withScratchDir } = require('./lib/chromium.js');
const { readPng } = require('./flash-harness.js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer');

// Colour is the whole question here, so the profile is pinned the way the flash
// harness pins it.
const RUN = {
  width: 1000,
  height: 620,
  budget: 1500,
  args: ['--force-color-profile=srgb', '--hide-scrollbars'],
};

// The words being measured. Long enough that a mark holds whole glyphs rather
// than a few antialiased edges, which is what makes the pixels readable.
const HIT = 'kangkong';
const AROUND = 'water spinach, also called ';

// Mirrors ChatPane and MessageBubble: the bar inside .messages-wrap and above
// .messages, marks inside .bubble .text, one bubble each way. It has to — the
// point of measuring in a browser is that the compositing is real, and a harness
// that nests the marks somewhere else measures a fiction.
function buildPage(cssPath) {
  const css = fs.readFileSync(cssPath || path.join(SRC, 'styles.css'), 'utf8');
  const line = (side) => `
    <div class="bubble-row ${side}"><div class="bubble">
      <div class="text"><span id="plain-${side}">${AROUND}</span><mark class="find-hit" id="hit-${side}">${HIT}</mark>, and <mark class="find-hit current" id="cur-${side}">${HIT}</mark> again.</div>
      <div class="time">01:48 PM</div>
    </div></div>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${css}</style></head>
<body><div id="root"><div class="app">
  <div class="sidebar">
    <div class="me"><div class="avatar">M</div>
      <div class="meta"><div class="name">MacMini</div><div class="sub">macmini · macOS</div></div></div>
  </div>

  <div class="chat-wrap"><div class="chat">
    <div class="chat-header">
      <span class="session-mark large">S</span>
      <div class="meta">
        <div class="name"><span class="peer-name">Kangkong</span>
          <button class="find-btn on" aria-label="Find in this conversation">S</button></div>
        <div class="sub session-sub"><span>Session ·</span><select class="session-agent"><option>Tessie</option></select></div>
      </div>
      <div class="chat-actions">
        <button class="icon-btn">U</button><button class="icon-btn">D</button><button class="icon-btn danger">T</button>
      </div>
    </div>
    <div class="messages-wrap">
      <div class="find-bar" role="search">
        <span class="find-ic">S</span>
        <input class="find-input" value="${HIT}" aria-label="Find in this conversation" />
        <span class="find-count" role="status" id="find-count">4/17</span>
        <button class="icon-btn find-step" aria-label="Previous match">^</button>
        <button class="icon-btn find-step" aria-label="Next match">v</button>
        <button class="icon-btn find-step" aria-label="Close find">x</button>
      </div>
      <div class="messages">
        <div class="day-sep">Today</div>
        ${line('out')}
        ${line('in')}
      </div>
      <div class="typing"></div>
    </div>
    <div class="composer-wrap"><div class="composer">
      <button class="icon-btn">+</button><textarea rows="1" placeholder="Ask Tessie…"></textarea>
      <button class="send-btn">&gt;</button>
    </div></div>
  </div></div>

  <aside class="side-panel"></aside>
</div></div>
<script>
  const measure = () => {
  // The bar slides in. Both the numbers below and the screenshot they are used
  // against have to describe the settled state, so the entry is run to its end
  // rather than caught in flight — headless virtual time advances timers, not
  // the compositor's clock, so waiting would not have been enough.
  document.getAnimations().forEach((a) => a.finish());
  const rect = (id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
             top: Math.round(r.top), bottom: Math.round(r.bottom) };
  };
  const bar = document.querySelector('.find-bar');
  const messages = document.querySelector('.messages');
  const out = {
    marks: Object.fromEntries(['hit-in', 'cur-in', 'plain-in', 'hit-out', 'cur-out', 'plain-out'].map((id) => [id, rect(id)])),
    findBar: bar.getBoundingClientRect().toJSON(),
    // The bar floats: it must sit over the top of the conversation without the
    // conversation having been moved down to make room for it.
    overlaps: bar.getBoundingClientRect().bottom > messages.getBoundingClientRect().top,
    barZ: getComputedStyle(bar).zIndex,
    messagesZ: getComputedStyle(messages).zIndex,
    header: document.querySelector('.chat-header').getBoundingClientRect().toJSON(),
    // The one bit of motion, and the size the counter reserves.
    animation: getComputedStyle(bar).animationName,
    countFont: getComputedStyle(document.getElementById('find-count')).fontVariantNumeric,
  };
  const pre = document.createElement('pre');
  pre.id = 'result';
  pre.textContent = JSON.stringify(out);
  document.body.appendChild(pre);
  };
  setTimeout(measure, 50);
</script>
</body></html>`;
}

// ---- reading a colour back out of a photograph -----------------------------

const srgb = (c) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// The two colours a run of text is made of. The fill is whatever most of the
// box is; the glyph is read off a percentile rather than picked, because the
// palest pixel on the rim of a letter is not what anybody reads, and a method
// that answered with it would flatter every highlight it ever measured.
function inkAndFill(png, box) {
  const counts = new Map();
  const x0 = Math.max(0, box.x);
  const y0 = Math.max(0, box.y);
  const x1 = Math.min(png.width, box.x + box.w);
  const y1 = Math.min(png.height, box.y + box.h);
  let seen = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const at = (y * png.width + x) * 4;
      const key = `${png.data[at]},${png.data[at + 1]},${png.data[at + 2]}`;
      counts.set(key, (counts.get(key) || 0) + 1);
      seen += 1;
    }
  }
  if (!seen) return null;
  const colours = [...counts.entries()].map(([key, n]) => ({ rgb: key.split(',').map(Number), n }));
  const fill = colours.reduce((a, b) => (b.n > a.n ? b : a)).rgb;
  const fillLum = luminance(fill);

  // Antialiasing gives almost every glyph pixel its own colour, so counting
  // colours finds no ink at all — the honest reading is a percentile of how far
  // each pixel is from the fill. Ranked by that distance, the pixel 2% of the
  // way down the box is inside the stroke of a letter rather than on its rim,
  // whatever the glyphs happen to cover.
  const ranked = colours
    .map((c) => ({ ...c, d: Math.abs(luminance(c.rgb) - fillLum) }))
    .sort((a, b) => b.d - a.d);

  let covered = 0;
  let ink = ranked[0];
  for (const colour of ranked) {
    covered += colour.n;
    ink = colour;
    if (covered >= seen * 0.02) break;
  }
  return {
    fill,
    ink: ink.rgb,
    // How much of the box is at least that far from the fill — the share of it
    // that is ink rather than background.
    inkShare: Number((covered / seen).toFixed(3)),
    contrast: Number(contrast(ink.rgb, fill).toFixed(2)),
  };
}

async function runFindHarness(outDir, cssPath) {
  const chrome = chromiumPath();
  if (!chrome) return { skipped: 'no chromium on PATH' };

  return withScratchDir(outDir, 'lanchat-find-', (dir, keep) => {
    const pageFile = path.join(dir, 'find.html');
    fs.writeFileSync(pageFile, buildPage(cssPath));
    const png = path.join(dir, 'find.png');
    const measured = render(chrome, dir, pageFile, { ...RUN, png });

    const shot = readPng(png);
    const colours = {};
    for (const [id, box] of Object.entries(measured.marks)) {
      if (box) colours[id] = inkAndFill(shot, box);
    }
    if (!keep) fs.unlinkSync(png);
    return { ...measured, colours, shot: keep ? png : null, dir: keep ? dir : null };
  });
}

module.exports = { runFindHarness, buildPage };

if (require.main === module) {
  runFindHarness(process.argv[2], process.argv[3])
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
