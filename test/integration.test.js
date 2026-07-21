'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const { Config } = require('../src/main/config.js');
const { buildIdentity } = require('../src/main/identity.js');
const { PeerHub } = require('../src/main/peers.js');
const { createServer } = require('../src/main/server.js');
const { createFileSender } = require('../src/main/fileTransfer.js');
const { Outbox } = require('../src/main/outbox.js');
const { MessageStore } = require('../src/main/store.js');

function makeNode(name, port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lanchat-${name}-`));
  const config = new Config(dir);
  config.set({ displayName: name, servicePort: port });
  const bus = new EventEmitter();
  const getIdentity = () => buildIdentity(config);
  const downloadsDir = path.join(dir, 'downloads');
  const hub = new PeerHub({ getIdentity, bus });
  const server = createServer({ config, getIdentity, hub, bus, downloadsDir });
  const fileSender = createFileSender({ hub, getIdentity, bus });
  return { dir, config, bus, getIdentity, hub, server, fileSender, downloadsDir, port };
}

function waitFor(fn, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (fn()) {
        clearInterval(t);
        resolve();
      } else if (Date.now() - start > timeout) {
        clearInterval(t);
        reject(new Error('timeout'));
      }
    }, 25);
  });
}

test('two nodes connect, exchange a chat message, and transfer a file', async (t) => {
  const A = makeNode('alice', 47411);
  const B = makeNode('bob', 47412);
  await A.server.start();
  await B.server.start();

  t.after(() => {
    A.hub.close();
    B.hub.close();
    A.server.stop();
    B.server.stop();
  });

  const idB = B.getIdentity().id;
  const idA = A.getIdentity().id;

  // A dials B directly (as manual discovery would).
  A.hub.connect(idB, `127.0.0.1:${B.port}`);
  await waitFor(() => A.hub.isConnected(idB));

  // --- chat ---
  const chatReceived = new Promise((resolve) => {
    B.bus.on('peer-message', (msg) => {
      if (msg.type === 'chat') resolve(msg);
    });
  });
  const ok = A.hub.send(idB, { type: 'chat', text: 'hello bob' });
  assert.equal(ok, true, 'send should report delivered');
  const msg = await chatReceived;
  assert.equal(msg.text, 'hello bob');
  assert.equal(msg.from, idA);

  // --- file transfer ---
  const payload = crypto.randomBytes(200000);
  const srcFile = path.join(A.dir, 'photo.bin');
  fs.writeFileSync(srcFile, payload);

  const fileReceived = new Promise((resolve) => B.bus.on('file-received', resolve));
  await A.fileSender.send(idB, srcFile);
  const info = await fileReceived;

  const got = fs.readFileSync(info.path);
  assert.equal(got.length, payload.length, 'received size matches');
  assert.equal(
    crypto.createHash('sha256').update(got).digest('hex'),
    crypto.createHash('sha256').update(payload).digest('hex'),
    'checksum matches'
  );
});

// Regression: chat rides the existing socket, but file transfer opens a fresh
// HTTP connection and so needs a recorded address. A peer who was dialed *by*
// us never went through hub.connect(), so before the inbound-address fix in
// server.js it had no address and sending it a file failed outright.
test('the peer who accepted the connection can send a file back', async (t) => {
  const A = makeNode('carol', 47413);
  const B = makeNode('dave', 47414);
  await A.server.start();
  await B.server.start();

  t.after(() => {
    A.hub.close();
    B.hub.close();
    A.server.stop();
    B.server.stop();
  });

  const idA = A.getIdentity().id;
  const idB = B.getIdentity().id;

  // Only A dials. B learns about A purely from the inbound connection.
  A.hub.connect(idB, `127.0.0.1:${B.port}`);
  await waitFor(() => B.hub.isConnected(idA));

  assert.ok(B.hub.addresses.get(idA), 'B should have recorded the address A dialed in from');

  const payload = crypto.randomBytes(50000);
  const srcFile = path.join(B.dir, 'reply.bin');
  fs.writeFileSync(srcFile, payload);

  const fileReceived = new Promise((resolve) => A.bus.on('file-received', resolve));
  await B.fileSender.send(idA, srcFile);
  const info = await fileReceived;

  assert.equal(
    crypto.createHash('sha256').update(fs.readFileSync(info.path)).digest('hex'),
    crypto.createHash('sha256').update(payload).digest('hex'),
    'the file arrives intact in the reverse direction'
  );
});

// End-to-end for the offline queue: a message typed while the peer is
// unreachable must actually arrive over a real socket once they return, rather
// than merely claiming to have been queued.
test('a message typed while a peer is offline is delivered when they reconnect', async (t) => {
  const A = makeNode('erin', 47415);
  const B = makeNode('frank', 47416);
  await A.server.start();
  await B.server.start();

  const store = new MessageStore(A.dir);
  const outbox = new Outbox(A.dir, { hub: A.hub, bus: A.bus, store });
  outbox.start();

  t.after(() => {
    outbox.stop();
    A.hub.close();
    B.hub.close();
    A.server.stop();
    B.server.stop();
  });

  const idB = B.getIdentity().id;
  const idA = A.getIdentity().id;

  // B is not connected yet, so the send fails and the message is held.
  const message = { id: 'queued-1', peerId: idB, direction: 'out', kind: 'text', text: 'sent while away', ts: Date.now() };
  assert.equal(A.hub.send(idB, { type: 'chat', ...message }), false, 'nothing should reach an unconnected peer');
  store.append(idB, { ...message, pending: true });
  outbox.enqueue(idB, message);
  assert.equal(outbox.pendingCount(idB), 1);

  // Bounded: if the drain ever regresses, this must fail with a clear message
  // rather than hanging the suite forever waiting for a message that never comes.
  const received = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('queued message was never delivered')), 6000);
    B.bus.on('peer-message', (m) => {
      if (m.type === 'chat' && m.id === 'queued-1') {
        clearTimeout(timer);
        resolve(m);
      }
    });
  });

  // B comes online. Presence fires on socket registration, which drains the queue.
  A.hub.connect(idB, `127.0.0.1:${B.port}`);
  await waitFor(() => A.hub.isConnected(idB));

  const got = await received;
  assert.equal(got.text, 'sent while away');
  assert.equal(got.from, idA);
  await waitFor(() => outbox.pendingCount(idB) === 0);
  assert.equal(store.read(idB).find((m) => m.id === 'queued-1').pending, false, 'bubble is no longer queued');
});
