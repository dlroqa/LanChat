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
