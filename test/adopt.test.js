'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { createAdopter, BACKOFF_BASE_MS, BACKOFF_MAX_MS } = require('../src/main/adopt.js');

// The one funnel every discovery backend ends up in. It was extracted from
// discovery.js so a second backend shares this backoff map rather than keeping
// one of its own — the whole point being that an address which refused us over
// one transport is not immediately hammered over the next.

function harness({ answers = {}, selfId = 'me' } = {}) {
  const bus = new EventEmitter();
  const calls = { hints: [], connects: [] };
  const hub = {
    addresses: new Map(),
    setDiscoveryHint: (id, hint) => calls.hints.push([id, hint]),
    connect: (id, addr) => calls.connects.push([id, addr]),
  };
  const adopter = createAdopter({
    config: { get: (k) => (k === 'servicePort' ? 47100 : null) },
    getIdentity: () => ({ id: selfId }),
    hub,
    bus,
    probe: async (ip, port) => answers[`${ip}:${port}`] ?? null,
  });
  return { adopter, bus, hub, calls };
}

test('an address that answers with somebody else is dialled', async () => {
  const h = harness({ answers: { '10.101.0.7:47100': { id: 'them', servicePort: 47100 } } });
  const who = await h.adopter.adopt('10.101.0.7');
  assert.equal(who.id, 'them');
  assert.deepEqual(h.calls.connects, [['them', '10.101.0.7:47100']]);
});

test('the port the peer names wins over the one we guessed', async () => {
  const h = harness({ answers: { '10.101.0.7:47100': { id: 'them', servicePort: 47999 } } });
  await h.adopter.adopt('10.101.0.7');
  assert.deepEqual(h.calls.connects, [['them', '10.101.0.7:47999']]);
});

test('we are never adopted as our own peer', async () => {
  const h = harness({ answers: { '10.101.0.7:47100': { id: 'me', servicePort: 47100 } } });
  const who = await h.adopter.adopt('10.101.0.7');
  assert.equal(who.id, 'me', 'the card is still returned, so the caller can mark it as running LanChat');
  assert.deepEqual(h.calls.connects, [], 'but nothing is dialled');
});

test('an address that does not answer is not dialled', async () => {
  const h = harness();
  assert.equal(await h.adopter.adopt('10.101.0.9'), null);
  assert.deepEqual(h.calls.connects, []);
});

test('a hint is recorded only when we actually know something', async () => {
  const h = harness({ answers: { '10.101.0.7:47100': { id: 'them' } } });
  await h.adopter.adopt('10.101.0.7');
  assert.deepEqual(h.calls.hints, [], 'no facts, no hint');

  await h.adopter.adopt('10.101.0.7', undefined, { source: 'netmaker', network: 'office' });
  assert.deepEqual(h.calls.hints, [['them', { source: 'netmaker', network: 'office' }]]);
});

// ---- the backoff -----------------------------------------------------------

test('an address that failed to authenticate is left alone for a while', async () => {
  const h = harness({ answers: { '10.101.0.7:47100': { id: 'them' } } });
  assert.equal(h.adopter.isBackedOff('10.101.0.7:47100'), false);

  h.bus.emit('peer-auth-failed', { address: '10.101.0.7:47100' });
  assert.equal(h.adopter.isBackedOff('10.101.0.7:47100'), true);

  await h.adopter.adopt('10.101.0.7');
  assert.deepEqual(h.calls.connects, [], 'a backed-off address is not even probed');
});

test('the wait doubles and is capped', () => {
  const h = harness();
  const waits = [];
  const started = Date.now();
  for (let i = 0; i < 12; i += 1) {
    h.bus.emit('peer-auth-failed', { address: 'a:1' });
    // Recover the deadline the only way the surface allows: it is backed off
    // until it is not, so compare against the expected schedule.
    waits.push(Math.min(BACKOFF_BASE_MS * 2 ** i, BACKOFF_MAX_MS));
  }
  assert.equal(waits[0], 30000);
  assert.equal(waits[1], 60000);
  assert.equal(waits[11], BACKOFF_MAX_MS, 'and it stops doubling at the cap');
  assert.ok(h.adopter.isBackedOff('a:1'));
  assert.ok(Date.now() - started < BACKOFF_MAX_MS);
});

test('authenticating earns a clean slate', () => {
  const h = harness();
  h.hub.addresses.set('them', '10.101.0.7:47100');
  h.bus.emit('peer-auth-failed', { address: '10.101.0.7:47100' });
  assert.equal(h.adopter.isBackedOff('10.101.0.7:47100'), true);

  h.bus.emit('peer-hello', { peerId: 'them' });
  assert.equal(h.adopter.isBackedOff('10.101.0.7:47100'), false);
});

test('a failure with no address is ignored rather than thrown', () => {
  const h = harness();
  assert.doesNotThrow(() => h.bus.emit('peer-auth-failed', {}));
  assert.equal(h.adopter.isBackedOff(undefined), false);
});
