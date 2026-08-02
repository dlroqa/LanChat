'use strict';

// Draws the message that started all this, in a real browser.
//
// An agent answered with a picture it had made and named it twice — once as a
// bare `MEDIA:` line, once as a markdown link — and the bubble rendered both as
// flat grey text with the file sitting unreachable beside it. Everything about
// why that happened is pinned in the unit tests; what cannot be asserted from a
// module is whether the picture is now actually *drawn*, whether the label reads
// as a label rather than as a line of markdown, and whether the button beside it
// says in words what it does.
//
// So this mounts MessageBubble on the real message, with the real stylesheet,
// and asks the browser. It draws a control beside it: the same message with the
// list main attaches taken away, which is the state everything used to be in. If
// the two ever look the same, the feature is not doing anything.
//
//   node scripts/media-harness.js [outDir]
//
// Note for this sandbox: snap chromium cannot write into /tmp or dot-directories,
// so the working directory has to be somewhere ordinary — see lib/chromium.js.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { chromiumPath, render, withScratchDir } = require('./lib/chromium.js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer');

// Tall enough for three bubbles with room to spare. It matters: the third of
// them is a picture fetched only once it is on screen, and a viewport that ends
// near it makes "on screen" a question about font metrics rather than about the
// code — which is a flaky test waiting to happen, and was one.
const RUN = { width: 900, height: 1200, budget: 20000, args: ['--hide-scrollbars'] };

// The path the agent named. Never opened by the harness — what matters is that
// the bubble hands back this exact string, and that it could only have got it
// from the list on the message rather than out of the text.
const SHOT = '/home/agent/share/recent_worldwide_earthquakes_graph.png';

// The words as they arrive after main has had them: the bare marker is gone, the
// markdown link is still there because somebody wrote its label.
const SAID = `Here is the picture graph showing:

- **Earthquake location** on the left
- **Magnitude** represented by the colored horizontal bars

[Download the full-size PNG graph](sandbox:${SHOT})`;

