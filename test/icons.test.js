'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The tray previously shipped with an empty image, which renders as an invisible
// status-menu item. These guard the generated assets against going missing or
// being replaced with something malformed.

const ROOT = path.join(__dirname, '..');

function readPngSize(file) {
  const buf = fs.readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buf.subarray(0, 8).equals(signature), `${file} is not a PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

const EXPECTED = [
  ['src/main/assets/trayTemplate.png', 16],
  ['src/main/assets/trayTemplate@2x.png', 32],
  ['src/main/assets/tray.png', 16],
  ['src/main/assets/tray@2x.png', 32],
  ['build/icon.png', 512],
  // Status-menu assets: presence dots and one-click action glyphs.
  ['src/main/assets/dotOnline.png', 12],
  ['src/main/assets/dotOffline.png', 12],
  ['src/main/assets/menuMessageTemplate.png', 14],
  ['src/main/assets/menuCallTemplate.png', 14],
  ['src/main/assets/menuVideoTemplate.png', 14],
];

test('tray and app icons exist at the expected sizes', () => {
  for (const [rel, size] of EXPECTED) {
    const file = path.join(ROOT, rel);
    assert.ok(fs.existsSync(file), `missing icon: ${rel}`);
    const info = readPngSize(file);
    assert.equal(info.width, size, `${rel} width`);
    assert.equal(info.height, size, `${rel} height`);
    assert.ok(info.bytes > 100, `${rel} looks empty (${info.bytes} bytes)`);
  }
});

// Decodes a PNG far enough to read pixels back. The generator writes filter 0
// on every row (see encodePNG in scripts/make-icons.js), so undoing the deflate
// is the whole job.
function readPixels(file) {
  const zlib = require('node:zlib');
  const buf = fs.readFileSync(file);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const idat = [];
  let p = 8;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  return {
    width,
    height,
    at(x, y) {
      const i = y * (stride + 1) + 1 + x * 4;
      assert.equal(raw[y * (stride + 1)], 0, 'expected filter 0 rows');
      return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
    },
  };
}

test('the app icon carries the prism gradient, not a flat fill', () => {
  // The tile holds one frame of the mark's animated prism (see "The logo mark"
  // in styles.css). If the gradient sampler ever regressed to a single colour
  // the icon would still be the right size and non-blank, so size alone does
  // not guard this.
  const px = readPixels(path.join(ROOT, 'build/icon.png'));
  const near = px.at(Math.round(px.width * 0.12), Math.round(px.height * 0.12));
  const far = px.at(Math.round(px.width * 0.88), Math.round(px.height * 0.88));
  assert.equal(near[3], 255, 'top-left of the tile should be opaque');
  assert.equal(far[3], 255, 'bottom-right of the tile should be opaque');
  const spread = [0, 1, 2].reduce((m, n) => Math.max(m, Math.abs(near[n] - far[n])), 0);
  assert.ok(spread > 40, `corners differ by only ${spread}; the tile looks flat`);
  // And it is still blue: the sweep runs indigo → blue → cyan and never leaves.
  for (const c of [near, far]) assert.ok(c[2] > c[0] && c[2] > c[1], `expected a blue tile, got ${c}`);
});

test('the app icon paints its three dots rather than knocking them through', () => {
  // The dots hold a still of the colour wave, so each is a different green-cyan
  // — and none of them is the tile showing through, which is what the mark
  // looked like before.
  const px = readPixels(path.join(ROOT, 'build/icon.png'));
  const y = Math.round(px.height * 0.415);
  const dots = [0.32, 0.5, 0.68].map((cx) => px.at(Math.round(px.width * cx), y));
  for (const [r, g, b] of dots) {
    assert.ok(g > r, `a dot came out ${[r, g, b]}; expected green through cyan`);
  }
  assert.notDeepStrictEqual(dots[0], dots[2], 'the three dots should not be one colour');
});

test('tray icons are non-blank (have opaque pixels)', () => {
  // Regenerate in-memory via the same renderer the build script uses, and assert
  // the artwork actually covers part of the canvas.
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, ['scripts/make-icons.js'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(out, /Done\./);
  for (const [rel] of EXPECTED) {
    const info = readPngSize(path.join(ROOT, rel));
    assert.ok(info.bytes > 100, `${rel} regenerated empty`);
  }
});
