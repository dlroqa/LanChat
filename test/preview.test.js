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
const { buildIdentity } = require('../src/main/identity.js');
const { PeerHub } = require('../src/main/peers.js');
const { createServer } = require('../src/main/server.js');
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

function makeNode(name, port, windows = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lanchat-${name}-`));
  const config = new Config(dir);
  config.set({ displayName: name, servicePort: port });
  const bus = new EventEmitter();
  const getIdentity = () => buildIdentity(config);
  const store = new MessageStore(dir);
  const hub = new PeerHub({ getIdentity, bus });
  const downloadsDir = path.join(dir, 'downloads');
  const server = createServer({ config, getIdentity, hub, bus, downloadsDir, store, windows });
  return { dir, config, bus, store, hub, server, downloadsDir, port };
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
