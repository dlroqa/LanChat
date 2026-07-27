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

// Where the three dots sit. Shared by the shape below and by the app icon's
// coloured version of them, and matched by the <circle> elements in
// src/renderer/components/Logo.jsx — the animated mark and this one are the
// same drawing.
const DOTS = [0.32, 0.5, 0.68];
const DOT_CY = 0.415;
const DOT_R = 0.058;

function inDots(x, y) {
  for (const cx of DOTS) {
    if (circle(x, y, cx, DOT_CY, DOT_R)) return true;
  }
  return false;
}

// A speech bubble with a tail and three knocked-out dots.
function bubble(x, y) {
  const body = roundRect(x, y, 0.09, 0.15, 0.91, 0.68, 0.17);
  const tail = inTriangle(x, y, 0.28, 0.64, 0.3, 0.88, 0.5, 0.66);
  if (!body && !tail) return false;
  // Dots are holes so the shape reads at 16px and works as a macOS template.
  return !inDots(x, y);
}

// --- status-menu glyphs -------------------------------------------------
// Rotate a point around the unit-square centre, so shapes can be drawn axis
// aligned and then tilted (used for the phone handset).
function rot(x, y, deg) {
  const r = (deg * Math.PI) / 180;
  const dx = x - 0.5;
  const dy = y - 0.5;
  return [0.5 + dx * Math.cos(r) - dy * Math.sin(r), 0.5 + dx * Math.sin(r) + dy * Math.cos(r)];
}

function dotShape(x, y) {
  return circle(x, y, 0.5, 0.5, 0.3);
}

// Speech bubble, scaled to sit nicely as a menu glyph.
function messageShape(x, y) {
  const body = roundRect(x, y, 0.1, 0.18, 0.9, 0.66, 0.16);
  const tail = inTriangle(x, y, 0.26, 0.62, 0.28, 0.86, 0.48, 0.64);
  return body || tail;
}

// Handset: a solid "bone" (bar with a flared end at each side), tilted 45
// degrees. An earlier version subtracted a notch, which split the glyph into two
// disconnected blobs at menu size — kept solid so it reads as a phone.
function callShape(x, y) {
  const [rx, ry] = rot(x, y, -45);
  const bar = roundRect(rx, ry, 0.26, 0.44, 0.74, 0.56, 0.05);
  const ear = circle(rx, ry, 0.28, 0.5, 0.16);
  const mouth = circle(rx, ry, 0.72, 0.5, 0.16);
  return bar || ear || mouth;
}

// Camera body plus the lens wedge.
function videoShape(x, y) {
  const body = roundRect(x, y, 0.08, 0.3, 0.62, 0.7, 0.09);
  const lens = inTriangle(x, y, 0.68, 0.34, 0.68, 0.66, 0.92, 0.5);
  return body || lens;
}

// Unread badge: a filled dot in the top-right corner.
function badge(x, y) {
  return circle(x, y, 0.79, 0.21, 0.2);
}

// The same bubble with the dots left filled in, for the application icon: there
// the dots are painted in their own colour on top, so the white has to reach
// under them. Knocking them out first would leave the tile showing through the
// dots' anti-aliased edge as a blue ring.
function bubbleSolid(x, y) {
  const body = roundRect(x, y, 0.09, 0.15, 0.91, 0.68, 0.17);
  const tail = inTriangle(x, y, 0.28, 0.64, 0.3, 0.88, 0.5, 0.66);
  return body || tail;
}

// Linear ramp through a list of [position, [r,g,b]] stops.
function ramp(stops, t) {
  const u = Math.min(Math.max(t, 0), 1);
  for (let i = 1; i < stops.length; i += 1) {
    const [p0, c0] = stops[i - 1];
    const [p1, c1] = stops[i];
    if (u <= p1) {
      const k = p1 === p0 ? 0 : (u - p0) / (p1 - p0);
      return [0, 1, 2].map((n) => c0[n] + (c1[n] - c0[n]) * k);
    }
  }
  return stops[stops.length - 1][1];
}

