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

  // Take the contact off the roster while keeping what we know about the agent.
  // This is the other half of show(): the entry stays, so `@name` still files
  // locally and the transcript stays on disk, but nothing about it is left in
  // the roster. The next message in either direction shows it again.
  function conceal(entry) {
    hide(entry);
    hub.identities.delete(entry.id);
    hub.emitPresence();
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
    // Known either way — that is what lets `@name` be filed locally — but the
    // roster follows the owner's switch in *both* directions. Switching direct
    // chat off has to take the contact away as promptly as switching it on put
    // it there; leaving it because we happen to have used the agent already
    // would make "off" mean nothing on the machine it was meant to affect.
    // Nothing is lost by it: the thread stays on disk, `@name` still reaches the
    // agent, and either an answer or a question brings the contact back.
    if (entry.directChat) show(ownerPeerId, entry);
    else conceal(entry);
    return entry;
  }

  function drop(ownerPeerId, agentId) {
    const agents = byOwner.get(ownerPeerId);
    const entry = agents && agents.get(agentId);
    if (!entry) return false;
    // Off the books first, then off the roster. conceal() emits presence, and a
    // presence listener answers an owner going offline by dropping their agents
    // — so the emit lands back here. Concealing while the entry was still in
    // `agents` meant that re-entrant drop found the same entry and concealed it
    // again, recursing until the stack gave out and took the main process with
    // it. Deleting first makes the second visit a no-op.
    agents.delete(agentId);
    if (agents.size === 0) byOwner.delete(ownerPeerId);
    conceal(entry); // emits presence, so the roster loses it in the same tick
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
  // `thread` is a session asking through this agent: the local copy is filed
  // there instead of in the agent's own thread, and so is the answer.
  function send(ownerPeerId, entry, text, { prompt, docs = [], thread = null, context = null } = {}) {
    const into = thread || entry.id;
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
          peerId: into,
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
      peerId: into,
      direction: 'out',
      kind: 'text',
      text,
      ts: Date.now(),
      ...(docs.length && { docs: docs.map((d) => ({ name: d.name, bytes: d.bytes })) }),
      ...(context && { context }),
    };
    // Where the answer to *this* question goes. The frame carries no id we could
    // match a reply against, and adding one would only work against peers whose
    // build echoes it — so the correlation is kept here instead, and it is sound
    // because there is only ever one question outstanding: a second one, asked
    // while the first is still waiting to be read, is refused above before it
    // reaches the wire. An entry that goes away takes this with it, because drop()
    // deletes the whole record. If concurrent questions are ever allowed, this
    // has to become a `ref` echoed by the owner rather than a field here.
    entry.pendingThread = thread || null;
    // And which message it was, kept for the same span and on the same reasoning,
    // so a failure can be attributed to the question that caused it rather than
    // to whatever happens to be last in the thread.
    entry.pendingRef = message.id;
    const ok = hub.send(ownerPeerId, { type: 'agent-chat', agentId: entry.agentId, text: prompt ?? text });
    store.append(into, message);
    return { ...message, delivered: ok };
  }

  // A bare `@name`, with nothing after it. The agent is not being asked anything
  // — it is being asked to be here.
  //
  // A trigger, and nothing else. Nothing is written on this machine and nothing
  // is written on the owner's: `@Tessie` is how you open an agent, not something
  // anybody said, and a thread that keeps it is keeping a keystroke. What the
  // summon produces is the thing it is for — show() reveals the contact, so the
  // agent appears under Agents and can be opened.
  //
  // Deliberately not routed through send(). Most of that function is the
  // held-question refusal, and none of it applies: a summon cannot be a duplicate
  // of a question, so being told to wait for a turn it does not even spend would
  // be answering something nobody asked. There is no prompt and no documents here
  // either.
  function summon(ownerPeerId, entry) {
    // Sent first, and everything else hangs off whether it went.
    //
    // This is what lets the window light the agent's row without waiting to hear
    // back. The row pulsing has to mean the summon worked, and it can: the
    // composer only offers agents their owner is currently advertising to us —
    // an advert is withdrawn the moment sharing stops — so a name that reaches
    // here is one we are allowed to ask. Reachability is the remaining condition,
    // and hub.send already answers it rather than it having to be guessed at:
    // false means the owner is not connected and nothing left this machine.
    const ok = hub.send(ownerPeerId, { type: 'agent-summon', agentId: entry.agentId });
    // Revealed only if it did. An agent added to the roster by a summon that
    // never arrived would be a contact that appeared because of something that
    // did not happen.
    if (ok) show(ownerPeerId, entry);
    // No message: there is nothing to append and nothing to hand back. `threadId`
    // is what the window needs — which row to light, and which thread it opens.
    return { summoned: ok, delivered: ok, threadId: entry.id };
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
    // The owner's run failed. It arrives as a notice — nothing about it is worth
    // keeping — but it is not queue chatter, and the window shows it differently.
    const error = msg.error === true;
    // A session asked this, so the answer belongs there and not in the agent's
    // own thread. Queue chatter goes to the same place — it is about the
    // question that is waiting — but only a real answer ends the correlation:
    // being told you are third in line does not mean you have been answered.
    const into = entry.pendingThread || entry.id;
    // Which of our messages this is the outcome of. The owner cannot tell us —
    // the id is ours and means nothing on their machine — so the error is matched
    // against the question we have outstanding, which is sound for exactly the
    // reason `pendingThread` is: there is only ever one.
    const ref = entry.pendingRef;
    // An error ends the correlation as surely as an answer does. The run is over
    // and nothing further is coming for that question, so holding the thread open
    // would file the *next* answer against a question that already failed.
    if (!notice || error) {
      entry.pendingThread = null;
      entry.pendingRef = null;
    }
    const message = {
      id: crypto.randomUUID(),
      peerId: into,
      direction: 'in',
      kind: 'text',
      text: msg.text,
      ts: msg.ts || Date.now(),
      ...(notice && { notice: true }),
      ...(error && { error: true, ...(ref && { failedRef: ref }) }),
    };
    if (!notice) store.append(into, message);
    // The error itself is never written down; the mark it leaves on the question
    // is, so a question that was never answered is still not counted as one after
    // a restart.
    if (error && ref) store.update(into, ref, { failed: true });
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

  // Where anything about the question we are waiting on should be shown: the
  // session that asked it, or the agent's own thread when nothing else did.
  function threadFor(entry) {
    if (!entry) return null;
    return entry.pendingThread || entry.id;
  }

  // Their run finished with nothing in it. That is an answer — an empty one —
  // so it is shown wherever the answer would have gone and it ends the
  // correlation, exactly as a reply does.
  function emptyRun(ownerPeerId, agentId) {
    const entry = get(ownerPeerId, agentId);
    if (!entry) return null;
    const into = threadFor(entry);
    entry.pendingThread = null;
    return into;
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
    summon,
    receive,
    setStanding,
    setActivity,
    resolveThread,
    threadFor,
    emptyRun,
    isRemoteAgentId,
  };
}

module.exports = { createRemoteAgents };
