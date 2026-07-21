'use strict';

// Generates the tray + application icons as PNGs.
//
// No image dependencies in this project, so we rasterize the artwork and encode
// the PNG by hand (zlib is built in). Run `npm run icons` after changing the
// shape; the generated files are committed so builds don't depend on this script.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// ---------------------------------------------------------------- PNG encoder

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ------------------------------------------------------------------ Rasterizer

// All shapes are described in a unit square so one definition scales to any size.
function roundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  if (x >= x0 && x <= x1 && y >= y0 + r && y <= y1 - r) return true;
  if (y >= y0 && y <= y1 && x >= x0 + r && x <= x1 - r) return true;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  const a = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
  const b = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
  return a >= 0 && b >= 0 && a + b <= 1;
}

function circle(x, y, cx, cy, r) {
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// A speech bubble with a tail and three knocked-out dots.
function bubble(x, y) {
  const body = roundRect(x, y, 0.09, 0.15, 0.91, 0.68, 0.17);
  const tail = inTriangle(x, y, 0.28, 0.64, 0.3, 0.88, 0.5, 0.66);
  if (!body && !tail) return false;
  // Dots are holes so the shape reads at 16px and works as a macOS template.
  for (const cx of [0.32, 0.5, 0.68]) {
    if (circle(x, y, cx, 0.415, 0.058)) return false;
  }
  return true;
}

// Unread badge: a filled dot in the top-right corner.
function badge(x, y) {
  return circle(x, y, 0.79, 0.21, 0.2);
}

// Renders with 4x supersampling for clean edges at tray sizes.
function render(size, { rgb, background, dot }) {
  const SS = 4;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let hits = 0;
      let bgHits = 0;
      let dotHits = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (dot && badge(x, y)) dotHits += 1;
          else if (bubble(x, y)) hits += 1;
          if (background && roundRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.22)) bgHits += 1;
        }
      }
      const total = SS * SS;
      const fg = hits / total;
      const bg = bgHits / total;
      const dt = dotHits / total;
      const i = (py * size + px) * 4;

      if (dot && dt > 0) {
        // Unread dot drawn in online-green, over whatever is beneath it.
        out[i] = 34;
        out[i + 1] = 197;
        out[i + 2] = 94;
        out[i + 3] = Math.round(dt * 255);
        continue;
      }

      if (background) {
        // Coloured tile behind a white bubble (application icon).
        const a = bg;
        const r = background[0] * (1 - fg) + 255 * fg;
        const g = background[1] * (1 - fg) + 255 * fg;
        const b = background[2] * (1 - fg) + 255 * fg;
        out[i] = Math.round(r);
        out[i + 1] = Math.round(g);
        out[i + 2] = Math.round(b);
        out[i + 3] = Math.round(a * 255);
      } else {
        out[i] = rgb[0];
        out[i + 1] = rgb[1];
        out[i + 2] = rgb[2];
        out[i + 3] = Math.round(fg * 255);
      }
    }
  }
  return out;
}

function write(file, size, opts) {
  const png = encodePNG(size, size, render(size, opts));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
  console.log(`  wrote ${path.relative(process.cwd(), file)}  ${size}x${size}  ${png.length} bytes`);
}

const ASSETS = path.join(__dirname, '..', 'src', 'main', 'assets');
const BUILD = path.join(__dirname, '..', 'build');

const BLACK = [0, 0, 0];
const BRAND = [37, 99, 235]; // #2563eb

console.log('Generating icons…');
// macOS menu bar: template images must be black + alpha; macOS recolours them
// automatically for light/dark menu bars.
write(path.join(ASSETS, 'trayTemplate.png'), 16, { rgb: BLACK });
write(path.join(ASSETS, 'trayTemplate@2x.png'), 32, { rgb: BLACK });
// Windows tray / Linux status area: brand blue reads on light and dark bars.
write(path.join(ASSETS, 'tray.png'), 16, { rgb: BRAND });
write(path.join(ASSETS, 'tray@2x.png'), 32, { rgb: BRAND });
write(path.join(ASSETS, 'tray@3x.png'), 48, { rgb: BRAND });
// Application icon (also removes electron-builder's "default icon" warning).
// Unread variants: coloured (not template) so the green dot is never tinted away.
write(path.join(ASSETS, 'trayUnread.png'), 16, { rgb: BRAND, dot: true });
write(path.join(ASSETS, 'trayUnread@2x.png'), 32, { rgb: BRAND, dot: true });
write(path.join(BUILD, 'icon.png'), 512, { background: BRAND });
console.log('Done.');
