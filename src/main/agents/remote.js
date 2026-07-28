'use strict';

const crypto = require('node:crypto');

const { remoteAgentIdFor, isRemoteAgentId, parseRemoteAgentId } = require('./registry');
const { createVirtualSocket } = require('./virtualSocket');
const { busyLine } = require('./turnCopy');

// The other half of agent sharing: an agent owned by *another* peer, seen from
// this machine.
//
// It is modelled exactly like a local agent — a virtual peer behind a
// { readyState, send() } socket — so the roster, unread counts and persisted
// history work with no changes to peers.js or the chat UI. The difference is
// where the socket points: a local agent's virtual socket hands the frame to a
// transport, a remote one forwards it over the owning peer's real socket.
//
// Three properties are deliberate:
//
//   * Nothing is ever created speculatively. A remote agent exists here only
//     because its owner sent an advert, and it disappears the moment they
//     retract it or go offline. We never assume a grant we were not given.
//   * Its id lives outside the `agent:` namespace. Local agent ids are dropped
//     by the impersonation guard in ipc.js when they arrive off the wire, and a
//     remote agent's traffic legitimately does — so it must not collide.
//   * Conversation with it is confined to its own thread. Asking someone's agent
//     a question must not fill up the chat with that person.

function createRemoteAgents({ hub, store }) {
  // ownerPeerId -> Map<agentId, { id, name, agentKind, directChat, socket }>
  const byOwner = new Map();

  function cardFor(entry, ownerPeerId) {
    const owner = hub.presenceList().find((p) => p.id === ownerPeerId);
    return {
      id: entry.id,
      name: entry.name,
      kind: 'agent',
      agentKind: entry.agentKind,
      remote: true,
      viaId: ownerPeerId,
      viaName: (owner && (owner.name || owner.hostname)) || 'a peer',
      hostname: (owner && owner.hostname) || 'remote',
      avatar: { color: '#7c3aed', image: null },
    };
  }

  // Registering the virtual socket is what puts a green dot on the contact, so
  // it is done only when the agent should actually be visible: either the owner
  // shared it for direct chat, or this machine has already used it.
  function show(ownerPeerId, entry) {
    hub.setIdentity(entry.id, cardFor(entry, ownerPeerId));
    if (!entry.socket) {
      entry.socket = createVirtualSocket((frame) => {
        // Outbound frames are addressed to the agent but travel to its owner.
        if (frame.type === 'chat' && frame.text) {
          hub.send(ownerPeerId, { type: 'agent-chat', agentId: entry.agentId, text: frame.text });
        }
      });
      hub.register(entry.id, entry.socket);
    }
  }

  function hide(entry) {
    if (!entry.socket) return;
    entry.socket.close();
    hub.unregister(entry.id, entry.socket);
    entry.socket = null;
  }

  // An owner is telling us about one of their agents.
  function adopt(ownerPeerId, msg) {
    if (!ownerPeerId || !msg || !msg.agentId || !msg.name) return null;
    if (!byOwner.has(ownerPeerId)) byOwner.set(ownerPeerId, new Map());
    const agents = byOwner.get(ownerPeerId);
    const existing = agents.get(msg.agentId);
    const entry = existing || {
      id: remoteAgentIdFor(ownerPeerId, msg.agentId),
      agentId: msg.agentId,
      socket: null,
    };
    entry.name = String(msg.name);
    entry.agentKind = msg.agentKind || 'http';
    entry.directChat = msg.directChat === true;
    agents.set(msg.agentId, entry);
    // Known either way — that is what lets `@name` be filed locally — but only
    // put in the roster up front when the owner opted into direct chat.
    if (entry.directChat || entry.socket) show(ownerPeerId, entry);
    else hub.emitPresence();
    return entry;
  }

  function drop(ownerPeerId, agentId) {
    const agents = byOwner.get(ownerPeerId);
    const entry = agents && agents.get(agentId);
    if (!entry) return false;
    hide(entry);
    hub.identities.delete(entry.id);
    agents.delete(agentId);
    if (agents.size === 0) byOwner.delete(ownerPeerId);
    hub.emitPresence();
    return true;
  }

  // The owner went away, so everything they were hosting goes with them. Without
  // this their agents linger in the roster as contacts that silently fail.
  function dropOwner(ownerPeerId) {
    const agents = byOwner.get(ownerPeerId);
    if (!agents) return;
    for (const agentId of [...agents.keys()]) drop(ownerPeerId, agentId);
  }

  function get(ownerPeerId, agentId) {
    const agents = byOwner.get(ownerPeerId);
    return (agents && agents.get(agentId)) || null;
  }

  // Does this text address one of `ownerPeerId`'s shared agents by name? This is
  // what lets a peer's own `@Hermes …` be filed into the agent's thread rather
  // than into their chat with the owner.
  function matchMention(ownerPeerId, text) {
    const agents = byOwner.get(ownerPeerId);
    if (!agents || typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed.startsWith('@')) return null;
    for (const entry of agents.values()) {
      const prefix = `@${entry.name.toLowerCase()}`;
      if (trimmed.toLowerCase().startsWith(prefix)) {
        return { entry, ownerPeerId, text: trimmed.slice(prefix.length).trim() };
      }
    }
    return null;
  }

  // Send to a remote agent, whether reached by @name or by opening its thread.
  // Using it reveals the contact, which is how a "dummy chat" appears for an
  // agent the owner shared without direct chat switched on.
  // `prompt` is what the agent is asked; `text` is what the person typed. They
  // differ only when documents are attached, and the split is the point: the
  // documents' text has to travel to the owner's machine to reach the agent,
  // but a transcript that kept it would be a transcript of a PDF.
  function send(ownerPeerId, entry, text, { prompt, docs = [] } = {}) {
    // Asking again while the question we already sent is still waiting to be
    // read. It would not be answered any sooner, so it is refused here rather
    // than sent: never written down, never on the wire, and the text goes back
    // to whoever typed it.
    //
    // Refused on this machine rather than by the owner because the owner cannot
    // answer fast enough to be an answer — its anti-flood swallows anything
    // asked within a few seconds of the last attempt, which is exactly when a
    // second attempt happens. Its own refusal still stands behind this for the
    // moment when our standing is stale.
    if (entry.standing && entry.standing.state === 'waiting' && entry.held) {
      return {
        rejected: true,
        // Handed back so the composer can be refilled — a refusal must not cost
        // somebody the sentence they wrote, nor the documents they attached to
        // it, which they would otherwise have to find and drag in again.
        text,
        // Paths only. The extracted text stays in main; the composer needs no
        // more than enough to put the chips back.
        docs: docs.map((d) => ({ path: d.path, name: d.name, bytes: d.bytes })),
        notice: {
          id: crypto.randomUUID(),
          peerId: entry.id,
          direction: 'in',
          kind: 'text',
          text: busyLine(entry.name, entry.standing.position),
          ts: Date.now(),
          notice: true,
        },
      };
    }

    show(ownerPeerId, entry);
    const message = {
      id: crypto.randomUUID(),
      peerId: entry.id,
      direction: 'out',
      kind: 'text',
      text,
      ts: Date.now(),
      ...(docs.length && { docs: docs.map((d) => ({ name: d.name, bytes: d.bytes })) }),
    };
    const ok = hub.send(ownerPeerId, { type: 'agent-chat', agentId: entry.agentId, text: prompt ?? text });
    store.append(entry.id, message);
    return { ...message, delivered: ok };
  }

  // An answer coming back. Filed under the agent's thread, never under the chat
  // with the peer who hosts it.
  function receive(ownerPeerId, msg) {
    if (!msg || !msg.agentId || typeof msg.text !== 'string') return null;
    const entry = get(ownerPeerId, msg.agentId) || adopt(ownerPeerId, { ...msg, name: msg.name });
    if (!entry) return null;
    show(ownerPeerId, entry);
    // The owner marks their turn-queue housekeeping as a notice: shown once, then
    // dropped rather than kept. This is the copy the asking peer actually reads,
    // so it is where the queue chatter would otherwise pile up.
    const notice = msg.notice === true;
    const message = {
      id: crypto.randomUUID(),
      peerId: entry.id,
      direction: 'in',
      kind: 'text',
      text: msg.text,
      ts: msg.ts || Date.now(),
      ...(notice && { notice: true }),
    };
    if (!notice) store.append(entry.id, message);
    return message;
  }

  // Where we stand in the queue for a shared agent, pushed by its owner. Stored
  // on the identity card so it reaches the roster through the ordinary presence
  // path, with no new renderer plumbing.
  function setStanding(ownerPeerId, msg) {
    if (!msg || !msg.agentId) return null;
    const entry = get(ownerPeerId, msg.agentId);
    if (!entry) return null;
    entry.standing = { state: msg.state, position: msg.position, remaining: msg.remaining };
    // Whether a question of ours is already waiting to be read. Kept on the entry
    // as well as the card because `send` consults it before anything reaches the
    // renderer, and cleared the moment the owner says it has been read.
    entry.held = msg.held === true;
    if (!hub.identities.has(entry.id)) return entry;
    hub.setIdentity(entry.id, {
      queueState: msg.state,
      queuePosition: msg.position,
      queueRemaining: msg.remaining,
      queueQuota: msg.quota,
      queueAhead: msg.ahead || 0,
      queueExpiring: msg.expiring === true,
      queueExpiresInSec: msg.expiresInSec || 0,
      queueHeld: entry.held,
    });
    return entry;
  }

  // What the agent is doing right now, relayed by its owner. Kept on the card
  // like the queue standing, so the roster and panel read it the ordinary way.
  function setActivity(ownerPeerId, msg) {
    if (!msg || !msg.agentId) return null;
    const entry = get(ownerPeerId, msg.agentId);
    if (!entry || !hub.identities.has(entry.id)) return null;
    hub.setIdentity(entry.id, {
      agentBusy: msg.busy === true,
      agentDetail: msg.detail || null,
    });
    return entry;
  }

  function resolveThread(threadId) {
    if (!isRemoteAgentId(threadId)) return null;
    const parts = parseRemoteAgentId(threadId);
    if (!parts) return null;
    const entry = get(parts.ownerPeerId, parts.agentId);
    return entry ? { entry, ownerPeerId: parts.ownerPeerId } : null;
  }

  return {
    adopt,
    drop,
    dropOwner,
    get,
    matchMention,
    send,
    receive,
    setStanding,
    setActivity,
    resolveThread,
    isRemoteAgentId,
  };
}

module.exports = { createRemoteAgents };
