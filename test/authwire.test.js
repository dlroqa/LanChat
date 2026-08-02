'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

const { Config } = require('../src/main/config.js');
const { buildIdentity, buildPublicCard } = require('../src/main/identity.js');
const { PeerHub } = require('../src/main/peers.js');
const { createServer } = require('../src/main/server.js');
const { createDeviceKey } = require('../src/main/deviceKey.js');
const { createPins } = require('../src/main/pins.js');
const { createGrants, attachGrantIssuer } = require('../src/main/grants.js');
const proto = require('../src/main/authProto.js');

// The handshake against a hostile client, over real sockets.
//
// auth.test.js proves the primitives in isolation; this proves the wiring, which
// is where the interesting failures live. A transcript can be perfect and still
// be checked after the socket was registered, or checked against a nonce the
// attacker supplied, or not checked at all on one of the two directions.
//
// Every test here is an attack that succeeds against the code as it was before
// this change.

// Ports are asked for rather than hardcoded — `node --test` runs files
// concurrently and fixed numbers collide. Same reasoning as integration.test.js,
// copied rather than shared: a common harness would have to touch every socket
// test file, which is not something to do in the same change as the wire format.
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

function makeNode(name, port, dir = null) {
  const home = dir || fs.mkdtempSync(path.join(os.tmpdir(), `lanchat-auth-${name}-`));
  const config = new Config(home);
  config.set({ displayName: name, servicePort: port });
  const bus = new EventEmitter();
  const getIdentity = () => buildIdentity(config);
  const deviceKey = createDeviceKey({ userDataDir: home });
  const pins = createPins({ userDataDir: home });
  const getPublicCard = () => buildPublicCard(config, deviceKey);
  const hub = new PeerHub({ getIdentity, bus, deviceKey, pins });
  const grants = createGrants();
  const server = createServer({
    config,
    getIdentity,
    getPublicCard,
    deviceKey,
    pins,
    grants,
    hub,
    bus,
    downloadsDir: path.join(home, 'dl'),
  });
  attachGrantIssuer({ hub, bus, grants });
  const failures = [];
  const alarms = [];
  bus.on('peer-auth-failed', (e) => failures.push(e));
  bus.on('peer-key-alarm', (e) => alarms.push(e));
  return {
    dir: home,
    config,
    bus,
    getIdentity,
    deviceKey,
    pins,
    hub,
    server,
    port,
    failures,
    alarms,
    grants,
  };
}

function waitFor(fn, ms = 5000, what = 'condition') {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      let v;
      try {
        v = fn();
      } catch {
        v = false;
      }
      if (v) {
        clearInterval(tick);
        resolve(v);
      } else if (Date.now() - started > ms) {
        clearInterval(tick);
        reject(new Error(`timed out waiting for ${what}`));
      }
    }, 25);
  });
}

