'use strict';

// Drives the read-aloud transport's row in a real browser.
//
// Two promises were made about that row and neither can be checked by reasoning
// about the code:
//
//   1. **The synthesising bar has not moved.** A meter needs vertical room and
//      the row had three pixels of it, so the slot grew — but the bar inside it
//      has to land on exactly the pixel it landed on before, or a feature that
//      was meant to add something has quietly moved something else. This reports
//      the bar's top relative to the buttons above it, which is the number to
//      compare against a checkout of main.
//   2. **The row never changes height.** The bar and the meter alternate turn by
//      turn for the whole of a reading, and if the slot resized as they swapped,
//      the note below it would shift a dozen times in one discussion.
//
// It also proves the meter actually draws: the canvas is read back and its
// pixels counted, so a loop that runs and paints nothing cannot pass.
//
//   node scripts/meter-harness.js [outDir]

const fs = require('node:fs');
const path = require('node:path');
const { chromiumPath, render, withScratchDir } = require('./lib/chromium.js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer');

// Wide enough for the side panel to exist at all: below 980px the whole column
// is display:none, and geometry measured inside a hidden column is zeroes that
// make every assertion pass for the wrong reason.
const RUN = { width: 1280, height: 1040, budget: 6000, args: ['--hide-scrollbars'] };

function entry() {
  return `
import React from 'react';
import { createRoot } from 'react-dom/client';
import ConnectionPanel from ${JSON.stringify(path.join(SRC, 'components', 'ConnectionPanel.jsx'))};
window.__lanchat = { React, createRoot, ConnectionPanel };
`;
}

async function buildBundle(dir) {
  const esbuild = require('esbuild');
  const entryFile = path.join(dir, 'entry.jsx');
  const outFile = path.join(dir, 'bundle.js');
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
  });
  return fs.readFileSync(outFile, 'utf8');
}

