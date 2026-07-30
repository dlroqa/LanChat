'use strict';

// Drives the agent connection light in a real browser.
//
// The light is one absolutely-positioned overlay with a rotating gradient behind
// a glass pane. Almost everything worth checking about it — whether it fills the
// box it is given, whether a click passes through it to the conversation
// underneath, whether it holds still under reduced motion, whether the text over
// it keeps its contrast — is decided by a layout engine. Asserting any of that
// against a DOM stand-in would be asserting against our own guess.
//
// So this builds a page holding the real component, the real stylesheet and a
// couple of message bubbles, runs it in headless chromium, and reports back. Run
// it directly to also drop screenshots somewhere you can look at them:
//
//   node scripts/flash-harness.js [outDir]
//
// Note for this sandbox: snap chromium cannot write into /tmp or dot-directories,
// so the working directory has to be somewhere ordinary.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execFileSync: run } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer');

function chromiumPath() {
  for (const bin of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    try {
      return execFileSync('which', [bin], { encoding: 'utf8' }).trim();
    } catch {
      /* keep looking */
    }
  }
  return null;
}

// The page: real stylesheet, real component, a thread with two bubbles in it.
function buildPage() {
  const esbuild = require('esbuild');
  const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');
  const component = fs.readFileSync(path.join(SRC, 'components', 'AgentFlash.jsx'), 'utf8');
  const react = fs.readFileSync(path.join(ROOT, 'node_modules', 'react', 'umd', 'react.development.js'), 'utf8');
  const reactDom = fs.readFileSync(
    path.join(ROOT, 'node_modules', 'react-dom', 'umd', 'react-dom.development.js'),
    'utf8'
  );

  // The component is ESM+JSX; make it a browser script that leaves AgentFlash on
  // window, taking React off the global the UMD bundle just installed.
  const { code } = esbuild.transformSync(component.replace(/^import[^;]+;$/gm, ''), {
    loader: 'jsx',
    format: 'iife',
    globalName: 'FlashMod',
  });

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${css}</style>
<style>
  /* The chat pane's own geometry, so the light is laid out in a box the size it
     gets in the app rather than in the whole viewport. */
  html, body { margin: 0; height: 100%; }
  #root { height: 100vh; width: 100vw; display: flex; }
</style>
</head><body><div id="root"></div>
<script>${react}</script>
<script>${reactDom}</script>
<script>
  const { useEffect, useState } = React;
  ${code.replace(/\bReact\b/g, 'React')}
  window.AgentFlash = FlashMod.default;
</script>
<script>
  // useEffect and useState are already bound in the block above, for the
  // component. Classic scripts share one top-level scope, so re-declaring either
  // one here is a SyntaxError that takes the whole page down.
  const h = React.createElement;
  let doneCount = 0;
  window.__done = () => doneCount;
  window.__resetDone = () => { doneCount = 0; };

  // Mirrors ChatPane's structure. It has to: the whole point of measuring in a
  // browser is that the geometry is real, and a harness that nests things
  // differently from the component measures a fiction. The nesting in ChatPane
  // itself is pinned separately, in connectFlash.test.js.
  function Pane({ flash }) {
    return h('div', { className: 'chat', style: { flex: 1 } },
      h('div', { className: 'chat-header' }, 'Tessie'),
      h('div', { className: 'messages-wrap' },
        h('div', { className: 'messages' },
          h('div', { className: 'bubble-row in' },
            h('div', { className: 'bubble' },
              h('div', { className: 'text', id: 'probe' }, 'Hello — Tessie here. Ask me anything.'))),
          h('div', { className: 'bubble-row out' },
            h('div', { className: 'bubble' }, h('div', { className: 'text' }, '@tessie')))),
        h('div', { className: 'typing' }),
        flash && h(window.AgentFlash, {
          key: flash.nonce, mode: flash.mode, ms: flash.ms, name: 'Tessie',
          onDone: () => { doneCount += 1; },
        })),
      h('div', { className: 'composer' }, h('button', { id: 'below' }, 'send')));
  }

  const root = ReactDOM.createRoot(document.getElementById('root'));
  window.__render = (flash) => { root.render(h(Pane, { flash })); };
  window.__unmount = () => { root.unmount(); };
  window.__render(null);
</script>
</body></html>`;
}

// One chromium run: load the page, let its script finish, and read the findings
// back out of the dumped DOM. --dump-dom gives no return channel, so the page
// leaves them in a <pre>.
function evaluate(chrome, dir, page, name, extraArgs = []) {
  const pageFile = path.join(dir, `${name}.html`);
  fs.writeFileSync(pageFile, page);
  const out = run(
    chrome,
    [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--force-color-profile=srgb',
      '--window-size=900,700',
      ...extraArgs,
      '--virtual-time-budget=4000',
      '--dump-dom',
      `file://${pageFile}`,
    ],
    { encoding: 'utf8', cwd: dir, maxBuffer: 64 * 1024 * 1024 }
  );
  const m = out.match(/<pre id="result">([\s\S]*?)<\/pre>/);
  return m ? JSON.parse(decodeEntities(m[1])) : null;
}

