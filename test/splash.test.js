'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// The launch splash. Two things are worth pinning down without a running app:
// the ordering rule that decides when the real window appears, and the promise
// the dots' colour makes about staying legible on the white bubble.

// splash.js requires electron at load; stub what it touches.
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'electron') return 'estub';
  return orig.call(this, r, ...a);
};
require.cache['estub'] = {
  id: 'estub',
  filename: 'estub',
  loaded: true,
  exports: {
    app: { getVersion: () => '0.0.0' },
    BrowserWindow: class {},
    ipcMain: { on: () => {}, removeAllListeners: () => {} },
  },
};

const { createGate } = require('../src/main/splash.js');

// ---------------------------------------------------------------- reveal gate

test('the window is not revealed until both the splash and the window are ready', () => {
  let revealed = 0;
  const arrive = createGate(['splash', 'window'], () => {
    revealed += 1;
  });

  assert.equal(arrive('splash'), false);
  assert.equal(revealed, 0, 'a finished splash alone must not reveal an unready window');
  assert.equal(arrive('window'), true);
  assert.equal(revealed, 1);
});

test('either order works — a fast boot has the window ready long before the sequence ends', () => {
  let revealed = 0;
  const arrive = createGate(['splash', 'window'], () => {
    revealed += 1;
  });

  assert.equal(arrive('window'), false);
  assert.equal(revealed, 0, 'a ready window must not cut the splash short');
  assert.equal(arrive('splash'), true);
  assert.equal(revealed, 1);
});

test('a repeated signal does not reveal twice', () => {
  // The splash can report done from its own timer and from a click at nearly
  // the same moment, and the timeout fallback can land on top of both.
  let revealed = 0;
  const arrive = createGate(['splash', 'window'], () => {
    revealed += 1;
  });

  arrive('splash');
  arrive('splash');
  arrive('window');
  arrive('window');
  arrive('splash');
  assert.equal(revealed, 1);
});

// ------------------------------------------------------------------- timings

const TIMING = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'lib', 'splashTiming.js'),
  'utf8'
);
const { SPLASH_MS, REDUCED_SPLASH_MS, splashDuration } = new Function(
  `${TIMING.replace(/^export\s+/gm, '')}
   return { SPLASH_MS, REDUCED_SPLASH_MS, splashDuration };`
)();

test('the splash runs its full ten seconds, and a fraction of that under reduced motion', () => {
  assert.equal(splashDuration(false), SPLASH_MS);
  assert.equal(SPLASH_MS, 10000);
  assert.equal(splashDuration(true), REDUCED_SPLASH_MS);
  // Reduced motion switches every animation off, so what is left is a still.
  // Holding a still for the full sequence would be the wait without the reason
  // for it.
  assert.ok(REDUCED_SPLASH_MS < SPLASH_MS / 4, 'reduced motion should not sit through the whole sequence');
});

test('the choreography in styles.css ends before the timer does', () => {
  // The handoff fade is the last beat; if it started after the timer fired, the
  // splash would be torn down mid-fade.
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const handoff = css.match(/animation: splash-handoff ([\d.]+)s [\w-]+ ([\d.]+)s both/);
  assert.ok(handoff, 'the splash handoff animation should still be there');
  const endsAt = (Number(handoff[1]) + Number(handoff[2])) * 1000;
  assert.equal(endsAt, SPLASH_MS, 'the fade should land exactly as the splash hands off');
});

// ------------------------------------------------- the dots stay readable

// WCAG relative luminance, and contrast against the white bubble the dots sit
// on. Non-text graphics need 3:1.
function luminance([r, g, b]) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastOnWhite(rgb) {
  return 1.05 / (luminance(rgb) + 0.05);
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;
  const table = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  return table[Math.min(Math.floor(hp), 5)].map((v) => Math.round((v + m) * 255));
}

// Pull the stops straight out of the stylesheet, so this cannot silently pass
// against a keyframe block that has since been retuned.
function driftStops() {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const block = css.match(/@keyframes logo-dot-drift \{([\s\S]*?)\n\}/);
  assert.ok(block, 'logo-dot-drift should still be in styles.css');
  const stops = [...block[1].matchAll(/hsl\((\d+) (\d+)% (\d+)%\)/g)].map((m) => [
    Number(m[1]),
    Number(m[2]) / 100,
    Number(m[3]) / 100,
  ]);
  assert.ok(stops.length >= 5, `expected the full band, found ${stops.length} stops`);
  return stops;
}

test('every stop of the dots colour drift stays readable on the white bubble', () => {
  for (const [h, s, l] of driftStops()) {
    const ratio = contrastOnWhite(hslToRgb(h, s, l));
    assert.ok(ratio >= 3, `hsl(${h} ${s * 100}% ${l * 100}%) is only ${ratio.toFixed(2)}:1 on white`);
  }
});

test('the dots stay readable between the stops too, not only on them', () => {
  // Luminance is not monotonic across hue, so clearing every keyframe is not by
  // itself a guarantee about the frames in between. CSS interpolates these in
  // HSL, so walking the same path catches whatever sits in the middle.
  const stops = driftStops();
  let worst = { ratio: Infinity };
  for (let i = 1; i < stops.length; i += 1) {
    const a = stops[i - 1];
    const b = stops[i];
    for (let k = 0; k <= 40; k += 1) {
      const t = k / 40;
      const mix = [0, 1, 2].map((n) => a[n] + (b[n] - a[n]) * t);
      const ratio = contrastOnWhite(hslToRgb(mix[0], mix[1], mix[2]));
      if (ratio < worst.ratio) worst = { ratio, mix };
    }
  }
  assert.ok(worst.ratio >= 3, `worst frame is ${worst.ratio.toFixed(2)}:1 at hsl(${worst.mix})`);
});

test('the hue never leaves the green-to-cyan band the Ready state established', () => {
  // The band is the whole point of the constraint: the mark must never flash
  // something that reads as a warning. Same reasoning as `ready-drift`.
  for (const [h] of driftStops()) {
    assert.ok(h >= 140 && h <= 205, `hue ${h} is outside the green-to-cyan band`);
  }
});
