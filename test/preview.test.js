'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const { Config } = require('../src/main/config.js');
const { buildIdentity, buildPublicCard } = require('../src/main/identity.js');
const { createDeviceKey } = require('../src/main/deviceKey.js');
const { createPins } = require('../src/main/pins.js');
const { PeerHub } = require('../src/main/peers.js');
const { createServer, uniqueDest } = require('../src/main/server.js');
const { MessageStore } = require('../src/main/store.js');

// Inline thumbnails are served by the node's own HTTP endpoint, from an explicit
// allowlist of files LanChat itself put in a conversation.
//
// Rebuilding that allowlist from stored history is a Windows-only change, so
// `windows` is passed explicitly here: the last test pins the confinement, and
// without it the suite would pass on macOS and Linux for the wrong reason.

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function get(port, filePath) {
  const url = `http://127.0.0.1:${port}/lanchat/preview?path=${encodeURIComponent(filePath)}`;
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) })
        );
      })
      .on('error', reject);
  });
}

function makeNode(name, port, windows = true, netScope = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lanchat-${name}-`));
  const config = new Config(dir);
  config.set({ displayName: name, servicePort: port });
  const bus = new EventEmitter();
  const getIdentity = () => buildIdentity(config);
  const store = new MessageStore(dir);
  const hub = new PeerHub({ getIdentity, bus });
  const downloadsDir = path.join(dir, 'downloads');
  const deviceKey = createDeviceKey({ userDataDir: dir });
  const pins = createPins({ userDataDir: dir });
  const getPublicCard = () => buildPublicCard(config, deviceKey);
  const server = createServer({
    config, getIdentity, getPublicCard, deviceKey, pins, hub, bus, downloadsDir, store, windows, netScope,
  });
  return { dir, config, bus, store, hub, server, downloadsDir, port, deviceKey, pins };
}

// A 1x1 PNG, so the endpoint is exercised on something a browser would decode.
const PIXEL = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000100000001080600000' +
    '01f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
  'hex'
);

test('a photo already in the conversation still previews after a restart', async (t) => {
  const port = await freePort();
  const A = makeNode('alice', port);
  const image = path.join(A.dir, 'holiday.png');
  fs.writeFileSync(image, PIXEL);

  // A file sent in an earlier session: recorded in history, and allowed for
  // preview by the event that is long gone by the time the app is reopened.
  A.store.append('peer-1', {
    id: 'm1',
    peerId: 'peer-1',
    direction: 'out',
    kind: 'file',
    file: { name: 'holiday.png', path: image, size: PIXEL.length, mime: 'image/png' },
    ts: Date.now(),
  });

  // A fresh process: nothing has been sent or received yet in this one.
  const restarted = createServer({
    config: A.config,
    getIdentity: A.hub.getIdentity,
    hub: A.hub,
    bus: new EventEmitter(),
    downloadsDir: A.downloadsDir,
    store: A.store,
    windows: true,
  });
  await restarted.start();
  t.after(() => restarted.stop());

  const res = await get(port, image);
  assert.equal(res.status, 200, 'the thumbnail is served, not 404 — the bubble is not left broken');
  assert.equal(res.type, 'image/png');
  assert.deepEqual(res.body, PIXEL);
});

test('nothing outside the conversation is served', async (t) => {
  const port = await freePort();
  const A = makeNode('bob', port);
  const secret = path.join(A.dir, 'private.png');
  fs.writeFileSync(secret, PIXEL);
  await A.server.start();
  t.after(() => A.server.stop());

  const res = await get(port, secret);
  assert.equal(res.status, 404, 'an existing file LanChat never sent or received stays private');
});

test('every other platform keeps the allowlist it had', async (t) => {
  const port = await freePort();
  const A = makeNode('dave', port, false);
  const image = path.join(A.dir, 'holiday.png');
  fs.writeFileSync(image, PIXEL);
  A.store.append('peer-1', {
    id: 'm1',
    peerId: 'peer-1',
    direction: 'out',
    kind: 'file',
    file: { name: 'holiday.png', path: image, size: PIXEL.length, mime: 'image/png' },
    ts: Date.now(),
  });
  await A.server.start();
  t.after(() => A.server.stop());

  const res = await get(port, image);
  assert.equal(res.status, 404, 'macOS and Linux serve exactly what they served before');
});

test('a file received this session previews immediately', async (t) => {
  const port = await freePort();
  const A = makeNode('carol', port);
  const image = path.join(A.dir, 'incoming.png');
  fs.writeFileSync(image, PIXEL);
  await A.server.start();
  t.after(() => A.server.stop());

  A.bus.emit('file-received', { path: image, name: 'incoming.png', size: PIXEL.length });
  const res = await get(port, image);
  assert.equal(res.status, 200);
});

test('a peer cannot preview anything, however well allowed the file is', async (t) => {
  // The endpoint exists for this window fetching its own thumbnails over
  // localhost; no peer has ever called it. It mattered because on Windows the
  // allowlist is seeded from every file ever exchanged with anyone, so one peer
  // could read back what a different peer had sent. The request arriving from
  // somewhere other than this machine is the whole test — the file is allowed,
  // it exists, and it is still refused.
  const port = await freePort();
  const notLocal = { isLoopback: () => false, allowInbound: () => true };
  const A = makeNode('dave', port, true, notLocal);
  const image = path.join(A.dir, 'private.png');
  fs.writeFileSync(image, PIXEL);
  await A.server.start();
  t.after(() => A.server.stop());

  A.bus.emit('file-received', { path: image, name: 'private.png', size: PIXEL.length });
  const res = await get(port, image);
  assert.equal(res.status, 404, 'allowed, present, and still not served off-machine');
  assert.ok(!res.body.equals(PIXEL), 'and no bytes of it leaked');
});

test('the unauthenticated card gives away only what dialing us would', async (t) => {
  // /lanchat/whoami answers anyone who can reach the port. It used to hand over
  // the display name, the avatar image, the hostname, the OS and the app version
  // — a fingerprint of the machine, for free. Discovery needs somewhere to dial
  // and something to check a key against; it does not need any of the rest.
  const port = await freePort();
  const A = makeNode('erin', port);
  await A.server.start();
  t.after(() => A.server.stop());

  const card = await new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/lanchat/whoami`, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(JSON.parse(body)));
      })
      .on('error', reject);
  });

  assert.equal(card.id, A.config.get('id'));
  assert.equal(card.servicePort, port, 'discovery still learns where to dial');
  assert.ok(card.proto >= 2, 'and what we speak');
  for (const leaked of ['avatar', 'hostname', 'platform', 'version', 'name']) {
    assert.ok(!(leaked in card), `${leaked} should not be handed to a stranger`);
  }
});