// A client that speaks the protocol by hand, so it can lie.
function attacker(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/lanchat/ws`);
  const frames = [];
  let closeInfo = null;
  ws.on('message', (raw) => {
    try {
      frames.push(JSON.parse(raw.toString()));
    } catch {
      /* ignore */
    }
  });
  ws.on('close', (code, reason) => {
    closeInfo = { code, reason: reason.toString() };
  });
  ws.on('error', () => {});
  return {
    ws,
    frames,
    closed: () => closeInfo,
    send: (obj) => ws.send(JSON.stringify(obj)),
    open: () => new Promise((r) => (ws.readyState === WebSocket.OPEN ? r() : ws.on('open', r))),
    serverHello: () => waitFor(() => frames.find((f) => f.type === 'hello'), 5000, 'the server hello'),
    close: () => {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    },
  };
}

// Build a client hello the way an honest peer would, with the pieces exposed so
// a test can corrupt exactly one of them.
function clientHello({
  serverHello,
  id,
  key,
  kx = proto.generateAgreementKey(),
  nonce = proto.newNonce(),
  role = proto.ROLE_CLIENT,
}) {
  const t = proto.transcript({
    role,
    proto: proto.PROTO,
    nonceS: serverHello.auth.nonce,
    nonceC: nonce,
    keyS: serverHello.auth.key,
    keyC: key.publicKey,
    kxS: serverHello.auth.kx,
    kxC: kx.publicKey,
    idS: serverHello.from,
    idC: id,
  });
  const sig = proto.sign(key.privateKey, t);
  return {
    frame: {
      type: 'hello',
      proto: proto.PROTO,
      from: id,
      identity: { id, name: id, servicePort: 1, publicKey: key.publicKey, proto: proto.PROTO },
      auth: { nonce, key: key.publicKey, kx: kx.publicKey, sig },
    },
    transcript: t,
    nonce,
    kx,
  };
}

// Both directions, because the two ends do not register at the same moment.
//
// The server registers when it has verified the client's proof — before it has
// sent its own. The dialer registers only after verifying that proof in reply.
// So there is a window in which the accepting side already shows the peer as
// connected and the dialing side does not, and a test that closed the dialer's
// hub in that window would close nothing at all and then wait forever for a
// socket that was never told to go. That is not hypothetical: it is what failed
// on macOS, having passed everywhere else.
async function bothConnected(dialer, accepter, ms = 15000) {
  const idDialer = dialer.getIdentity().id;
  const idAccepter = accepter.getIdentity().id;
  await waitFor(() => accepter.hub.isConnected(idDialer), ms, 'the accepting side to register');
  await waitFor(() => dialer.hub.isConnected(idAccepter), ms, 'the dialing side to register');
}

// -------------------------------------------------------------- happy path

test('two nodes authenticate each other and pin what they saw', async (t) => {
  const [pa, pb] = [await freePort(), await freePort()];
  const A = makeNode('alice', pa);
  const B = makeNode('bob', pb);
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
  A.hub.connect(idB, `127.0.0.1:${pb}`);
  await waitFor(() => A.hub.isConnected(idB), 5000, 'the dial to authenticate');
  await waitFor(() => B.hub.isConnected(idA), 5000, 'the reverse registration');

  // Each end pinned the other's real key, and neither pinned anything else.
  assert.equal(A.pins.get(idB).key, B.deviceKey.publicKey());
  assert.equal(B.pins.get(idA).key, A.deviceKey.publicKey());
  assert.equal(A.pins.get(idB).verified, false, 'first use is trust, not verification');
  assert.deepEqual(A.failures, []);
});

test('nothing sent on the back of a completed handshake is lost to it', async (t) => {
  // The two ends cannot finish at the same instant: the accepting side is
  // satisfied one frame before the dialer is, and in that gap it already
  // considers the peer connected while the dialer is still dropping frames.
  //
  // What saves it is that the proof is written to the socket before `peer-hello`
  // is emitted, so anything that event triggers is queued behind the frame that
  // authorises it. That ordering is one line in server.js and nothing about it
  // looks important. This is what fails if somebody tidies it.
  const pa = await freePort();
  const pb = await freePort();
  const A = makeNode('alice', pa);
  const B = makeNode('bob', pb);
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

  // Bob answers a completed handshake by immediately sending something, the way
  // the agent hub announces its shared agents on `peer-hello`.
  B.bus.on('peer-hello', ({ peerId }) => {
    B.hub.send(peerId, { type: 'agent-advert', agentId: 'a1', name: 'Hermes' });
  });

  const seen = [];
  A.bus.on('peer-message', (msg) => seen.push(msg));

  A.hub.connect(idB, `127.0.0.1:${pb}`);
  await bothConnected(A, B);

  await waitFor(() => seen.some((m) => m.type === 'agent-advert'), 15000, 'the advert to arrive');
  const advert = seen.find((m) => m.type === 'agent-advert');
  assert.equal(advert.from, idB, 'and attributed to the socket it came in on');
  assert.ok(B.hub.isConnected(idA));
});

// ------------------------------------------------------------ impersonation

test('a stranger cannot take a peer id it does not hold the key for', async (t) => {
  // The attack the whole change exists to stop. The id is broadcast over UDP
  // every three seconds and served by /lanchat/whoami, so knowing one is not a
  // secret — it used to be sufficient.
  const pb = await freePort();
  const B = makeNode('bob', pb);
  await B.server.start();
  t.after(() => {
    B.hub.close();
    B.server.stop();
  });

  // B already knows alice.
  const idA = 'alice-uuid';
  const realA = proto.generateSigningKey();
  B.pins.pin(idA, realA.publicKey, { name: 'Alice' });

  const M = attacker(pb);
  await M.open();
  const hello = await M.serverHello();
  const mallory = proto.generateSigningKey();
  // A perfectly-formed proof — of Mallory's own key, under Alice's id.
  M.send(clientHello({ serverHello: hello, id: idA, key: mallory }).frame);

  await waitFor(() => M.closed(), 5000, 'the refusal');
  assert.equal(M.closed().code, 4401);
  assert.ok(!B.hub.isConnected(idA), 'nothing was registered');
  assert.equal(B.pins.get(idA).key, realA.publicKey, 'and the real pin is untouched');
  assert.equal(B.alarms[0].reason, 'key-changed');
  M.close();
});

test('a refusal tells the wire nothing about why', async (t) => {
  // The roster gets to be helpful — "ask them to update" — precisely because
  // the far end never learns which of the several failures it hit. Otherwise
  // the diagnostic is an oracle for probing what we know.
  const pb = await freePort();
  const B = makeNode('bob', pb);
  await B.server.start();
  t.after(() => {
    B.hub.close();
    B.server.stop();
  });
  B.pins.pin('alice-uuid', proto.generateSigningKey().publicKey);

  const reasons = new Set();
  for (const attempt of ['key-changed', 'bad-signature', 'older-lanchat']) {
    const M = attacker(pb);
    await M.open();
    const hello = await M.serverHello();
    if (attempt === 'key-changed') {
      M.send(clientHello({ serverHello: hello, id: 'alice-uuid', key: proto.generateSigningKey() }).frame);
    } else if (attempt === 'bad-signature') {
      const built = clientHello({ serverHello: hello, id: 'nobody', key: proto.generateSigningKey() });
      built.frame.auth.sig = Buffer.alloc(64).toString('base64');
      M.send(built.frame);
    } else {
      M.send({ type: 'hello', from: 'old-peer', identity: { id: 'old-peer', name: 'Old' } });
    }
    await waitFor(() => M.closed(), 5000, `the refusal of ${attempt}`);
    const fail = M.frames.find((f) => f.type === 'auth-fail');
    reasons.add(fail ? fail.reason : '(none)');
    assert.equal(M.closed().code, 4401, `${attempt} closes the same way`);
    M.close();
  }
  assert.deepEqual([...reasons], ['refused'], 'every failure looks identical from outside');

  // And locally, they are all distinguishable.
  assert.deepEqual(B.failures.map((f) => f.reason).sort(), ['bad-signature', 'key-changed', 'older-lanchat']);
});

test('an old build is refused, and named as an old build rather than an attack', async (t) => {
  // An attacker who simply omits the proof is indistinguishable from a peer
  // running 0.4.24 — so both are refused, identically, and the shape only picks
  // which sentence the roster shows. The friendlier string is the one an
  // attacker gets, which costs nothing because it never leaves the machine.
  const pb = await freePort();
  const B = makeNode('bob', pb);
  await B.server.start();
  t.after(() => {
    B.hub.close();
    B.server.stop();
  });

  const old = attacker(pb);
  await old.open();
  await old.serverHello();
  // Exactly what 0.4.24 sends.
  old.send({
    type: 'hello',
    from: 'legacy-uuid',
    identity: { id: 'legacy-uuid', name: 'Legacy', servicePort: 1 },
  });

  await waitFor(() => old.closed(), 5000, 'the refusal');
  assert.ok(!B.hub.isConnected('legacy-uuid'));
  assert.equal(B.failures.at(-1).reason, 'older-lanchat');
  old.close();
});

// ----------------------------------------------------------------- replay

test('REPLAY: a captured proof is worthless on a second connection', async (t) => {
  const pb = await freePort();
  const B = makeNode('bob', pb);
  await B.server.start();
  t.after(() => {
    B.hub.close();
    B.server.stop();
  });

  // A genuine handshake, captured.
  const key = proto.generateSigningKey();
  const first = attacker(pb);
  await first.open();
  const hello1 = await first.serverHello();
  const built = clientHello({ serverHello: hello1, id: 'alice-uuid', key });
  first.send(built.frame);
  await waitFor(() => B.hub.isConnected('alice-uuid'), 5000, 'the honest handshake');
  first.close();
  await waitFor(() => !B.hub.isConnected('alice-uuid'), 5000, 'the socket to drop');

  // The identical frame, replayed against a fresh connection with a fresh nonce.
  const replay = attacker(pb);
  await replay.open();
  await replay.serverHello();
  replay.send(built.frame);

  await waitFor(() => replay.closed(), 5000, 'the replay to be refused');
  assert.ok(!B.hub.isConnected('alice-uuid'));
  assert.equal(B.failures.at(-1).reason, 'bad-signature');
  replay.close();
});

test('REPLAY: a nonce the peer supplied for us is ignored', async (t) => {
  // The verifier substitutes the nonce *it* generated rather than reading one
  // back off the peer's frame. If it did not, an attacker could pin the server
  // nonce to a captured value and every replay would verify.
  const pb = await freePort();
  const B = makeNode('bob', pb);
  await B.server.start();
  t.after(() => {
    B.hub.close();
    B.server.stop();
  });

  const key = proto.generateSigningKey();
  const M = attacker(pb);
  await M.open();
  const hello = await M.serverHello();

  // Sign a transcript using a server nonce of our choosing, and tell the server
  // that is what it sent.
  const forgedServerHello = { ...hello, auth: { ...hello.auth, nonce: proto.newNonce() } };
  const built = clientHello({ serverHello: forgedServerHello, id: 'alice-uuid', key });
  M.send(built.frame);

  await waitFor(() => M.closed(), 5000, 'the refusal');
  assert.ok(!B.hub.isConnected('alice-uuid'));
  assert.equal(B.failures.at(-1).reason, 'bad-signature');
  M.close();
});

// -------------------------------------------------------------- reflection

test('REFLECTION: the server proof cannot be bounced back as a client proof', async (t) => {
  // Open a socket, let the server prove itself, then open a second socket and
  // offer that same signature as our own. Without the role byte in the
  // transcript this works — both sides would be signing the same tuple.
  const pa = await freePort();
  const pb = await freePort();
  const A = makeNode('alice', pa);
  const B = makeNode('bob', pb);
  await A.server.start();
  await B.server.start();
  t.after(() => {
    A.hub.close();
    B.hub.close();
    A.server.stop();
    B.server.stop();
  });

  // Get a genuine server proof out of B by completing a handshake as ourselves.
  const key = proto.generateSigningKey();
  const one = attacker(pb);
  await one.open();
  const hello = await one.serverHello();
  const honest = clientHello({ serverHello: hello, id: 'mallory-uuid', key });
  one.send(honest.frame);
  const serverProof = await waitFor(() => one.frames.find((f) => f.type === 'auth'), 5000, "B's proof");

  // Now claim B's own id back at it, offering B's signature as our client proof.
  const two = attacker(pb);
  await two.open();
  const hello2 = await two.serverHello();
  two.send({
    type: 'hello',
    proto: proto.PROTO,
    from: hello2.from,
    identity: {
      id: hello2.from,
      name: 'bob',
      servicePort: 1,
      publicKey: hello2.auth.key,
      proto: proto.PROTO,
    },
    auth: { nonce: hello.auth.nonce, key: hello2.auth.key, kx: hello.auth.kx, sig: serverProof.sig },
  });

  await waitFor(() => two.closed(), 5000, 'the reflected proof to be refused');
  assert.equal(B.failures.at(-1).reason, 'bad-signature');
  one.close();
  two.close();
});

// --------------------------------------------------------------- id in use

test('a second socket for a live peer is fine under the same key, refused under another', async (t) => {
  // Two sockets for one id is ordinary: both ends dial each other and both
  // succeed, and the agent-sharing suite depends on it. So the rule cannot be
  // "refuse a second socket" — it has to be "refuse a different key".
  const pb = await freePort();
  const B = makeNode('bob', pb);
  await B.server.start();
  t.after(() => {
    B.hub.close();
    B.server.stop();
  });

  const key = proto.generateSigningKey();
  const first = attacker(pb);
  await first.open();
  first.send(clientHello({ serverHello: await first.serverHello(), id: 'alice-uuid', key }).frame);
  await waitFor(() => B.hub.isConnected('alice-uuid'), 5000, 'the first socket');

  // Same peer, same key, second socket — accepted.
  const second = attacker(pb);
  await second.open();
  second.send(clientHello({ serverHello: await second.serverHello(), id: 'alice-uuid', key }).frame);
  await waitFor(() => B.hub.sockets.get('alice-uuid').size === 2, 5000, 'the second socket');
  assert.ok(B.hub.keyAgrees('alice-uuid', key.publicKey));

  // Different key for a live id — refused.
  const impostor = attacker(pb);
  await impostor.open();
  impostor.send(
    clientHello({
      serverHello: await impostor.serverHello(),
      id: 'alice-uuid',
      key: proto.generateSigningKey(),
    }).frame
  );
  await waitFor(() => impostor.closed(), 5000, 'the impostor to be refused');
  assert.equal(B.hub.sockets.get('alice-uuid').size, 2, 'the honest sockets are untouched');

  first.close();
  second.close();
  impostor.close();
});

// ---------------------------------------------------------------- teardown

test('a peer that goes away is seen to go away, promptly', async (t) => {
  // `hub.close()` used to only ask for a graceful close: a frame out, the
  // peer's reply back, and the socket alive until that round trip finished.
  // This side cleared its roster immediately, so the far end went on showing us
  // online for however long that took — seconds on a loaded machine, and
  // forever against a peer that had stopped answering.
  //
  // It surfaced as a Windows-only CI failure in the key-change test below, which
  // waits for exactly this. Timing out there was the symptom; the delay was the
  // bug, and it applied to every shutdown rather than to the test.
  const [pa, pb] = [await freePort(), await freePort()];
  const A = makeNode('alice', pa);
  const B = makeNode('bob', pb);
  await A.server.start();
  await B.server.start();
  t.after(() => {
    A.hub.close();
    B.hub.close();
    A.server.stop();
    B.server.stop();
  });

  const idA = A.getIdentity().id;
  A.hub.connect(B.getIdentity().id, `127.0.0.1:${pb}`);
  await bothConnected(A, B);

  const started = Date.now();
  A.hub.close();
  await waitFor(() => !B.hub.isConnected(idA), 15000, 'the peer to drop off the roster');
  const took = Date.now() - started;

  // Generous, because CI runners are slow and this is not a benchmark. The
  // failure it guards against is measured in whole seconds, or in never.
  assert.ok(took < 3000, `the peer took ${took}ms to be seen as gone`);
  assert.equal(A.hub.keys.size, 0, 'and this side let go of the key binding too');
});

test('a reinstalled peer gets the key alarm even if its old socket is still around', async (t) => {
  // The one Windows CI found, and it is a product bug rather than a test one.
  //
  // The live-socket key binding used to outlive the socket: until the old
  // connection was reaped, a peer coming back with a new key was refused as
  // "id in use". That is precisely the reinstall — same id, new key, innocent —
  // and it is the case where the user most needs the alarm, because the alarm is
  // the only thing that shows them the fingerprints and offers a re-pin. They
  // got "could not be verified" and no way forward.
  //
  // Linux and macOS hid it by reaping the socket first. The binding is now
  // checked against whether a socket is actually holding it.
  const pb = await freePort();
  const B = makeNode('bob', pb);
  await B.server.start();
  t.after(() => {
    B.hub.close();
    B.server.stop();
  });

  const idA = 'alice-uuid';
  const oldKey = proto.generateSigningKey();
  const newKey = proto.generateSigningKey();

  // Alice connects and is pinned.
  const first = attacker(pb);
  await first.open();
  first.send(clientHello({ serverHello: await first.serverHello(), id: idA, key: oldKey }).frame);
  await waitFor(() => B.hub.isConnected(idA), 15000, 'the first handshake');
  assert.equal(B.pins.get(idA).key, oldKey.publicKey);

  // Her socket goes, but B has not processed the close yet — simulated exactly,
  // rather than raced for, by dropping the socket without letting B catch up.
  first.ws.terminate();
  await waitFor(() => !B.hub.isConnected(idA), 15000, 'the socket to drop');

  // She reinstalls and comes back with a different key.
  const second = attacker(pb);
  await second.open();
  second.send(clientHello({ serverHello: await second.serverHello(), id: idA, key: newKey }).frame);

  await waitFor(() => B.alarms.length > 0, 15000, 'the key-change alarm');
  const alarm = B.alarms.at(-1);
  assert.equal(alarm.reason, 'key-changed', 'the alarm the user can act on, not a bare refusal');
  assert.equal(alarm.known, oldKey.publicKey);
  assert.equal(alarm.offered, newKey.publicKey);
  assert.equal(B.pins.get(idA).key, oldKey.publicKey, 'and the pin did not move on its own');
  second.close();
});

test('a stale binding never lets a live impostor through', async (t) => {
  // The other half of the same rule: while a socket IS holding an id, a second
  // socket under a different key is still refused. Relaxing the stale case must
  // not relax this one.
  const pb = await freePort();
  const B = makeNode('bob', pb);
  await B.server.start();
  t.after(() => {
    B.hub.close();
    B.server.stop();
  });

  const idA = 'alice-uuid';
  const realKey = proto.generateSigningKey();
  const live = attacker(pb);
  await live.open();
  live.send(clientHello({ serverHello: await live.serverHello(), id: idA, key: realKey }).frame);
  await waitFor(() => B.hub.isConnected(idA), 15000, 'the honest socket');

  const impostor = attacker(pb);
  await impostor.open();
  impostor.send(
    clientHello({ serverHello: await impostor.serverHello(), id: idA, key: proto.generateSigningKey() }).frame
  );
  await waitFor(() => impostor.closed(), 15000, 'the impostor to be refused');
  assert.ok(B.hub.isConnected(idA), 'the honest socket is untouched');
  assert.equal(B.hub.keys.get(idA), realKey.publicKey, 'and still holds the real key');
  live.close();
  impostor.close();
});

// -------------------------------------------------------------- key change

test('a peer whose key changed is refused, loudly, without losing the history', async (t) => {
  const pa = await freePort();
  const pb = await freePort();
  const A = makeNode('alice', pa);
  const B = makeNode('bob', pb);
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
  A.hub.connect(idB, `127.0.0.1:${pb}`);
  await bothConnected(A, B);
  const originalKey = A.deviceKey.publicKey();
  assert.equal(B.pins.get(idA).key, originalKey);

  A.hub.close();
  A.server.stop();
  await waitFor(() => !B.hub.isConnected(idA), 15000, 'the socket to drop');

  // Alice reinstalls: same userData, same UUID, but the key file is gone. This
  // is indistinguishable from an impostor, and is treated as one.
  fs.rmSync(A.deviceKey.file);
  const A2 = makeNode('alice', pa, A.dir);
  await A2.server.start();
  t.after(() => {
    A2.hub.close();
    A2.server.stop();
  });
  assert.notEqual(A2.deviceKey.publicKey(), originalKey);
  assert.equal(A2.getIdentity().id, idA, 'the id is the same, which is the point');

  A2.hub.connect(idB, `127.0.0.1:${pb}`);
  // `node --test` runs files concurrently, so these reconnect legs contend with
  // the other socket suites. Generous rather than tight: a timeout here would
  // report as a security regression when it is only a busy machine.
  await waitFor(() => B.alarms.length > 0, 15000, 'the alarm');
  const alarm = B.alarms.at(-1);
  assert.equal(alarm.reason, 'key-changed');
  assert.equal(alarm.known, originalKey, 'the alarm carries both keys, for comparison');
  assert.equal(alarm.offered, A2.deviceKey.publicKey());
  assert.ok(!B.hub.isConnected(idA), 'and nothing connected');
  assert.equal(B.pins.get(idA).key, originalKey, 'the pin did not move on its own');

  // Re-pinning is deliberate and separate, and it costs the verification.
  B.pins.repin(idA, A2.deviceKey.publicKey());
  A2.hub.connect(idB, `127.0.0.1:${pb}`);
  await waitFor(() => B.hub.isConnected(idA), 15000, 'the connection after re-pinning');
  assert.equal(B.pins.get(idA).prevKeys.length, 1, 'the old key is kept as evidence');
});

// ---------------------------------------------------------------- timeouts

test('a socket that never authenticates is closed rather than held', async (t) => {
  const pb = await freePort();
  const B = makeNode('bob', pb);
  await B.server.start();
  t.after(() => {
    B.hub.close();
    B.server.stop();
  });

  const idle = attacker(pb);
  await idle.open();
  await idle.serverHello();
  // Say nothing at all.
  await waitFor(() => idle.closed(), 12000, 'the auth timeout');
  assert.equal(B.failures.at(-1).reason, 'timed-out');
  idle.close();
});

test('a dial that is accepted and then ignored does not wedge the peer', async (t) => {
  // The client no longer speaks on open — it cannot sign a nonce it has not
  // been given — so a server that accepts the upgrade and says nothing would
  // hold the peer in `dialing` forever, where nothing retries it. This is the
  // regression guard for that.
  const pa = await freePort();
  const A = makeNode('alice', pa);
  t.after(() => A.hub.close());

  const silentPort = await freePort();
  const { WebSocketServer } = require('ws');
  const silent = new WebSocketServer({ port: silentPort, path: '/lanchat/ws' });
  silent.on('connection', () => {
    /* accept, and say nothing */
  });
  t.after(() => silent.close());

  A.hub.connect('ghost-uuid', `127.0.0.1:${silentPort}`);
  await waitFor(() => A.hub.dialing.has('ghost-uuid'), 3000, 'the dial to start');
  await waitFor(() => !A.hub.dialing.has('ghost-uuid'), 12000, 'the dial to be given up');
  assert.equal(A.failures.at(-1).reason, 'timed-out');
});

// ------------------------------------------------------------ file uploads

// A raw POST to /lanchat/files, the way an attacker with curl would.
function upload(port, { headers = {}, body = Buffer.alloc(0) } = {}) {
  const http = require('node:http');
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/lanchat/files',
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length, ...headers },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, body: text }));
      }
    );
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.end(body);
  });
}

test('an upload with no permit writes nothing and is filed under nobody', async (t) => {
  // One curl used to be enough: the sender came from a header on a fresh TCP
  // connection, so the body landed in ~/Downloads and the message was filed
  // into whatever conversation the header named.
  const pb = await freePort();
  const B = makeNode('bob', pb);
  await B.server.start();
  t.after(() => {
    B.hub.close();
    B.server.stop();
  });

  const received = [];
  B.bus.on('file-received', (i) => received.push(i));

  const res = await upload(pb, {
    headers: {
      'x-lanchat-from': 'alice-uuid',
      'x-lanchat-name': 'Alice',
      'x-lanchat-filename': 'invoice.pdf',
    },
    body: Buffer.from('malicious'),
  });

  assert.equal(res.status, 401);
  assert.deepEqual(received, [], 'nothing was filed into any conversation');
  const dl = path.join(B.dir, 'dl');
  assert.ok(!fs.existsSync(dl) || fs.readdirSync(dl).length === 0, 'and nothing reached the disk');
});

test('a permit is single use, and names the sender the header cannot', async (t) => {
  const pb = await freePort();
  const B = makeNode('bob', pb);
  await B.server.start();
  t.after(() => {
    B.hub.close();
    B.server.stop();
  });

  const permit = B.grants.issue({ peerId: 'alice-uuid', transferId: 't-1', maxBytes: 32 });
  const received = [];
  B.bus.on('file-received', (i) => received.push(i));

  // The header lies about who is sending. The permit is believed instead.
  const ok = await upload(pb, {
    headers: {
      'x-lanchat-grant': permit.token,
      'x-lanchat-from': 'somebody-else',
      'x-lanchat-filename': 'note.txt',
    },
    body: Buffer.from('hello'),
  });
  assert.equal(ok.status, 200);
  await waitFor(() => received.length === 1, 5000, 'the file to be filed');
  assert.equal(received[0].from, 'alice-uuid', 'filed under the peer the permit was issued to');

  // The same permit again is worthless — otherwise a captured upload is a
  // standing write permit.
  const replay = await upload(pb, {
    headers: { 'x-lanchat-grant': permit.token, 'x-lanchat-filename': 'again.txt' },
    body: Buffer.from('hello'),
  });
  assert.equal(replay.status, 401);
  assert.equal(received.length, 1);
});

test('a file bigger than it claimed is cut off and cleaned up', async (t) => {
  // There was no size limit at all: the body was piped to disk unconditionally
  // and the declared size only drove a progress bar, so any peer could fill it.
  const pb = await freePort();
  const B = makeNode('bob', pb);
  await B.server.start();
  t.after(() => {
    B.hub.close();
    B.server.stop();
  });

  const permit = B.grants.issue({ peerId: 'alice-uuid', transferId: 't-2', maxBytes: 10 });
  const refused = [];
  const received = [];
  B.bus.on('file-refused', (i) => refused.push(i));
  B.bus.on('file-received', (i) => received.push(i));

  const res = await upload(pb, {
    headers: { 'x-lanchat-grant': permit.token, 'x-lanchat-filename': 'huge.bin', 'x-lanchat-size': '10' },
    // Well past the declared size plus the slack the grant allows.
    body: Buffer.alloc(300 * 1024, 7),
  });

  assert.ok(res.status === 413 || res.status === 0, `expected a refusal, got ${res.status}`);
  await waitFor(() => refused.length === 1, 5000, 'the refusal');
  assert.deepEqual(received, [], 'a truncated file is never announced as received');
  const dl = path.join(B.dir, 'dl');
  const left = fs.existsSync(dl) ? fs.readdirSync(dl) : [];
  assert.deepEqual(left, [], 'and the partial write was cleaned up');
});

test('dialing a peer that answers as somebody else is refused', async (t) => {
  // We dialled an address expecting a particular peer. It answering as somebody
  // else used to be silently accepted as "reconcile", which handed whoever held
  // the address the right to decide who they were.
  const pa = await freePort();
  const pb = await freePort();
  const A = makeNode('alice', pa);
  const B = makeNode('bob', pb);
  await B.server.start();
  t.after(() => {
    A.hub.close();
    B.hub.close();
    B.server.stop();
  });

  A.hub.connect('somebody-we-expected', `127.0.0.1:${pb}`);
  await waitFor(() => A.failures.length > 0, 5000, 'the refusal');
  assert.equal(A.failures.at(-1).reason, 'id-in-use');
  assert.ok(!A.hub.isConnected(B.getIdentity().id), 'it did not quietly become the other peer');
});
