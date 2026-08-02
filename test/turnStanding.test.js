'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The agent panel's Status and Turn boxes both read this one derivation, so a
// disagreement between them can only come from here. The states are also the
// only thing four different colours in that panel mean, which makes getting the
// key right the whole job.
//
// The module is ESM for the renderer; evaluate it here without pulling in a
// bundler by dropping the `export` keywords and returning the bindings.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'turnStanding.js'), 'utf8');
const { turnStanding, turnStandingLabel } = new Function(
  `${SRC.replace(/^export\s+/gm, '')}
   return { turnStanding, turnStandingLabel };`
)();

// A shared agent, reachable, with the fields the owner publishes in every frame.
const shared = (extra) => ({
  online: true,
  remote: true,
  queueQuota: 5,
  queueRemaining: 5,
  queuePosition: 1,
  queueAhead: 3,
  queueExpiring: false,
  queueExpiresInSec: 0,
  ...extra,
});

test('holding the turn with queries left is Ready', () => {
  const s = turnStanding(shared({ queueState: 'active', queueRemaining: 5 }), 0);
  assert.deepEqual(s, { key: 'ready', word: 'Ready', text: '5/5 left' });
});

test('holding an idle turn that is about to pass on is Handover', () => {
  const s = turnStanding(shared({ queueState: 'active', queueExpiring: true, queueExpiresInSec: 9 }), 6);
  // The countdown comes from the component's ticker, not from the frame, so the
  // text follows the live number rather than the duration that started it.
  assert.deepEqual(s, { key: 'handover', word: 'Handover', text: '6s left' });
});

test('standing in line behind someone is Waiting', () => {
  const s = turnStanding(shared({ queueState: 'waiting', queuePosition: 2 }), 0);
  assert.deepEqual(s, { key: 'waiting', word: 'Waiting', text: '#2 in line' });
});

test('being next while the holder goes idle is Brace', () => {
  const s = turnStanding(shared({ queueState: 'waiting', queueExpiring: true, queueExpiresInSec: 11 }), 11);
  assert.deepEqual(s, { key: 'brace', word: 'Brace', text: 'your turn in 11s' });
});

test('an expiry of zero seconds is not a countdown', () => {
  // The owner sends 0 for "not going anywhere". Treating that as counting would
  // put a blinking `0s left` on a turn nobody is about to lose.
  const s = turnStanding(shared({ queueState: 'active', queueExpiring: true, queueExpiresInSec: 0 }), 0);
  assert.equal(s.key, 'ready');
});

test('a lost connection replaces the standing rather than freezing it', () => {
  // The standing is pushed, so nothing can arrive to correct these fields once
  // the socket is gone. Counting down to a handover that will never happen is
  // worse than saying nothing; saying why is better than either.
  const s = turnStanding(
    shared({ online: false, queueState: 'waiting', queueExpiring: true, queueExpiresInSec: 11 }),
    11
  );
  assert.deepEqual(s, { key: 'offline', word: null, text: 'Offline' });
});

test('a null word leaves the Status box its own off-state label', () => {
  // The panel reads `standing?.word ?? <its own label>`, so an offline standing
  // must not supply a word — otherwise it would overwrite "Not connected".
  assert.equal(turnStanding(shared({ online: false, queueState: 'active' }), 0).word, null);
});

test('a delegate transcript keeps its standing despite being offline', () => {
  // A delegate thread has no socket of its own — it is a record of what a peer
  // asked, so it is always offline — but its standing is mirrored locally by
  // this very process and is never stale. Gating on `online` alone would blank
  // a countdown that is perfectly correct.
  const s = turnStanding(
    { online: false, delegate: true, queueState: 'waiting', queueExpiring: true, queueExpiresInSec: 8 },
    8
  );
  assert.deepEqual(s, { key: 'brace', word: 'Brace', text: 'your turn in 8s' });
});

test('an agent that takes no turns has no standing', () => {
  assert.equal(turnStanding({ online: true, agentKind: 'cli' }, 0), null);
  assert.equal(turnStanding({ online: true, queueState: 'idle' }, 0), null);
  assert.equal(turnStanding(null, 0), null);
});

test('every state says the same thing in words', () => {
  // Four of the five states are told apart by colour in the panel. Colour cannot
  // be the only thing carrying them, so each has a sentence behind it.
  const cases = [
    shared({ queueState: 'active' }),
    shared({ queueState: 'active', queueExpiring: true, queueExpiresInSec: 9 }),
    shared({ queueState: 'waiting' }),
    shared({ queueState: 'waiting', queueExpiring: true, queueExpiresInSec: 9 }),
    shared({ online: false, queueState: 'waiting' }),
  ];
  for (const peer of cases) {
    const label = turnStandingLabel(peer, 9);
    assert.ok(label.length > 10, `expected a spelled-out label, got ${JSON.stringify(label)}`);
  }
  assert.equal(turnStandingLabel({ online: true }, 0), '');
});

test('a waiting peer is told when a question of theirs is already held', () => {
  // The one thing that changes what you do next: there is nothing to come back
  // and retype, so the label has to say so rather than leaving it to be guessed.
  const held = turnStandingLabel(shared({ queueState: 'waiting', queueHeld: true }), 0);
  assert.match(held, /question is held/);
  const plain = turnStandingLabel(shared({ queueState: 'waiting' }), 0);
  assert.doesNotMatch(plain, /question is held/);
});

test('one query ahead is not "1 queries ahead"', () => {
  const label = turnStandingLabel(shared({ queueState: 'waiting', queueAhead: 1 }), 0);
  assert.match(label, /1 query ahead/);
});