test('a picture an agent made still previews after a restart, on every platform', async (t) => {
  const port = await freePort();
  const A = makeNode('erin', port, false);
  const image = path.join(A.dir, 'graph.png');
  fs.writeFileSync(image, PIXEL);

  // An agent's answer from an earlier session. Nothing sent it and nothing
  // received it, so unlike a transferred file it was never in any list that a
  // restart could rebuild from — which is why store.mediaPaths() exists, and why
  // it is read on every platform rather than only on Windows.
  A.store.append('agent:1', {
    id: 'm1',
    peerId: 'agent:1',
    direction: 'in',
    kind: 'text',
    text: 'Here is the picture.',
    media: [{ name: 'graph.png', path: image, size: PIXEL.length, mime: 'image/png' }],
    ts: Date.now(),
  });

  const restarted = createServer({
    config: A.config,
    getIdentity: A.hub.getIdentity,
    hub: A.hub,
    bus: new EventEmitter(),
    downloadsDir: A.downloadsDir,
    store: A.store,
    windows: false,
  });
  await restarted.start();
  t.after(() => restarted.stop());

  const res = await get(port, image);
  assert.equal(res.status, 200, 'the picture is served rather than drawn as a broken thumbnail');
  assert.deepEqual(res.body, PIXEL);
});

