'use strict';

// A discussion, in A2A's shape.
//
// LanChat brokers every side of a discussion: the agents never speak to each
// other, and there is no protocol between them because there is no connection
// between them. What passes between them is whatever this process carries, and
// until now that was an ad-hoc list of `{ agentId, name, text, ts }` rendered
// straight into a prompt.
//
// This is the same conversation kept in the vocabulary of the Agent2Agent
// protocol instead. Nothing about the transcript on disk changes and no agent is
// required to speak A2A — the point is that the *record* is now the shape a real
// A2A server expects, so:
//
//   * the person interrupting a discussion is an ordinary turn in it (role
//     `user`) rather than a special case threaded through the loop;
//   * `transports/a2a.js` can put these objects on the wire as themselves,
//     instead of rendering them to text and hoping the far end parses it back;
//   * where a discussion has got to has one vocabulary — working, paused,
//     finished, cancelled — shared by the round, the window and the wire.
//
// ---- which A2A ----
//
// The JSON binding as published in the 0.3 line: `kind` discriminators on
// messages and parts, lowercase hyphenated task states. The 1.0 draft is a
// protobuf-first document that renames the roles (`ROLE_USER`/`ROLE_AGENT`) and
// drops the `kind` discriminator on `Part` for a oneof, so the two genuinely
// disagree about field names. Everything version-specific is in this file and
// nowhere else, which is what makes moving between them one edit rather than a
// sweep.

const crypto = require('node:crypto');

// The version this file speaks, carried on the objects it builds so a reader —
// or a peer, or a log — can tell which binding they are in.
const A2A_VERSION = '0.3';

// Roles. A2A is a conversation between one client and one agent, so there are
// exactly two, and *which* agent spoke is not a role — see `speaker` below.
const ROLE_USER = 'user';
const ROLE_AGENT = 'agent';

// What the person watching is called when their words are quoted to an agent.
//
// A label rather than a name, and here rather than in dialogue.js — which owns
// every other sentence a discussion produces — because this one is what a role
// turns into, and the role is this file's. dialogue.js reads it back for the
// line that tells an agent what the label means.
//
// It must never look like an agent's name: an agent shown "Ada: stop that"
// replies to Ada, and there is no Ada in the room.
const WATCHER = 'The person watching';

// Task states, as the JSON binding spells them.
const STATE = Object.freeze({
  submitted: 'submitted',
  working: 'working',
  inputRequired: 'input-required',
  completed: 'completed',
  canceled: 'canceled',
  failed: 'failed',
  rejected: 'rejected',
  authRequired: 'auth-required',
});

// Where LanChat's own facts live on an A2A object.
//
// A2A has two roles and no notion of several agents in one conversation, which
// is exactly what a LanChat discussion is. Rather than bend the protocol —
// inventing a third role, or smuggling the name into the text — the speaker goes
// in `metadata`, which is what metadata is for. A real A2A server ignores it and
// still reads a well-formed conversation; LanChat reads it and knows that turn
// four was Beacon's.
//
// Prefixed, because metadata is a shared namespace and an unprefixed `agentId`
// on the wire is a collision waiting for somebody else's extension.
const NS = 'lanchat';
const KEY = Object.freeze({
  agentId: `${NS}.agentId`,
  agentName: `${NS}.agentName`,
  turn: `${NS}.turn`,
  version: `${NS}.a2aVersion`,
});

// One turn.
//
// `contextId` groups everything that belongs to one conversation, which is
// exactly what a session is. `taskId` is the piece of work in it — one question
// and everything said in answer to it — which is exactly a round.
function message({ role, text, contextId, taskId, agentId, agentName, turn, messageId } = {}) {
  return {
    kind: 'message',
    messageId: messageId || crypto.randomUUID(),
    role: role === ROLE_USER ? ROLE_USER : ROLE_AGENT,
    parts: [{ kind: 'text', text: String(text == null ? '' : text) }],
    ...(contextId && { contextId }),
    ...(taskId && { taskId }),
    metadata: {
      [KEY.version]: A2A_VERSION,
      ...(agentId && { [KEY.agentId]: agentId }),
      ...(agentName && { [KEY.agentName]: agentName }),
      ...(turn !== undefined && turn !== null && { [KEY.turn]: turn }),
    },
  };
}

