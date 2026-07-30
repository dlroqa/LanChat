'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { PeerHub } = require('../src/main/peers.js');

// Presence is the one path every roster change funnels through, and listeners on
// it are allowed to change the roster themselves — that is how a departed owner's
// agents are dropped. That makes re-entrancy a permanent property of this code
// rather than a mistake someone made once, so these tests pin the guarantees the
// hub owes its listeners. A change that breaks any of them takes the main process
// down with it, which is exactly what happened in 0.4.21.

const ME = 'me';

function makeHub() {
  const bus = new EventEmitter();
  bus.setMaxListeners(50);
  const hub = new PeerHub({ getIdentity: () => ({ id: ME }), bus });
  return { hub, bus };
}

// Stands in for a real peer: presenceList() reports anyone with a known identity.
function addPeer(hub, id) {
  hub.identities.set(id, { id, name: id });
}

test('an ordinary emit still fires once, synchronously', () => {
  const { hub, bus } = makeHub();
  addPeer(hub, 'p1');
  const seen = [];
  bus.on('presence', (list) => seen.push(list));

  hub.emitPresence();

  // The guard must not change the common path in any way a caller could notice.
  assert.equal(seen.length, 1, 'exactly one emit');
  assert.deepEqual(
    seen[0].map((p) => p.id),
    ['p1']
  );
});

test('a listener that changes the roster does not recurse, and the last emit is the settled one', () => {
  const { hub, bus } = makeHub();
  addPeer(hub, 'owner');
  addPeer(hub, 'agent-of-owner');

  // The shape of the crash: a listener reacts to presence by removing something
  // and emitting presence again. Unguarded this recursed until the stack gave out.
  const seen = [];
  bus.on('presence', (list) => {
    seen.push(list.map((p) => p.id));
    if (hub.identities.has('agent-of-owner')) {
      hub.identities.delete('agent-of-owner');
      hub.emitPresence();
    }
  });

  hub.emitPresence(); // must return, not blow the stack

  assert.equal(seen.length, 2, 'one pass to react, one to show the result');
  assert.deepEqual(seen[0], ['owner', 'agent-of-owner'], 'the first pass sees the roster as it was');
  assert.deepEqual(seen[1], ['owner'], 'and the last emit carries the settled roster');
});

test('the roster a listener is handed is rebuilt after an earlier listener changed it', () => {
  const { hub, bus } = makeHub();
  addPeer(hub, 'owner');
  addPeer(hub, 'doomed');

  // Two listeners, the first mutating. The second must not be left believing the
  // roster still holds what the first one took away — a stale roster forwarded to
  // the renderer is the quiet version of this bug.
  bus.on('presence', () => {
    if (hub.identities.delete('doomed')) hub.emitPresence();
  });
  const forwarded = [];
  bus.on('presence', (list) => forwarded.push(list.map((p) => p.id)));

  hub.emitPresence();

  assert.deepEqual(forwarded.at(-1), ['owner'], 'the final forwarded list is correct');
});

test('a listener that throws does not freeze presence for the rest of the session', () => {
  const { hub, bus } = makeHub();
  addPeer(hub, 'p1');

  let boom = true;
  bus.on('presence', () => {
    if (boom) throw new Error('listener exploded');
  });
  const seen = [];
  bus.on('presence', (list) => seen.push(list.map((p) => p.id)));

  // The throw propagates, as it always did — it is not swallowed here.
  assert.throws(() => hub.emitPresence(), /listener exploded/);

  // But the guard must have released. A flag left standing would silently drop
  // every later emit and freeze the roster, which is worse than the throw.
  boom = false;
  assert.equal(hub.emittingPresence, false, 'the burst flag was released');
  hub.emitPresence();
  assert.deepEqual(seen.at(-1), ['p1'], 'presence still works afterwards');
});

test('a listener that never settles ends the burst instead of hanging', () => {
  const { hub, bus } = makeHub();
  addPeer(hub, 'p1');

  // Pathological: changes the roster on every single pass, so it can never
  // converge. The burst has to give up rather than spin the main process.
  let n = 0;
  bus.on('presence', () => {
    hub.identities.set(`churn-${n++}`, { id: `churn-${n}` });
    hub.emitPresence();
  });

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    hub.emitPresence(); // must terminate
  } finally {
    console.warn = realWarn;
  }

  assert.ok(n > 1, 'it did re-emit to try to settle');
  assert.ok(n <= 10, `it stopped at the cap rather than spinning (${n} passes)`);
  assert.match(warnings.join('\n'), /did not settle/, 'and said so rather than failing silently');
  assert.equal(hub.emittingPresence, false, 'the guard released');
});

test('register, unregister and setIdentity all still announce the roster', () => {
  const { hub, bus } = makeHub();
  const seen = [];
  bus.on('presence', (list) => seen.push(list.map((p) => p.id)));

  const ws = { readyState: 1, close() {} };
  hub.register('p1', ws);
  assert.deepEqual(seen.at(-1), ['p1'], 'register announces');

  hub.setIdentity('p1', { id: 'p1', name: 'Peer One' });
  assert.deepEqual(seen.at(-1), ['p1'], 'setIdentity announces');

  hub.unregister('p1', ws);
  assert.equal(seen.length, 3, 'unregister announces');
});