test('a path nobody allowed is not served just because a message mentioned one', async (t) => {
  const port = await freePort();
  const A = makeNode('frank', port, false);
  const allowed = path.join(A.dir, 'graph.png');
  const other = path.join(A.dir, 'private.png');
  fs.writeFileSync(allowed, PIXEL);
  fs.writeFileSync(other, PIXEL);

  // Only what main itself wrote onto a message is re-allowed. A path sitting in
  // the *text* of a message — which is all a peer can ever put there, since the
  // media field is refused off the wire in ipc.js — reaches nothing.
  A.store.append('peer-1', {
    id: 'm1',
    peerId: 'peer-1',
    direction: 'in',
    kind: 'text',
    text: `MEDIA:${other}\n[open me](sandbox:${other})`,
    ts: Date.now(),
  });
  A.store.append('agent:1', {
    id: 'm2',
    peerId: 'agent:1',
    direction: 'in',
    kind: 'text',
    text: 'Here is the picture.',
    media: [{ name: 'graph.png', path: allowed, size: PIXEL.length, mime: 'image/png' }],
    ts: Date.now(),
  });

  // Started after the history is written, so both messages are seen by the same
  // seeding pass and the only thing separating them is which field they used.
  const restarted = createServer({
    config: A.config,
    getIdentity: A.hub.getIdentity,
    hub: A.hub,
    bus: new EventEmitter(),
    downloadsDir: A.downloadsDir,
    store: A.store,
    windows: false,
  });
  await restarted.start();
  t.after(() => restarted.stop());

  assert.equal((await get(port, other)).status, 404, 'a path a peer typed is still just text');
  assert.equal((await get(port, allowed)).status, 200, 'and the one main vouched for is not');
});

// ------------------------------------------------- where an arriving file lands

// One naming rule for everything that arrives from outside — a file a peer sent,
// a picture saved from the web — because they land in the same folder and the
// same two things have to be true of both: it cannot climb out of that folder,
// and it cannot erase what is already in it.
test('an arriving file cannot climb out of the downloads folder or overwrite it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-dest-'));

  // A name is a name, however it is dressed up.
  for (const [given, expected] of [
    ['holiday.png', 'holiday.png'],
    ['../../.bashrc', '.bashrc'],
    ['/etc/passwd', 'passwd'],
    ['a/b/c/graph.png', 'graph.png'],
    ['', 'file'],
    ['   ', 'file'],
    ['holiday.png ', 'holiday.png'],
    ['re:port*?.png', 're_port_.png'],
  ]) {
    const dest = uniqueDest(dir, given);
    assert.equal(path.dirname(dest), dir, `${given} escaped the folder`);
    assert.equal(path.basename(dest), expected, given);
  }

  // The second photo called graph.png is a second photo, not a replacement.
  fs.writeFileSync(path.join(dir, 'graph.png'), 'first');
  assert.equal(path.basename(uniqueDest(dir, 'graph.png')), 'graph (1).png');
  fs.writeFileSync(path.join(dir, 'graph (1).png'), 'second');
  assert.equal(path.basename(uniqueDest(dir, 'graph.png')), 'graph (2).png');
  assert.equal(fs.readFileSync(path.join(dir, 'graph.png'), 'utf8'), 'first', 'and the first is untouched');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a picture saved from the web is called what it was called there', () => {
  const { imageFilename } = require('../src/main/ipc.js');

  assert.equal(imageFilename('https://example.com/photos/graph.png', 'image/png'), 'graph.png');
  // The extension comes from what was actually served, not from what the URL
  // claimed — a path saying .png that arrives as a JPEG is a JPEG.
  assert.equal(imageFilename('https://example.com/photos/graph.png', 'image/jpeg'), 'graph.jpg');
  assert.equal(imageFilename('https://example.com/a/b.webp?v=2', 'image/webp; charset=binary'), 'b.webp');
  assert.equal(imageFilename('https://example.com/my%20graph.png', 'image/png'), 'my graph.png');
  // Nothing in the URL to take a name from, and nothing served to take an
  // extension from: honest rather than a guess.
  assert.equal(imageFilename('https://example.com/', 'image/png'), 'picture.png');
  assert.equal(imageFilename('https://example.com/a.png', 'application/octet-stream'), 'a');
  assert.equal(imageFilename('not a url', 'image/gif'), 'picture.gif');
});