// A turn the person watching took: the question that started the discussion, or
// something said into the middle of one.
function userMessage({ text, contextId, taskId, turn } = {}) {
  return message({ role: ROLE_USER, text, contextId, taskId, turn });
}

// A turn an agent took.
function agentMessage({ text, contextId, taskId, agentId, agentName, turn } = {}) {
  return message({ role: ROLE_AGENT, text, contextId, taskId, agentId, agentName, turn });
}

// All of a message's text, however many parts it arrived in.
//
// Tolerant on the way in and strict on the way out: a part with no `kind` but a
// `text` is still text, because the 1.0 draft drops the discriminator and a
// server that already has may be on the other end of this.
function textOf(msg) {
  if (!msg) return '';
  if (typeof msg.text === 'string' && !Array.isArray(msg.parts)) return msg.text;
  return (msg.parts || [])
    .filter((p) => p && typeof p.text === 'string' && (p.kind === undefined || p.kind === 'text'))
    .map((p) => p.text)
    .join('');
}

// Who said it, in LanChat's terms rather than A2A's.
function speakerOf(msg) {
  const meta = (msg && msg.metadata) || {};
  return {
    role: msg && msg.role === ROLE_USER ? ROLE_USER : ROLE_AGENT,
    agentId: meta[KEY.agentId] || null,
    name: meta[KEY.agentName] || null,
    turn: meta[KEY.turn] ?? null,
  };
}

// The discussion as the prompt builder wants it: `{ agentId, name, text, role }`
// in the order it was said.
//
// This is the one conversion that has to stay cheap, because it happens on every
// turn. It is a projection and not a second copy — dialogue.js decides what to
// quote and what to elide; all this does is say who spoke and what they said.
function turnsOf(history) {
  return (history || []).map((msg) => {
    const who = speakerOf(msg);
    return {
      agentId: who.agentId,
      // A person's turn is labelled rather than named. The label is read by an
      // agent as the person watching, which is exactly what it is — and it must
      // not be an agent's name, or the next speaker will reply to a colleague
      // who does not exist.
      name: who.role === ROLE_USER ? WATCHER : who.name || 'An agent',
      role: who.role,
      text: textOf(msg),
    };
  });
}

// The state a round is in, in A2A's words.
//
// `ended` is LanChat's reason a discussion stopped — see ENDINGS in dialogue.js.
// The mapping is deliberately many-to-one: A2A cares whether the work finished,
// was called off, or broke, and a discussion that ran out of turns finished.
function taskState({ open, paused, ended } = {}) {
  if (open) return paused ? STATE.inputRequired : STATE.working;
  switch (ended) {
    case 'stopped':
      return STATE.canceled;
    case 'error':
      return STATE.failed;
    // spent, converged, silence, dwindled — the work is over and there is an
    // answer to read. A discussion that ended because nobody had more to say is
    // not a failure, and reporting it as one would be a lie to anything that
    // later reads these states without the reason beside them.
    default:
      return STATE.completed;
  }
}

// The whole round as an A2A Task: what was asked, where it got to, and every
// turn in it.
function task(round) {
  return {
    kind: 'task',
    id: round.id,
    contextId: round.sessionId,
    status: {
      state: taskState(round),
      timestamp: new Date(round.lastAt || Date.now()).toISOString(),
    },
    history: (round.history || []).slice(),
    metadata: {
      [KEY.version]: A2A_VERSION,
      [`${NS}.mode`]: round.mode,
      [`${NS}.turn`]: round.turn,
      [`${NS}.cap`]: round.cap,
      ...(round.ended && { [`${NS}.ended`]: round.ended }),
    },
  };
}

module.exports = {
  A2A_VERSION,
  ROLE_USER,
  ROLE_AGENT,
  WATCHER,
  STATE,
  KEY,
  message,
  userMessage,
  agentMessage,
  textOf,
  speakerOf,
  turnsOf,
  taskState,
  task,
};
