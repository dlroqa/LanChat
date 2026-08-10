'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  cleanMembers,
  isHost,
  isGuest,
  shared,
  present,
  mayPost,
  maySetup,
  mayDirect,
  invite,
  accept,
  decline,
  leave,
  revoke,
  audience,
} = require('../src/main/sessions/room.js');

// Who may do what in a shared session, decided without two machines.
//
// Sharing a session is the one change in this feature that moves data between
// computers, so the permissions are pure functions of a record and a proved peer
// id, and this file is what holds them to it. Every test below is a thing that
// must be refused; the ones that pass are the easy half.

const HOSTED = {
  id: 'session:1',
  members: [
    { peerId: 'p-zima', name: 'Zima', state: 'joined' },
    { peerId: 'p-serv', name: 'Server', state: 'invited' },
  ],
};

const JOINED = {
  id: 'session:1',
  hostPeerId: 'p-host',
  members: [{ peerId: 'p-zima', name: 'Zima', state: 'joined' }],
};

// ------------------------------------------------------------------ whose room

test('a session with no host is one we made', () => {
  // Every session already on disk predates sharing and has no host field, so it
  // has to read as ours — that is what makes this need no migration.
  assert.equal(isHost({ id: 'session:1' }), true);
  assert.equal(isGuest({ id: 'session:1' }), false);
  assert.equal(isHost(JOINED), false);
  assert.equal(isGuest(JOINED), true);
});

test('a workspace nobody was invited to is not shared', () => {
  assert.equal(shared({ id: 'session:1' }), false);
  assert.equal(shared({ id: 'session:1', members: [] }), false);
  assert.equal(shared(HOSTED), true);
  assert.equal(shared(JOINED), true);
});

// --------------------------------------------------------------- who may speak

test('only somebody actually in the room may put words in it', () => {
  assert.equal(mayPost(HOSTED, 'p-zima'), true);
  // Invited and never answered is not a member. This is the one that matters:
  // an invitation is not a key.
  assert.equal(mayPost(HOSTED, 'p-serv'), false);
  // A peer we have never heard of, claiming to be in a room they are not in.
  assert.equal(mayPost(HOSTED, 'p-stranger'), false);
  assert.equal(mayPost(HOSTED, null), false);
  assert.equal(mayPost(null, 'p-zima'), false);
});

test('somebody who left or was removed stops being able to speak', () => {
  for (const state of ['left', 'declined', 'revoked']) {
    const record = { ...HOSTED, members: [{ peerId: 'p-zima', state }] };
    assert.equal(mayPost(record, 'p-zima'), false, `${state} must not be able to post`);
  }
});

test('a guest takes words from the host and from nobody else', () => {
  // Everything arrives via the host, which is what keeps one order — and what
  // stops somebody thrown out of a room injecting into it by talking to the
  // members one at a time.
  assert.equal(mayPost(JOINED, 'p-host'), true);
  assert.equal(mayPost(JOINED, 'p-zima'), false);
});

// -------------------------------------------------------------- who may change

test('a guest may never change what the session is', () => {
  // A guest's copy of the settings is a display of the host's, not a second
  // source of truth. Two machines changing the mode mid-round is a race with a
  // transcript as the prize.
  assert.equal(maySetup(JOINED, null), false);
  assert.equal(maySetup(JOINED, 'p-host'), false);
  assert.equal(maySetup(JOINED, 'p-zima'), false);
});

test('only the person at the host machine changes a hosted session', () => {
  // `null` is us, at this keyboard. Any peer id is somebody on the wire, and no
  // peer may reach into our settings however well-known they are.
  assert.equal(maySetup(HOSTED, null), true);
  assert.equal(maySetup(HOSTED, 'p-zima'), false);
});

test('a transcript is only accepted from the host of a room we joined', () => {
  // Otherwise any online peer could hand us a conversation and have us file it.
  assert.equal(mayDirect(JOINED, 'p-host'), true);
  assert.equal(mayDirect(JOINED, 'p-zima'), false);
  assert.equal(mayDirect(HOSTED, 'p-zima'), false);
});

// ------------------------------------------------------------------- the roster

test('an acceptance from somebody never invited is not an acceptance', () => {
  // Somebody letting themselves in. The list comes back untouched, so the caller
  // writes nothing and announces nothing.
  const after = accept(HOSTED, 'p-stranger');
  assert.deepEqual(after, cleanMembers(HOSTED.members));
  assert.equal(
    after.some((m) => m.peerId === 'p-stranger'),
    false
  );
});

test('accepting twice does not change anything the second time', () => {
  const once = accept(HOSTED, 'p-serv');
  assert.equal(once.find((m) => m.peerId === 'p-serv').state, 'joined');
  // Idempotent: a duplicate frame off the wire must be harmless.
  const twice = accept({ ...HOSTED, members: once }, 'p-serv');
  assert.deepEqual(
    twice.map((m) => m.state),
    once.map((m) => m.state)
  );
});

test('re-inviting somebody who said no asks them again rather than adding them', () => {
  const said = { ...HOSTED, members: [{ peerId: 'p-zima', state: 'declined' }] };
  const again = invite(said, 'p-zima', 'Zima');
  assert.equal(again.length, 1);
  // Back to invited, not to joined. They said no once; putting them straight in
  // would be the host deciding for them.
  assert.equal(again[0].state, 'invited');
});

test('inviting somebody already in the room changes nothing', () => {
  const after = invite(HOSTED, 'p-zima', 'Zima');
  assert.deepEqual(after, cleanMembers(HOSTED.members));
});

test('leaving and being removed both take somebody out of the room', () => {
  assert.equal(present({ ...HOSTED, members: leave(HOSTED, 'p-zima') }).length, 0);
  assert.equal(present({ ...HOSTED, members: revoke(HOSTED, 'p-zima') }).length, 0);
  // Declining an invitation was never being in the room in the first place.
  assert.equal(decline(HOSTED, 'p-serv').find((m) => m.peerId === 'p-serv').state, 'declined');
});

test('a roster keeps its order and drops nonsense', () => {
  const messy = cleanMembers([
    { peerId: 'p-a', state: 'joined' },
    null,
    { peerId: '', state: 'joined' },
    { peerId: 'p-a', state: 'left' },
    { peerId: 'p-b', state: 'WHATEVER' },
    'p-c',
  ]);
  assert.deepEqual(
    messy.map((m) => m.peerId),
    ['p-a', 'p-b']
  );
  // An unreadable state is the least-privileged one, never `joined`.
  assert.equal(messy[1].state, 'invited');
});

// ------------------------------------------------------------------ who is told

test('a member never has their own words sent back to them', () => {
  const room = {
    members: [
      { peerId: 'p-a', state: 'joined' },
      { peerId: 'p-b', state: 'joined' },
      { peerId: 'p-c', state: 'invited' },
    ],
  };
  // p-c is invited, not present, and is told nothing.
  assert.deepEqual(audience(room, 'p-a'), ['p-b']);
  assert.deepEqual(audience(room).sort(), ['p-a', 'p-b']);
});