// Renders with 4x supersampling for clean edges at tray sizes.
//
// `background` is either one colour or a (x, y) => [r,g,b] sampler, which is how
// the application icon gets its gradient. `dotColors` paints the bubble's three
// dots instead of knocking them through to the tile.
function render(size, { rgb, background, dot, shape, dotColors }) {
  const SS = 4;
  const out = Buffer.alloc(size * size * 4);
  const sampleBg = typeof background === 'function' ? background : background && (() => background);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let hits = 0;
      let bgHits = 0;
      let dotHits = 0;
      const ink = [0, 0, 0];
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          const draw = shape || (dotColors ? bubbleSolid : bubble);
          if (dot && badge(x, y)) dotHits += 1;
          else if (draw(x, y)) hits += 1;
          if (background && roundRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.22)) bgHits += 1;
          if (dotColors) {
            for (let d = 0; d < DOTS.length; d += 1) {
              if (circle(x, y, DOTS[d], DOT_CY, DOT_R)) ink[d] += 1;
            }
          }
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
        const base = sampleBg(px / size, py / size);
        const rgbOut = [0, 1, 2].map((n) => base[n] * (1 - fg) + 255 * fg);
        // Then the dots, over the white.
        if (dotColors) {
          for (let d = 0; d < DOTS.length; d += 1) {
            const k = ink[d] / total;
            if (k > 0) for (let n = 0; n < 3; n += 1) rgbOut[n] = rgbOut[n] * (1 - k) + dotColors[d][n] * k;
          }
        }
        out[i] = Math.round(rgbOut[0]);
        out[i + 1] = Math.round(rgbOut[1]);
        out[i + 2] = Math.round(rgbOut[2]);
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
// Status-menu glyphs. Action icons are template images (black + alpha) so macOS
// tints them for light/dark menus; the presence dot stays green on purpose.
const GREEN = [34, 197, 94];
const GREY = [136, 144, 160];
write(path.join(ASSETS, 'dotOnline.png'), 12, { rgb: GREEN, shape: dotShape });
write(path.join(ASSETS, 'dotOnline@2x.png'), 24, { rgb: GREEN, shape: dotShape });
write(path.join(ASSETS, 'dotOffline.png'), 12, { rgb: GREY, shape: dotShape });
write(path.join(ASSETS, 'dotOffline@2x.png'), 24, { rgb: GREY, shape: dotShape });
for (const [name, shape] of [
  ['menuMessageTemplate', messageShape],
  ['menuCallTemplate', callShape],
  ['menuVideoTemplate', videoShape],
]) {
  write(path.join(ASSETS, `${name}.png`), 14, { rgb: BLACK, shape });
  write(path.join(ASSETS, `${name}@2x.png`), 28, { rgb: BLACK, shape });
}
// The application icon is the one place with room for the mark's prism. A PNG
// cannot shimmer, so it holds a single frame of it: the same indigo → blue →
// cyan sweep the animated tile turns through (see "The logo mark" in
// styles.css), laid diagonally so the tile has a lit corner instead of a flat
// fill. It still averages to --primary, which is the colour the icon has to
// read as in a dock at 32px.
const PRISM = [
  [0, [30, 58, 138]], // #1e3a8a
  [0.45, [37, 99, 235]], // #2563eb — the brand blue, on the diagonal
  [1, [56, 189, 248]], // #38bdf8
];
// And a still of the colour wave that runs through the dots: three stops from
// `logo-dot-drift`, in the order the crest reaches them. Each clears 3.5:1
// against the white bubble, same as every frame of the animation.
const DOT_INK = [
  [8, 155, 87], // hsl(152 90% 32%)
  [0, 148, 133], // hsl(174 100% 29%)
  [0, 123, 168], // hsl(196 100% 33%)
];
write(path.join(BUILD, 'icon.png'), 512, {
  background: (x, y) => ramp(PRISM, (x + y) / 2),
  dotColors: DOT_INK,
});
console.log('Done.');
