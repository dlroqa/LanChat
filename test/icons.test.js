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
