'use strict';

// Who is in a session, when more than one person is.
//
// A session began as a private workspace: one person, some agents, a transcript
// filed under a local id that was never allowed on the wire. Sharing one turns
// it into a room, and a room needs answers to questions a workspace never had —
// who may say something in it, who may change what it is, what a newcomer is
// shown, and what happens to somebody who was invited and never answered.
//
// All of it is decided here, as functions of a record and a peer id. Nothing in
// this file opens a socket, reads a clock or trusts a frame: the caller has
// already proved who is speaking (the server stamps the sender's identity from
// the socket it was proved on — see server.js), and this decides what that
// person is allowed to do. Keeping the two apart is what makes every rule below
// testable without two machines.
//
// ---- the one structural decision ----
//
// **The peer that created the session hosts it, and the host is the authority.**
//
// Members send their words to the host; the host writes them down, asks the
// agents, and tells everybody what happened. Nobody else asks an agent, nobody
// else starts a round, and nobody else decides the order the transcript is in.
//
// The alternative — every member appending locally and gossiping — would need a
// conflict-free order that this codebase has nowhere else, and it would let two
// machines start two rounds for one question. The round is already the host's:
// it lives in memory in sessions/index.js and always has. So this is not a new
// authority, it is the existing one made explicit and given a wire.

// What a person in a room can be.
//
// `invited` is a real state and not a waiting room: somebody who has been asked
// and has not answered is not a member, cannot post, and is still shown in the
// roster so the host can see what they are waiting for. `declined` and `left`
// are kept rather than deleted for the same reason — a room that silently
// forgets somebody said no will ask them again.
const STATES = ['invited', 'joined', 'declined', 'left', 'revoked'];

// The states that mean somebody is actually in the room right now.
const PRESENT = new Set(['joined']);

function cleanState(state) {
  return STATES.includes(state) ? state : 'invited';
}

// The people in a session, cleaned.
//
// Peer ids only, nothing blank, nobody twice, and the order kept — a roster is
// read by a person, and a list that reshuffles itself between renders is a list
// nobody can scan. Names are carried alongside because a peer who has gone
// offline still has to be nameable in the roster; they are a convenience copy,
// re-stamped from the live identity whenever one is available.
function cleanMembers(members) {
  if (!Array.isArray(members)) return [];
  const out = [];
  for (const raw of members) {
    if (!raw || typeof raw !== 'object') continue;
    const peerId = typeof raw.peerId === 'string' ? raw.peerId.trim() : '';
    if (!peerId || out.some((m) => m.peerId === peerId)) continue;
    out.push({
      peerId,
      name: typeof raw.name === 'string' && raw.name ? raw.name : null,
      state: cleanState(raw.state),
      at: Number.isFinite(Number(raw.at)) ? Number(raw.at) : 0,
    });
  }
  return out;
}

// Whether this machine is the one running the session.
//
// A record with no host is one we made, which is the only kind this app could
// create before sharing existed — so every session that already exists on disk
// reads as ours, which is exactly right and needs no migration.
function isHost(record) {
  return Boolean(record) && !record.hostPeerId;
}

// A session somebody else runs, that we have joined.
function isGuest(record) {
  return Boolean(record && record.hostPeerId);
}

// Whether a session is shared with anybody at all.
//
// A room of one is still a workspace, and the distinction matters: the observer
// rules about seams and floors have a different shape when there is more than
// one person who might be mid-sentence.
function shared(record) {
  if (!record) return false;
  if (isGuest(record)) return true;
  return members(record).length > 0;
}

function members(record) {
  return cleanMembers(record && record.members);
}

// Everybody actually in the room now — not counting whoever is reading, who is
// never in their own roster.
function present(record) {
  return members(record).filter((m) => PRESENT.has(m.state));
}

function memberOf(record, peerId) {
  return members(record).find((m) => m.peerId === peerId) || null;
}

// ---- the three permissions ----
//
// Deliberately three functions rather than one `can(action)`: each has a
// different answer for the host, and a single switch statement is where the
// three quietly grow a shared default that nobody meant.