function buildPage(bundle) {
  const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');

  // Transitions are settled rather than travelled: under a virtual time budget a
  // CSS transition never advances, so an opacity read through one comes back at
  // its starting value forever. The rules deciding the value are still the real
  // ones — only the journey to it is removed. Animations are left alone, because
  // the meter's own loop is the thing being watched.
  const settle = `* { transition: none !important; }`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${css}</style><style>${settle}</style></head>
<body><div id="root" class="app">
  <aside class="side-panel" id="panel"></aside>
</div>
<pre id="result"></pre>
<script>${bundle}</script>
<script>
const { React, createRoot, ConnectionPanel } = window.__lanchat;
const h = React.createElement;
const $ = (sel) => document.querySelector(sel);

// The meter's loop is endless by design — it runs for as long as a voice is
// speaking — and an endless loop under --virtual-time-budget spends the whole
// budget the instant it starts, freezing the page on the frame it began. Left to
// real frames it is worse than that: how many arrive before a measurement is a
// race, and a harness that sometimes reads an unpainted canvas proves nothing.
//
// So the frames are queued here and run by hand. The component asks for the next
// one exactly as it does in the app; this decides when it gets it, which makes
// the number of frames behind every measurement a fact rather than a hope.
let queued = [];
let asked = 0;
window.requestAnimationFrame = (cb) => {
  queued.push(cb);
  asked += 1;
  return queued.length;
};
window.cancelAnimationFrame = () => {};
const pump = (n) => {
  for (let i = 0; i < n; i += 1) {
    const batch = queued;
    queued = [];
    if (!batch.length) return i;
    for (const cb of batch) cb(i * 16);
  }
  return n;
};

const SESSION = {
  id: 'session:1', kind: 'session', name: 'New Session', online: true,
  mode: 'dialogue', agentNames: ['Mac', 'Zima', 'Tessie'], agentId: 'agent-7', agentName: 'Mac',
};

// A voice, as the analyser would report one: energy in the low mid, falling away
// above, and a waveform that actually swings. Fake, but shaped the way real
// speech is — a flat buffer would let a broken bin mapping through.
let phase = 0;
const meter = {
  face: () => 'signal',
  bins: () => 1024,
  samples: () => 2048,
  rate: () => 48000,
  word: () => 3,
  read(freq, time) {
    phase += 0.35;
    if (freq) {
      for (let i = 0; i < freq.length; i += 1) {
        const at = i / freq.length;
        const hump = Math.exp(-((at - 0.06) * (at - 0.06)) / 0.004);
        const detail = 0.5 + 0.5 * Math.sin(i * 0.4 + phase);
        freq[i] = Math.min(255, Math.round(255 * hump * detail));
      }
    }
    if (time) {
      for (let i = 0; i < time.length; i += 1) {
        const v = Math.sin(i * 0.012 + phase) * (0.55 + 0.45 * Math.sin(i * 0.0016)) * 0.85;
        time[i] = Math.round(128 + v * 127);
      }
    }
    return true;
  },
};

const panel = createRoot($('#panel'));
const base = {
  playing: false, paused: false, pending: false, prefetch: null,
  position: 3, count: 12, engine: 'gemini', meter,
  onToggle: () => {}, onNext: () => {}, onPrev: () => {},
};
const draw = (speech) => new Promise((r) => {
  queued = [];
  asked = 0;
  panel.render(h(ConnectionPanel, {
    peer: SESSION, stats: null, agentStatus: null,
    awaiting: false, typing: false, streaming: false, commits: 1,
    speech: { ...base, ...speech },
  }));
  // A timer for React to commit and run its effects, then the frames, by hand.
  // Twenty-four is enough for the decay to settle, so what is measured is the
  // meter at rest on a steady signal rather than mid-attack.
  setTimeout(() => {
    pump(24);
    r();
  }, 0);
});

// The bar's top, measured from the bottom of the buttons above it. Relative
// rather than absolute so it can be compared with a checkout of main without the
// rest of the panel having to be identical.
const barOffset = () => {
  const row = $('.transport-row').getBoundingClientRect();
  const bar = $('.transport-load').getBoundingClientRect();
  return Math.round((bar.top - row.bottom) * 100) / 100;
};
const rowHeight = () => Math.round($('.conn-transport').getBoundingClientRect().height * 100) / 100;
const seen = (el) => (el ? Number(getComputedStyle(el).opacity) : null);

const out = {};
(async () => {
  // ---- at rest: nothing being read ----
  await draw({});
  out.barOffsetAtRest = barOffset();
  out.barHeight = Math.round($('.transport-load').getBoundingClientRect().height * 100) / 100;
  out.rowAtRest = rowHeight();
  out.loadSeenAtRest = seen($('.transport-load'));
  out.meterSeenAtRest = seen($('.transport-meter'));

  // ---- a turn being synthesised: the bar's own state ----
  await draw({ playing: true, pending: true });
  out.barOffsetPending = barOffset();
  out.rowPending = rowHeight();
  out.loadSeenPending = seen($('.transport-load'));
  out.meterSeenPending = seen($('.transport-meter'));

  // ---- the whole session being prepared ahead of play ----
  await draw({ playing: true, prefetch: { done: 3, total: 12 } });
  out.rowPrefetch = rowHeight();
  out.loadSeenPrefetch = seen($('.transport-load'));
  out.meterSeenPrefetch = seen($('.transport-meter'));

  // ---- a voice actually speaking ----
  await draw({ playing: true });
  // How many frames the meter asked for while a voice was speaking. Many means
  // the loop ran; exactly one means the still frame a window that asked for less
  // motion gets instead.
  out.framesWhileSpeaking = asked;
  out.barOffsetSpeaking = barOffset();
  out.rowSpeaking = rowHeight();
  out.loadSeenSpeaking = seen($('.transport-load'));
  out.meterSeenSpeaking = seen($('.transport-meter'));

  const cv = $('.transport-meter');
  if (cv) {
    const box = cv.getBoundingClientRect();
    const bar = $('.transport-load').getBoundingClientRect();
    // Behind the buttons, and clear of the card's edge. Both are the point of
    // where it sits: the graph is a backdrop, and a spike that reached the
    // border would read as the card sprouting rather than as a graph inside it.
    const card = $('.conn-transport').getBoundingClientRect();
    const row = $('.transport-row').getBoundingClientRect();
    out.meterBehindButtons = box.top < row.bottom;
    out.meterClearOfCardTop = Math.round(box.top - card.top);
    out.meterInsideCard = box.bottom <= card.bottom;
    out.meterCoversBar = box.top <= bar.top && box.bottom >= bar.bottom;
    out.meterHeight = Math.round(box.height * 100) / 100;
    out.meterBacked = cv.width > 0 && cv.height > 0;

    // What was actually painted. A loop that runs and draws nothing would pass
    // every other check here.
    const ctx = cv.getContext('2d');
    const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let lit = 0;
    const hues = new Set();
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 40) continue;
      lit += 1;
      hues.add(px[i] + ',' + px[i + 1] + ',' + px[i + 2]);
    }
    out.meterLitPixels = lit;
    out.meterInk = Math.round((lit / (cv.width * cv.height)) * 1000) / 10;
    out.meterColours = hues.size;

    // The spectrum sits above the waveform, and the waveform is the one colour
    // not on the ramp — so the lower lane should be dominated by the cyan.
    const cyanIn = (y0, y1) => {
      const band = ctx.getImageData(0, y0, cv.width, Math.max(1, y1 - y0)).data;
      let cyan = 0;
      let any = 0;
      for (let i = 0; i < band.length; i += 4) {
        if (band[i + 3] < 40) continue;
        any += 1;
        if (band[i + 2] > band[i] + 30 && band[i + 1] > band[i] + 30) cyan += 1;
      }
      return any ? Math.round((cyan / any) * 100) : 0;
    };
    out.cyanInLowerLane = cyanIn(Math.round(cv.height * 0.7), cv.height);
    out.cyanInUpperLane = cyanIn(0, Math.round(cv.height * 0.5));
  }

  // ---- the platform voice, which has no signal to read ----
  await draw({ playing: true, engine: 'local' });
  out.blindClass = $('.transport-meter').className.includes('blind');
  out.blindSeen = seen($('.transport-meter'));

  // ---- nothing to read: the transport is off, and stays where it is ----
  await draw({ count: 0, position: 0 });
  out.rowEmpty = rowHeight();
  out.emptyDisabled = [...document.querySelectorAll('.transport-btn')].every((b) => b.disabled);

  out.rowHeightConstant =
    new Set([out.rowAtRest, out.rowPending, out.rowPrefetch, out.rowSpeaking, out.rowEmpty]).size === 1;
  out.barNeverMoves =
    new Set([out.barOffsetAtRest, out.barOffsetPending, out.barOffsetSpeaking]).size === 1;
  out.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Left on the state worth photographing. The screenshot is taken when the page
  // stops, so whatever was drawn last is what anybody looking at the picture
  // sees — and the picture is here to show the equalizer, not the empty row.
  await draw({ playing: true });
  const shot = $('.transport-meter').getBoundingClientRect();
  out.meterBox = [
    Math.round(shot.left),
    Math.round(shot.top),
    Math.round(shot.width),
    Math.round(shot.height),
  ];

  $('#result').textContent = JSON.stringify(out, null, 2);
})().catch((err) => {
  // Whatever it managed to measure travels with the failure. A harness that
  // reports only the exception makes every failure a fresh investigation.
  $('#result').textContent = JSON.stringify(
    { ...out, error: String(err && err.stack ? err.stack : err) },
    null,
    2
  );
});
</script>
</body></html>`;
}

async function main() {
  const chrome = chromiumPath();
  if (!chrome) {
    console.log(JSON.stringify({ skipped: 'no chromium on this machine' }));
    return;
  }
  await withScratchDir(process.argv[2], 'lanchat-meter-', async (dir, keep) => {
    const bundle = await buildBundle(dir);
    const pageFile = path.join(dir, 'page.html');
    fs.writeFileSync(pageFile, buildPage(bundle));
    const png = keep ? path.join(dir, 'transport-meter.png') : null;
    const found = render(chrome, dir, pageFile, { ...RUN, png });
    // And again for a window that asked for less motion. The same page, the same
    // measurements — only the browser's answer to the media query differs, which
    // is the one thing the component reads.
    const stillPng = keep ? path.join(dir, 'transport-meter-still.png') : null;
    const still = render(chrome, dir, pageFile, {
      ...RUN,
      png: stillPng,
      args: [...RUN.args, '--force-prefers-reduced-motion'],
    });
    console.log(JSON.stringify({ motion: found, reduced: still }, null, 2));
    if (keep) console.log(`\nwrote ${png} and ${stillPng}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