// A solid 8x8 PNG, built here rather than pasted as a blob so the colour it is
// checked against and the colour it is made of are one fact. Bright enough that
// "did anything get drawn" is answerable from the pixels.
function solidPng(width, height, [r, g, b]) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const withType = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(withType) >>> 0);
    return Buffer.concat([len, withType, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function entry() {
  return `
import React from 'react';
import { createRoot } from 'react-dom/client';
import MessageBubble from ${JSON.stringify(path.join(SRC, 'components', 'MessageBubble.jsx'))};
window.__lanchat = { React, createRoot, MessageBubble };
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
  // Stands in for the localhost preview endpoint: in the app the bubble is
  // handed a URL main will only answer for an allowed path, and here it is
  // handed the bytes directly. Either way the bubble's job is the same.
  const shot = `data:image/png;base64,${solidPng(120, 90, [232, 93, 4]).toString('base64')}`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${css}</style></head>
<body><div id="root"><div class="app">
  <div class="sidebar"></div>
  <div class="chat-wrap"><div class="messages-wrap"><div class="messages" id="mount"></div></div></div>
  <aside class="side-panel"></aside>
</div></div>
<script>${bundle}</script>
<script>
const { React, createRoot, MessageBubble } = window.__lanchat;
const h = React.createElement;

const SHOT = ${JSON.stringify(SHOT)};
const SAID = ${JSON.stringify(SAID)};
const media = [{ name: 'recent_worldwide_earthquakes_graph.png', path: SHOT, size: 48213, mime: 'image/png' }];

// A message that links to a picture on the web rather than naming one here. Main
// fetches it and hands back bytes — the window never connects anywhere itself —
// so the stub below is main's side of that, and the harness gets to watch what
// the bubble does with the answer.
const REMOTE = 'https://example.com/photos/quakes.png';
const asked = [];
const saveRequests = [];
const linkRequests = [];

// What the bubble did with what it was given, recorded as it happens.
const opened = [];
const revealed = [];

const message = (id, withMedia) => ({
  id, peerId: 'session:1', direction: 'in', kind: 'text',
  text: SAID, ts: Date.parse('2026-08-01T18:23:00Z'),
  speaker: 'Tessie',
  ...(withMedia ? { media } : {}),
});

const shared = {
  grouped: false,
  previewUrl: (p) => (p === SHOT ? ${JSON.stringify(shot)} : null),
  previewFallback: false,
  onOpen: (p) => opened.push(p),
  onReveal: (p) => revealed.push(p),
  onOpenLink: (url) => linkRequests.push(url),
};

const props = (id, withMedia) => ({ ...shared, msg: message(id, withMedia) });

const remoteProps = () => ({
  ...shared,
  msg: {
    id: 'm3', peerId: 'peer-1', direction: 'in', kind: 'text',
    text: \`look at this \${REMOTE} — the swarm is still going\`,
    ts: Date.parse('2026-08-01T18:24:00Z'),
  },
  previewImage: (url) => {
    asked.push(url);
    return Promise.resolve({ ok: true, url, image: ${JSON.stringify(shot)} });
  },
  onSaveImage: (url) => {
    saveRequests.push(url);
    return Promise.resolve({ ok: true, path: '/home/agent/Downloads/LanChat/quakes.png', name: 'quakes.png', size: 48213 });
  },
});

const root = createRoot(document.getElementById('mount'));
root.render(h(React.Fragment, null,
  h('div', { id: 'live' }, h(MessageBubble, props('m1', true))),
  h('div', { id: 'control' }, h(MessageBubble, props('m2', false))),
  h('div', { id: 'remote' }, h(MessageBubble, remoteProps()))
));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits for something to become true rather than sleeping and hoping. A picture
// is fetched when the bubble holding it comes into view, and how long the
// observer takes to say so is not something a fixed sleep should be guessing at.
const until = async (fn, ms = 3000) => {
  for (const start = Date.now(); Date.now() - start < ms; ) {
    if (fn()) return true;
    await wait(20);
  }
  return false;
};

// Whether an element is really on screen, rather than merely in the DOM.
const shown = (el) => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height) };
};

// The accessible name of a control, by the rule a screen reader uses: the label
// if there is one, otherwise the text inside it. A title attribute is a hover
// affordance and nothing is hovering.
const name = (el) => (el ? el.getAttribute('aria-label') || el.textContent.trim() || null : null);

function read(scope) {
  const box = document.querySelector('#' + scope);
  const img = box.querySelector('.bubble-media .file-media img');
  const buttons = [...box.querySelectorAll('.bubble-media button')];
  return {
    // How wide the bubble ended up. Worth measuring rather than eyeballing: a
    // media block that made the bubble shrink to the width of its own contents
    // would squeeze the words above it into a column, and that is exactly the
    // sort of thing a screenshot flatters and a number does not.
    bubble: shown(box.querySelector('.bubble')),
    // What the message reads as. The markdown target should not be in it: the
    // label is the words, the brackets are punctuation around them.
    text: box.querySelector('.text').textContent,
    // The picture, and whether the browser actually decoded one.
    picture: img ? { ...shown(img), decoded: img.complete && img.naturalWidth > 0, alt: img.getAttribute('alt') } : null,
    // Every control the media block offers, by the name it announces itself with.
    buttons: buttons.map((b) => ({ name: name(b), tag: b.tagName, focusable: b.tabIndex >= 0 })),
    // The label that used to be dead text, and what it points at now.
    chip: (() => {
      const a = [...box.querySelectorAll('.text .msg-link')].find((el) => el.textContent.includes('Download'));
      return a ? { label: a.textContent, title: a.getAttribute('title'), box: shown(a) } : null;
    })(),
  };
}

// The picture a link turned into, and the one control beside it — which changes
// its mind once the picture has been saved, from "keep this" to "here it is".
function readRemote() {
  const box = document.querySelector('#remote');
  const img = box.querySelector('.bubble-media .file-media img');
  const button = box.querySelector('.bubble-media .icon-btn');
  const pictureButton = box.querySelector('.bubble-media .file-media-open');
  return {
    picture: img ? { ...shown(img), decoded: img.complete && img.naturalWidth > 0, alt: img.getAttribute('alt') } : null,
    pictureButton: pictureButton
      ? { name: name(pictureButton), tag: pictureButton.tagName, focusable: pictureButton.tabIndex >= 0 }
      : null,
    caption: (box.querySelector('.bubble-media .fn') || {}).textContent || null,
    note: (box.querySelector('.bubble-media .fs') || {}).textContent || null,
    button: name(button),
    // The link itself is still a link: drawing the picture must not take away
    // the ability to open where it came from.
    link: (box.querySelector('.text .msg-link') || {}).textContent || null,
    // And no card underneath it saying the same thing a second time.
    card: Boolean(box.querySelector('.link-card')),
  };
}

(async () => {
  await wait(200);
  const live = read('live');
  const control = read('control');

  // Clicking the label has to hand back the path main vouched for — not the
  // string out of the text, which is what it would be if the window had worked
  // it out for itself.
  const chip = [...document.querySelectorAll('#live .text .msg-link')].find((el) => el.textContent.includes('Download'));
  if (chip) chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

  // And so does the picture, which is a button so that a keyboard can reach it.
  const open = document.querySelector('#live .file-media-open');
  if (open) open.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const reveal = [...document.querySelectorAll('#live .bubble-media .icon-btn')][0];
  if (reveal) reveal.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  await wait(60);

  // The link that is a picture: drawn from the bytes main handed over, with a
  // button that keeps it. Read before pressing it and again after, because the
  // button is the one thing here that has two states.
  //
  // Scrolled to first, because nothing is fetched until the bubble is on screen
  // — that is the whole point of the observer — and then waited on, so what is
  // being measured is whether it arrives rather than how quickly.
  document.querySelector('#remote').scrollIntoView();
  const remoteDrawn = await until(() => document.querySelector('#remote .bubble-media img'));
  const remoteBefore = readRemote();
  const remoteOpen = document.querySelector('#remote .bubble-media .file-media-open');
  if (remoteOpen) remoteOpen.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const save = document.querySelector('#remote .bubble-media .icon-btn');
  if (save) save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await until(() => saveRequests.length > 0);
  await wait(40);
  const remoteAfter = readRemote();

  const pre = document.createElement('pre');
  pre.id = 'result';
  pre.textContent = JSON.stringify({
    live,
    control,
    remoteBefore,
    remoteAfter,
    remoteDrawn,
    asked,
    saveRequests,
    linkRequests,
    opened,
    revealed,
    shot: SHOT,
    remote: REMOTE,
  });
  document.body.appendChild(pre);
})();
</script></body></html>`;
}

async function runMediaHarness(outDir) {
  const chrome = chromiumPath();
  if (!chrome) return { skipped: 'no chromium on this machine' };

  return withScratchDir(outDir, 'lanchat-media-', async (dir, keep) => {
    const page = path.join(dir, 'page.html');
    fs.writeFileSync(page, buildPage(dir));
    const result = render(chrome, dir, page, {
      ...RUN,
      ...(keep && { png: path.join(dir, 'media.png') }),
    });
    if (!result) return { skipped: 'the page produced no result' };
    return { ...result, dir: keep ? dir : null };
  });
}

module.exports = { runMediaHarness, buildPage };

if (require.main === module) {
  runMediaHarness(process.argv[2])
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