// Whether a peer's words may be written into this session.
//
// The whole of the authorization for `session-chat`. Note what it does not
// consult: anything on the frame. Membership is looked up in our own record,
// so a peer claiming to be a member is not a peer who is one.
function mayPost(record, peerId) {
  if (!record || !peerId) return false;
  // A guest never accepts another guest's words directly. Everything arrives via
  // the host, which is what keeps one order and stops a peer injecting into a
  // room it was thrown out of by talking to the members individually.
  if (isGuest(record)) return peerId === record.hostPeerId;
  const member = memberOf(record, peerId);
  return Boolean(member && PRESENT.has(member.state));
}

// Whether a peer may change what the session *is* — its counsel, its mode, its
// observer policy, its title.
//
// Only the host, and on a hosted record that means only us. A guest's copy of
// the settings is a display of the host's, not a second source of truth: two
// machines both able to change the mode mid-round is a race with a transcript
// as the prize.
function maySetup(record, peerId) {
  if (!record) return false;
  if (isGuest(record)) return false;
  return peerId == null;
}

// Whether we may act on a `session-sync` or `session-state` from this peer.
//
// Only from the host of a session we actually joined. A peer that is merely
// online must not be able to hand us a transcript and have us file it.
function mayDirect(record, peerId) {
  return Boolean(record && isGuest(record) && peerId && peerId === record.hostPeerId);
}

// ---- changing the roster ----
//
// Each returns a new member list rather than mutating, so a caller can compare
// before and after to decide whether anything is worth saving or announcing.

function invite(record, peerId, name = null, at = Date.now()) {
  const list = members(record);
  const found = list.find((m) => m.peerId === peerId);
  if (found) {
    // Re-inviting somebody who left or declined is a real thing to want, and it
    // puts them back to `invited` rather than straight into the room: they said
    // no once, and being re-added without being asked again would be the host
    // deciding for them.
    if (PRESENT.has(found.state)) return list;
    return list.map((m) => (m.peerId === peerId ? { ...m, state: 'invited', at } : m));
  }
  return [...list, { peerId, name: name || null, state: 'invited', at }];
}

function setState(record, peerId, state, at = Date.now()) {
  const wanted = cleanState(state);
  return members(record).map((m) => (m.peerId === peerId ? { ...m, state: wanted, at } : m));
}

// Somebody accepting an invitation.
//
// Guarded rather than assumed: an acceptance from a peer who was never invited
// is not an acceptance, it is somebody letting themselves in. Returns the list
// unchanged, so the caller writes nothing and announces nothing.
function accept(record, peerId, at = Date.now()) {
  const member = memberOf(record, peerId);
  if (!member || member.state !== 'invited') return members(record);
  return setState(record, peerId, 'joined', at);
}

function decline(record, peerId, at = Date.now()) {
  const member = memberOf(record, peerId);
  if (!member || member.state !== 'invited') return members(record);
  return setState(record, peerId, 'declined', at);
}

function leave(record, peerId, at = Date.now()) {
  const member = memberOf(record, peerId);
  if (!member || !PRESENT.has(member.state)) return members(record);
  return setState(record, peerId, 'left', at);
}

function revoke(record, peerId, at = Date.now()) {
  if (!memberOf(record, peerId)) return members(record);
  return setState(record, peerId, 'revoked', at);
}

// Who should be told about something that happened in this room.
//
// Everybody present, minus whoever caused it — a member does not need their own
// words sent back to them, and echoing them is how a guest ends up with the same
// sentence twice.
function audience(record, except = null) {
  return present(record)
    .map((m) => m.peerId)
    .filter((id) => id !== except);
}

module.exports = {
  STATES,
  cleanState,
  cleanMembers,
  isHost,
  isGuest,
  shared,
  members,
  present,
  memberOf,
  mayPost,
  maySetup,
  mayDirect,
  invite,
  setState,
  accept,
  decline,
  leave,
  revoke,
  audience,
};