function screenshot(chrome, dir, page, name, extraArgs = []) {
  const pageFile = path.join(dir, `${name}.html`);
  fs.writeFileSync(pageFile, page);
  run(
    chrome,
    [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--force-color-profile=srgb',
      '--hide-scrollbars',
      '--window-size=900,700',
      ...extraArgs,
      `--screenshot=${path.join(dir, `${name}.png`)}`,
      `file://${pageFile}`,
    ],
    { encoding: 'utf8', cwd: dir, maxBuffer: 64 * 1024 * 1024 }
  );
  return path.join(dir, `${name}.png`);
}

async function runFlashHarness(outDir) {
  const chrome = chromiumPath();
  if (!chrome) return { skipped: 'no chromium on PATH' };
  let esbuildOk = true;
  try {
    require('esbuild');
  } catch {
    esbuildOk = false;
  }
  if (!esbuildOk) return { skipped: 'esbuild not installed' };

  // Somewhere ordinary: snap chromium is confined and cannot write to /tmp or to
  // a dot-directory, and it needs a writable cwd for its own profile.
  //
  // A run without an explicit destination is a test run, and it cleans up after
  // itself — chromium leaves about 12MB of profile behind each time, which is not
  // something a suite should be depositing in somebody's home directory. Pass a
  // directory to keep the screenshots and look at them.
  const keep = Boolean(outDir);
  const dir = outDir || fs.mkdtempSync(path.join(os.homedir(), 'lanchat-flash-'));
  fs.mkdirSync(dir, { recursive: true });
  try {
    return await measure(chrome, dir, keep ? dir : null);
  } finally {
    if (!keep) fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function measure(chrome, dir, keptDir) {
  const page = buildPage();

  // Everything that needs to happen in sequence happens in one page load, and the
  // findings are stashed in the DOM for --dump-dom to bring back.
  const probe = `
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const out = {};

      // --- a full, short run, left alone to finish on its own
      window.__resetDone();
      window.__render({ nonce: 1, mode: 'connected', ms: 150 });
      await wait(30);

      const flash = document.querySelector('.agent-flash');
      const wrap = document.querySelector('.messages-wrap');
      const fr = flash.getBoundingClientRect();
      const wr = wrap.getBoundingClientRect();
      out.rects = { flash: [fr.x, fr.y, fr.width, fr.height], wrap: [wr.x, wr.y, wr.width, wr.height] };
      // Edge to edge: within a pixel of the box on all four sides.
      out.coversBox =
        Math.abs(fr.x - wr.x) <= 1 && Math.abs(fr.y - wr.y) <= 1 &&
        Math.abs(fr.width - wr.width) <= 1 && Math.abs(fr.height - wr.height) <= 1;
      out.pointerEvents = getComputedStyle(flash).pointerEvents;

      // Comparing the light to its own wrapper cannot catch a gap *below* the
      // wrapper — both grow together and it still reports a pass. v0.4.23 shipped
      // with a black band across the bottom for exactly that reason: the typing row
      // sat outside the box. So the neighbours are measured too. Nothing between the
      // header and the composer may be left dark.
      const header = document.querySelector('.chat-header').getBoundingClientRect();
      const composer = document.querySelector('.composer').getBoundingClientRect();
      out.gapAbove = Math.round(fr.top - header.bottom);
      out.gapBelow = Math.round(composer.top - fr.bottom);
      const typing = document.querySelector('.typing').getBoundingClientRect();
      out.typingCovered = typing.top >= fr.top - 1 && typing.bottom <= fr.bottom + 1;

      // A click in the middle of the light must land on what is underneath it.
      const hit = document.elementFromPoint(fr.x + fr.width / 2, fr.y + fr.height / 2);
      out.clickReachedBelow = !!hit && !hit.closest('.agent-flash');

      // Every layer that moves takes its length from the duration the component was
      // given. The frames carry no class of their own, so they are selected as
      // elements rather than by name.
      out.durations = [...document.querySelectorAll('.agent-flash, .agent-flash [class*=agent-flash-], .agent-flash i')]
        .map((el) => getComputedStyle(el))
        .filter((s) => s.animationName !== 'none')
        .map((s) => s.animationDuration);

      // Where the text actually is, so the contrast comparison can look at glyphs
      // rather than at the light showing through the gaps around a bubble.
      const probeEl = document.getElementById('probe');
      const pr = probeEl.getBoundingClientRect();
      out.textRect = [Math.round(pr.x), Math.round(pr.y), Math.round(pr.width), Math.round(pr.height)];

      // --- a second play replaces the first rather than stacking on it
      window.__render({ nonce: 2, mode: 'connected', ms: 150 });
      await wait(30);
      out.lightsAfterSecondPlay = document.querySelectorAll('.agent-flash').length;

      // --- unmounted early: the timer must go with it
      window.__resetDone();
      window.__render({ nonce: 3, mode: 'connected', ms: 400 });
      await wait(30);
      window.__render(null);
      await wait(500);
      out.doneAfterUnmount = window.__done();

      // --- left to run: it finishes exactly once
      window.__resetDone();
      window.__render({ nonce: 4, mode: 'connected', ms: 120 });
      await wait(400);
      out.doneAfterFullRun = window.__done();

      window.__render(null);
      document.title = 'RESULT:' + JSON.stringify(out);
      const sink = document.createElement('pre');
      sink.id = 'result';
      sink.textContent = JSON.stringify(out);
      document.body.appendChild(sink);
    })();
  `;

  const result = evaluate(chrome, dir, page.replace('</body>', `<script>${probe}</script></body>`), 'flash');
  if (!result) return { skipped: 'the page did not report back (chromium may be confined)' };

  // Reduced motion has to be turned on with a browser flag — a page cannot ask for
  // it on its own behalf, so measuring this without the flag measures the ordinary
  // case and reports a pass that never happened.
  const reducedPage = page.replace(
    '</body>',
    `<script>
        window.__render({ nonce: 9, mode: 'connected', ms: 2600 });
        setTimeout(() => {
          const moving = [...document.querySelectorAll('.agent-flash [class*=agent-flash-], .agent-flash i')]
            .filter((el) => getComputedStyle(el).animationName !== 'none')
            .map((el) => (el.className || 'frame') + ':' + getComputedStyle(el).animationName);
          const sink = document.createElement('pre');
          sink.id = 'result';
          sink.textContent = JSON.stringify({
            moving,
            mq: matchMedia('(prefers-reduced-motion: reduce)').matches,
          });
          document.body.appendChild(sink);
        }, 60);
      </script></body>`
  );
  const reduced = evaluate(chrome, dir, reducedPage, 'reduced', ['--force-prefers-reduced-motion']);
  if (!reduced || !reduced.mq) {
    // Never silently pass this one: if the flag did not take, the measurement is
    // meaningless and has to say so.
    result.reducedMotionAnimations = ['<reduced motion was not actually enabled>'];
  } else {
    result.reducedMotionAnimations = reduced.moving;
  }

  // Contrast: the same bubble rendered with and without the light behind it. The
  // promise is that glow only ever adds light *around* text, never over it, so the
  // glyph pixels have to come out the same.
  const frozen = (extra) =>
    page.replace(
      '</body>',
      `<style>
         /* Freeze-frame: hold every layer at a point mid-run so the screenshot is
            a composed frame rather than whatever frame 0 happens to be. */
         .agent-flash, .agent-flash * { animation-play-state: paused !important; animation-delay: -600ms !important; }
       </style>
       <script>window.__render(${extra});</script></body>`
    );

  const withLight = screenshot(chrome, dir, frozen(`{ nonce: 1, mode: 'connected', ms: 6000 }`), 'with-light');
  const without = screenshot(chrome, dir, frozen('null'), 'without-light');
  result.bubbleContrastDelta = compareGlyphs(withLight, without, result.textRect);

  // Several offsets across the run, because the point is what it looks like while
  // somebody is chatting rather than what its first frame looks like. Only worth
  // producing when somebody is going to look at them.
  if (keptDir) {
    result.frames = [-200, -1500, -3000, -5000].map((delay) =>
      screenshot(
        chrome,
        dir,
        page.replace(
          '</body>',
          `<style>.agent-flash, .agent-flash * {
             animation-play-state: paused !important; animation-delay: ${delay}ms !important; }</style>
         <script>window.__render({ nonce: 1, mode: 'connected', ms: 6000 });</script></body>`
        ),
        `frame${Math.abs(delay)}`
      )
    );
    result.screenshots = { withLight, without, dir };
  }
  return result;
}

function decodeEntities(s) {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// How much the text's *contrast* changed with the light behind it, as a fraction
// of what it was.
//
// It is deliberately not a per-pixel comparison. The first version of this was,
// and it reported a 7.8% difference on text that is provably untouched: putting a
// composited layer underneath makes chromium drop from subpixel to greyscale
// antialiasing, so every glyph edge loses its colour fringe. The pixels change;
// the legibility does not. Measuring bytes would have failed a design that was
// working, and — worse — could pass one that was not, since a uniform wash over
// text moves pixels less than an AA mode switch does.
//
// So this measures the thing the CSS actually promises: the ratio between the
// glyphs and the fill they sit on, computed in both images and compared. Only
// inside the bubble's own text rect — the rest of the frame is supposed to differ,
// that being the light.
function compareGlyphs(a, b, rect) {
  const pa = readPng(a);
  const pb = readPng(b);
  if (!pa || !pb || !rect) return 0;
  if (pa.width !== pb.width || pa.height !== pb.height) return 1;
  const [with_, without] = [contrastIn(pa, rect), contrastIn(pb, rect)];
  if (!without) return 0;
  return Math.abs(with_ - without) / without;
}

// WCAG contrast between the glyph cores and the surface they are drawn on, taken
// from the pixels rather than from the stylesheet — the point is what came out of
// the compositor, not what the tokens said should.
function contrastIn(png, [rx, ry, rw, rh]) {
  const lums = [];
  for (let y = ry; y < ry + rh; y += 1) {
    for (let x = rx; x < rx + rw; x += 1) {
      lums.push(relativeLuminance(png, (y * png.width + x) * 4));
    }
  }
  if (!lums.length) return 0;
  lums.sort((p, q) => p - q);
  // The 1st and 99th percentiles: the bubble fill, and the middle of a stroke.
  //
  // Not the 10th and 90th, which is what this tried first. The 90th lands in the
  // antialiased band around each glyph, and that band is exactly what changes when
  // a composited layer underneath makes chromium switch from subpixel to greyscale
  // antialiasing — so it reported an 8.8% contrast loss on text whose fill and
  // stroke centres are bit-identical between the two frames. The percentiles have
  // to sit on the two things the contrast ratio is actually about.
  const fill = lums[Math.floor(lums.length * 0.01)];
  const glyph = lums[Math.min(lums.length - 1, Math.floor(lums.length * 0.99))];
  return (glyph + 0.05) / (fill + 0.05);
}

function relativeLuminance(png, i) {
  const ch = [0, 1, 2].map((c) => {
    const s = png.data[i + c] / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

// Minimal PNG reader: chromium writes non-interlaced 8-bit RGBA, which zlib and a
// few lines of unfiltering can handle without a dependency.
function readPng(file) {
  const zlib = require('node:zlib');
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += len + 12;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) return null;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    unfilter(filter, line, prev, channels);
    for (let x = 0; x < width; x += 1) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      out[d] = line[s];
      out[d + 1] = line[s + 1];
      out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }
  return { width, height, data: out };
}

function unfilter(filter, line, prev, bpp) {
  for (let i = 0; i < line.length; i += 1) {
    const a = i >= bpp ? line[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    if (filter === 1) line[i] = (line[i] + a) & 0xff;
    else if (filter === 2) line[i] = (line[i] + b) & 0xff;
    else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 0xff;
    else if (filter === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
    }
  }
}

module.exports = { runFlashHarness, buildPage, readPng };

if (require.main === module) {
  runFlashHarness(process.argv[2])
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
