'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { Outbox, MAX_PER_PEER } = require('../src/main/outbox.js');
const { MessageStore } = require('../src/main/store.js');

// A PeerHub stand-in whose reachability and send success are controllable.
function fakeHub() {
  const online = new Set();
  const sent = [];
  return {
    online,
    sent,
    isConnected: (id) => online.has(id),
    send: (id, obj) => {
      if (!online.has(id)) return false;
      sent.push({ id, obj });
      return true;
    },
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-outbox-'));
  const bus = new EventEmitter();
  const hub = fakeHub();
  const store = new MessageStore(dir);
  const outbox = new Outbox(dir, { hub, bus, store });
  return { dir, bus, hub, store, outbox };
}

function msg(id, text, ts = Date.now()) {
  return { id, peerId: 'bob', direction: 'out', kind: 'text', text, ts };
}

test('a message for an offline peer is held rather than lost', () => {
  const { outbox } = setup();
  outbox.enqueue('bob', msg('m1', 'hello'));
  assert.equal(outbox.pendingCount('bob'), 1);
});

test('flushing does nothing while the peer is still unreachable', () => {
  const { outbox, hub } = setup();
  outbox.enqueue('bob', msg('m1', 'hello'));
  assert.equal(outbox.flush('bob'), 0);
  assert.equal(hub.sent.length, 0, 'nothing should go on the wire');
  assert.equal(outbox.pendingCount('bob'), 1, 'and it must stay queued');
});

test('the queue drains when the peer comes back', () => {
  const { outbox, hub } = setup();
  outbox.enqueue('bob', msg('m1', 'one'));
  outbox.enqueue('bob', msg('m2', 'two'));
  hub.online.add('bob');
  assert.equal(outbox.flush('bob'), 2);
  assert.equal(outbox.pendingCount('bob'), 0);
  assert.deepEqual(hub.sent.map((s) => s.obj.text), ['one', 'two'], 'in the order they were typed');
});

test('presence is what triggers the drain, with no explicit flush call', () => {
  const { outbox, hub, bus } = setup();
  outbox.start();
  outbox.enqueue('bob', msg('m1', 'hello'));
  hub.online.add('bob');
  bus.emit('presence', []); // what PeerHub emits when a socket registers
  assert.equal(outbox.pendingCount('bob'), 0);
  assert.equal(hub.sent.length, 1);
  outbox.stop();
});

// Ordering matters more than throughput: a queue that delivered out of order
// would read as a scrambled conversation.
test('a mid-queue send failure stops the drain and preserves order', () => {
  const { outbox, hub } = setup();
  outbox.enqueue('bob', msg('m1', 'one'));
  outbox.enqueue('bob', msg('m2', 'two'));
  outbox.enqueue('bob', msg('m3', 'three'));
  hub.online.add('bob');

  let calls = 0;
  const realSend = hub.send;
  hub.send = (id, obj) => {
    calls += 1;
    if (calls === 2) return false; // link drops mid-flush
    return realSend(id, obj);
  };

  assert.equal(outbox.flush('bob'), 1, 'only the first got through');
  assert.equal(outbox.pendingCount('bob'), 2, 'the rest stay queued');

  hub.send = realSend;
  assert.equal(outbox.flush('bob'), 2);
  assert.deepEqual(hub.sent.map((s) => s.obj.text), ['one', 'two', 'three'], 'order survives the interruption');
});

test('the queue survives a restart', () => {
  const { dir, bus, hub, store, outbox } = setup();
  outbox.enqueue('bob', msg('m1', 'written before the crash'));

  // A fresh instance over the same directory, as if the app had restarted.
  const revived = new Outbox(dir, { hub, bus, store });
  assert.equal(revived.pendingCount('bob'), 1);
  hub.online.add('bob');
  assert.equal(revived.flush('bob'), 1);
  assert.equal(hub.sent[0].obj.text, 'written before the crash');
});

test('delivery clears the pending flag on the stored message', () => {
  const { outbox, hub, store } = setup();
  const m = { ...msg('m1', 'hello'), pending: true };
  store.append('bob', m);
  outbox.enqueue('bob', m);

  hub.online.add('bob');
  outbox.flush('bob');

  const stored = store.read('bob').find((x) => x.id === 'm1');
  assert.equal(stored.pending, false, 'the bubble must stop showing as queued');
  assert.equal(stored.delivered, true);
});

test('a queue for a peer who never returns is bounded', () => {
  const { outbox } = setup();
  for (let i = 0; i < MAX_PER_PEER + 25; i += 1) outbox.enqueue('bob', msg(`m${i}`, `msg ${i}`));
  assert.equal(outbox.pendingCount('bob'), MAX_PER_PEER);
});

test('counts are reported per peer for the roster badge', () => {
  const { outbox } = setup();
  outbox.enqueue('bob', msg('m1', 'a'));
  outbox.enqueue('bob', msg('m2', 'b'));
  outbox.enqueue('carol', msg('m3', 'c'));
  assert.deepEqual(outbox.counts(), { bob: 2, carol: 1 });
});
