'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const { AgentRegistry, isAgentId, delegateIdFor, isDelegateId, parseDelegateId, KINDS } = require('./registry');
const { createVirtualSocket } = require('./virtualSocket');
const { createHttpTransport } = require('./transports/http');
const { createCommandTransport } = require('./transports/command');
const { createAcpTransport } = require('./transports/acp');
const { createSshTransport } = require('./transports/ssh');

// AgentHub owns the lifecycle of connected agents.
//
// An agent is registered with PeerHub behind a virtual socket, so from the rest
// of the app's point of view it is simply another peer: it appears in the roster,
// gets a presence dot, has persisted history, and receives chat through the
// ordinary hub.send() path. Nothing in peers.js, store.js or the chat UI needed
// to change to accommodate it.
//
// Three states, deliberately distinct:
//   removed          no record at all
//   added, disabled  configured and visible in the roster, but dormant and
//                    hard-gated: no transport running, all routing refused
//   added, enabled   transport running, socket open, reachable
//
// Reach: an agent is local-first. Remote peers can only address it if they are on
// that agent's allowlist AND they address it explicitly. Approvals are never
// delegated to the LAN — only the local user can authorise a tool call.

// Marks a 'peer-message' as having been produced locally by an agent rather than
// received from the network. A Symbol is used deliberately: inbound frames are
// built by JSON.parse, which can never produce one, so a remote host cannot forge
// this marker to impersonate a local agent no matter what it puts on the wire.
const LOCAL_ORIGIN = Symbol('lanchat.agent.localOrigin');

const TRANSPORTS = {
  http: createHttpTransport,
  command: createCommandTransport,
  acp: createAcpTransport,
  ssh: createSshTransport,
};

// Per-peer throttle. The agent runs one job at a time, and a busy refusal is
// itself a reply — so without this a single peer can both monopolise the agent
// and amplify each of its own messages into an outbound frame. Applies only to
// remote origins; the machine's owner is never throttled.
const PEER_MIN_INTERVAL_MS = 3000;
const PEER_MAX_BUSY_REFUSALS = 3;
const PEER_THROTTLE_TTL_MS = 60000;

// `transports` is injectable so tests can drive the lifecycle with a stub that
// never touches the network; production always uses the real table above.
function createAgentHub({ userDataDir, hub, bus, store, safeStorage, transports = TRANSPORTS }) {
  const registry = new AgentRegistry(userDataDir, { safeStorage });
  const live = new Map(); // agentId -> { transport, socket, busy, pendingApproval }
  const throttle = new Map(); // `${agentId}|${peerId}` -> { last, refusals, expires }

  // May this peer reach this agent at all? Network-wide is a widening of the
  // allowlist, never a replacement: switching it off restores whatever the
  // allowlist already said, because the allowlist is never cleared.
  function peerMayReach(record, peerId) {
    if (!record || record.enabled === false || !peerId) return false;
    if (record.networkWide === true) return true;
    return (record.allowedPeers || []).includes(peerId);
  }

  // Every peer entitled to reach the agent right now, among those connected.
  function entitledPeers(record) {
    return hub
      .presenceList()
      .filter((p) => p.online && p.kind !== 'agent' && peerMayReach(record, p.id))
      .map((p) => p.id);
  }

  // Returns 'ok' | 'silent' — 'silent' means drop without replying, which is
  // what stops a looping peer turning each of its messages into a frame back.
  function checkThrottle(agentId, peerId, busy) {
    const key = `${agentId}|${peerId}`;
    const now = Date.now();
    for (const [k, v] of throttle) if (v.expires <= now) throttle.delete(k);
    const entry = throttle.get(key) || { last: 0, refusals: 0, expires: 0 };
    entry.expires = now + PEER_THROTTLE_TTL_MS;
    throttle.set(key, entry);
    if (now - entry.last < PEER_MIN_INTERVAL_MS) return 'silent';
    if (busy) {
      entry.refusals += 1;
      return entry.refusals > PEER_MAX_BUSY_REFUSALS ? 'silent' : 'ok';
    }
    entry.refusals = 0;
    entry.last = now;
    return 'ok';
  }

  function identityFor(record) {
    return {
      id: record.id,
      name: record.name,
      kind: 'agent',
      agentKind: record.kind,
      hostname: record.kind === 'ssh' ? record.config.host : 'local',
      avatar: { color: '#7c3aed', image: null },
    };
  }

  // The roster card for one peer's conversation with a local agent. Created
  // lazily on first use, so a delegate thread only exists once somebody has
  // actually asked something. It is a transcript, not a chat the owner types
  // into, so no socket is registered and it renders as an inactive contact.
  function ensureDelegateIdentity(record, peerId) {
    const id = delegateIdFor(record.id, peerId);
    if (hub.identities.has(id)) return id;
    const peer = hub.presenceList().find((p) => p.id === peerId);
    hub.setIdentity(id, {
      id,
      name: record.name,
      kind: 'agent',
      agentKind: record.kind,
      delegate: true,
      viaId: peerId,
      viaName: (peer && (peer.name || peer.hostname)) || 'a peer',
      hostname: 'local',
      avatar: { color: '#7c3aed', image: null },
    });
    return id;
  }

  function emitStatus(agentId, status, detail) {
    bus.emit('agent-status', { agentId, status, detail: detail || null });
  }

  function buildTransport(record) {
    const factory = transports[record.kind];
    if (!factory) throw new Error(`Unknown agent transport: ${record.kind}`);
    return factory({
      id: record.id,
      name: record.name,
      config: record.config || {},
      timeoutMs: record.config?.timeoutMs,
      getSecret: () => registry.secretFor(record.id),
    });
  }

  // ---- inbound: a message addressed to the agent ----

  // `origin` is null for the local user, or the peer id when relayed from the LAN.
  async function deliver(agentId, text, origin = null) {
    const entry = live.get(agentId);
    const record = registry.get(agentId);
    if (!record || !entry) return;

    // Remote traffic is throttled; the local user never is.
    if (origin) {
      if (checkThrottle(agentId, origin, entry.busy) === 'silent') return;
    }
    if (entry.busy) {
      reply(agentId, 'I am still working on the previous message — one at a time, please.', origin);
      return;
    }
    entry.busy = true;
    bus.emit('agent-typing', { agentId, isTyping: true });

    let streamed = '';
    await entry.transport.send(
      { text },
      {
        onDelta: (delta) => {
          streamed += delta;
          bus.emit('agent-delta', { agentId, delta });
        },
        onStatus: (status) => emitStatus(agentId, status ? 'working' : 'ready', status),
        onApproval: (req) => {
          // Surfaced to the local user only. A remote peer may have asked the
          // question, but only the machine's owner can authorise the answer.
          entry.pendingApproval = req;
          bus.emit('agent-approval', { agentId, ...req });
        },
        onDone: ({ text: output }) => {
          entry.busy = false;
          entry.pendingApproval = null;
          bus.emit('agent-typing', { agentId, isTyping: false });
          reply(agentId, output || streamed || '(no output)', origin);
        },
        onError: (err) => {
          entry.busy = false;
          entry.pendingApproval = null;
          bus.emit('agent-typing', { agentId, isTyping: false });
          emitStatus(agentId, 'error', err.message);
          reply(agentId, `⚠️ ${err.message}`, origin);
        },
      }
    );
  }

  // Agent output re-enters the app through the same bus event as peer traffic, so
  // it is stored and rendered by the existing ipc.js router with no special case.
  function reply(agentId, text, origin) {
    // A peer's conversation with the agent belongs in its own thread, not in the
    // human chat with that peer — otherwise asking an agent something graffitis
    // two real conversations. The owner still sees everything, just filed under
    // "Agent · via <peer>" instead of smeared through their chat with them.
    const threadId = origin ? delegateIdFor(agentId, origin) : agentId;
    const message = { from: threadId, type: 'chat', id: crypto.randomUUID(), text, ts: Date.now() };
    message[LOCAL_ORIGIN] = true;
    bus.emit('peer-message', message);
    // If a remote peer asked, relay the answer back to that peer alone — never
    // to everyone, and never to a peer that did not ask. `agent-reply` rather
    // than `chat` so their copy lands in its own thread too.
    if (origin) {
      hub.send(origin, { type: 'agent-reply', agentId, name: nameOf(agentId), text, ts: Date.now() });
    }
  }

  function nameOf(agentId) {
    return registry.get(agentId)?.name || 'agent';
  }

  // ---- start / stop / toggle ----

  async function startAgent(record) {
    if (live.has(record.id)) await stopAgent(record.id);
    const transport = buildTransport(record);
    const socket = createVirtualSocket((frame) => {
      // Frames arrive here exactly as PeerHub.send() serialised them.
      if (frame.type === 'chat' && frame.text) deliver(record.id, frame.text, null);
    });
    live.set(record.id, { transport, socket, busy: false, pendingApproval: null });
    hub.setIdentity(record.id, identityFor(record));
    emitStatus(record.id, 'connecting');
    try {
      const info = await transport.start();
      hub.register(record.id, socket); // roster dot goes green
      emitStatus(record.id, 'ready', info?.detail);
      return { ok: true, detail: info?.detail };
    } catch (err) {
      live.delete(record.id);
      emitStatus(record.id, 'error', err.message);
      return { ok: false, detail: err.message };
    }
  }

  async function stopAgent(agentId) {
    const entry = live.get(agentId);
    if (!entry) return;
    live.delete(agentId);
    try {
      await entry.transport.stop();
    } catch (err) {
      console.error('[agents] stop failed:', err.message);
    }
    entry.socket.close();
    hub.unregister(agentId, entry.socket); // roster dot goes grey
    emitStatus(agentId, 'off');
  }

  async function setEnabled(agentId, enabled) {
    const record = registry.update(agentId, { enabled });
    if (!record) return null;
    if (enabled) await startAgent(record);
    else {
      await stopAgent(agentId);
      // Keep the identity so a disabled agent stays visible in the roster as
      // offline, rather than silently vanishing.
      hub.setIdentity(agentId, identityFor(record));
    }
    // Disabling is a hard gate, so it must also retract the agent from every
    // peer that could see it — not just refuse them at the door.
    announce(record);
    return registry.publicList().find((a) => a.id === agentId);
  }

  // Who may reach the agent, and how discoverable it is. Both are re-advertised
  // immediately: entitlement is checked per message anyway, but the roster card
  // on the far side only moves when we tell it to.
  async function setSharing(agentId, patch) {
    const record = registry.update(agentId, {
      ...(patch.networkWide !== undefined ? { networkWide: patch.networkWide } : {}),
      ...(patch.directChat !== undefined ? { directChat: patch.directChat } : {}),
    });
    if (!record) return null;
    announce(record);
    hub.emitPresence();
    return registry.publicList().find((a) => a.id === agentId);
  }

  // ---- advertising an agent to the peers entitled to reach it ----

  // Presence never crosses the wire, so a peer only learns an agent exists — or
  // has stopped existing for them — from an explicit frame. Both directions
  // matter: without the advert a peer cannot file `@name` traffic into its own
  // thread, and without the withdrawal a revoked agent lingers in their roster.
  function advertFor(record) {
    return {
      type: 'agent-advert',
      agentId: record.id,
      name: record.name,
      agentKind: record.kind,
      directChat: record.directChat === true,
    };
  }

  function announce(record) {
    if (!record || record.enabled === false) return withdraw(record);
    const entitled = new Set(entitledPeers(record));
    for (const peer of hub.presenceList()) {
      if (!peer.online || peer.kind === 'agent') continue;
      if (entitled.has(peer.id)) hub.send(peer.id, advertFor(record));
      else hub.send(peer.id, { type: 'agent-withdraw', agentId: record.id });
    }
  }

  // Unconditional retraction — used when the agent is disabled or removed, where
  // "who is still entitled" is no longer a meaningful question.
  function withdraw(record) {
    if (!record) return;
    hub.broadcast({ type: 'agent-withdraw', agentId: record.id });
  }

  function announceAll() {
    for (const record of registry.list()) announce(record);
  }

  // A peer that was offline when sharing changed never got the frame, so
  // re-announce whenever one completes a handshake.
  bus.on('peer-hello', ({ peerId }) => {
    if (!peerId) return;
    for (const record of registry.list()) {
      if (record.enabled === false) continue;
      if (peerMayReach(record, peerId)) hub.send(peerId, advertFor(record));
    }
  });

  // ---- public API ----

  // The probe result is returned alongside the record rather than swallowed: a
  // saved agent and a reachable one are different things, and the caller needs
  // to be able to say so instead of reporting success for a connector that
  // never came up.
  async function add(draft) {
    const record = registry.add(draft);
    let probe = { ok: true, detail: null };
    if (record.enabled) probe = await startAgent(record);
    else hub.setIdentity(record.id, identityFor(record));
    announce(record);
    return { agent: registry.publicList().find((a) => a.id === record.id), probe };
  }

  // Edit an existing agent. Restarting a live transport is required, not
  // cosmetic: transports capture their config at construction, so a changed
  // base URL or command would otherwise be ignored until the next launch.
  async function update(agentId, patch) {
    const record = registry.update(agentId, patch);
    if (!record) return null;
    let probe = { ok: true, detail: null };
    if (record.enabled) probe = await startAgent(record);
    else {
      await stopAgent(agentId);
      // Refresh the card even while dormant — peers address the agent by name,
      // so a rename has to reach the roster either way.
      hub.setIdentity(agentId, identityFor(record));
    }
    // A rename changes how peers address it, so the advert has to be refreshed.
    announce(record);
    return { agent: registry.publicList().find((a) => a.id === agentId), probe };
  }

  // Removal must leave nothing behind — this is the "nothing permanent" contract.
  async function remove(agentId) {
    const record = registry.get(agentId);
    if (!record) return false;
    await stopAgent(agentId);
    // Retract it from every peer before the record is gone, or it lingers in
    // their rosters with nothing behind it.
    withdraw(record);
    hub.identities.delete(agentId);
    hub.addresses.delete(agentId);
    try {
      fs.rmSync(store.fileFor(agentId), { force: true });
    } catch (err) {
      console.error('[agents] history cleanup failed:', err.message);
    }
    // Each peer who used this agent has a delegate thread of their own. Missing
    // these would leave transcripts behind after a "removes everything" action.
    for (const id of [...hub.identities.keys()]) {
      const parts = parseDelegateId(id);
      if (!parts || parts.agentId !== agentId) continue;
      hub.identities.delete(id);
      try {
        fs.rmSync(store.fileFor(id), { force: true });
      } catch (err) {
        console.error('[agents] delegate history cleanup failed:', err.message);
      }
    }
    for (const key of [...throttle.keys()]) {
      if (key.startsWith(`${agentId}|`)) throttle.delete(key);
    }
    registry.remove(agentId); // drops the sealed secret with the record
    hub.emitPresence();
    return true;
  }

  async function test(agentId) {
    const record = registry.get(agentId);
    if (!record) return { ok: false, detail: 'No such agent.' };
    try {
      const transport = buildTransport(record);
      const info = await transport.start();
      await transport.stop();
      return { ok: true, detail: info?.detail || 'Reachable.' };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  }

  async function answerApproval(agentId, runId, choice) {
    const entry = live.get(agentId);
    if (!entry || !entry.transport.answerApproval) return false;
    entry.pendingApproval = null;
    return entry.transport.answerApproval(runId, choice);
  }

  async function stopRun(agentId) {
    const entry = live.get(agentId);
    if (!entry) return false;
    await entry.transport.stop();
    entry.busy = false;
    bus.emit('agent-typing', { agentId, isTyping: false });
    // The transport was torn down to interrupt the run; bring it back up so the
    // agent stays usable without the user having to toggle it off and on.
    const record = registry.get(agentId);
    if (record && record.enabled) await startAgent(record);
    return true;
  }

  // Routes a message that arrived from a remote peer. Returns true if it was
  // consumed by an agent. Every condition here is a deliberate gate.
  function routeFromPeer(peerId, text) {
    if (!peerId || typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (!trimmed.startsWith('@')) return false; // must be explicitly addressed
    for (const record of registry.list()) {
      const prefix = `@${record.name.toLowerCase()}`;
      if (!trimmed.toLowerCase().startsWith(prefix)) continue;
      if (record.enabled === false) return false; // toggle is a hard gate
      if (!peerMayReach(record, peerId)) return false; // allowlist, or network-wide
      if (!live.has(record.id)) return false;
      return accept(record, peerId, trimmed.slice(prefix.length).trim());
    }
    return false;
  }

  // A peer addressing an agent by id rather than by @name — the direct-chat
  // path. Every gate the @name path applies is re-applied here; the only
  // difference is how the agent was addressed.
  function routeDirect(peerId, agentId, text) {
    const record = registry.get(agentId);
    if (!record || typeof text !== 'string' || !text.trim()) return false;
    if (record.enabled === false) return false;
    if (!peerMayReach(record, peerId)) return false;
    if (!live.has(record.id)) return false;
    return accept(record, peerId, text.trim());
  }

  // Common tail: the request is stored in its own thread rather than in the
  // human chat, then handed to the transport.
  function accept(record, peerId, text) {
    const threadId = ensureDelegateIdentity(record, peerId);
    bus.emit('agent-request', { threadId, agentId: record.id, peerId, text, ts: Date.now() });
    deliver(record.id, text, peerId);
    return true;
  }

  async function startAll() {
    for (const record of registry.list()) {
      if (record.enabled === false) {
        hub.setIdentity(record.id, identityFor(record)); // visible, offline
        continue;
      }
      await startAgent(record);
    }
    // Peers connected before us learn about shared agents here; those that
    // connect later get theirs from the peer-hello hook.
    announceAll();
  }

  async function stopAll() {
    // Peers should not be left holding a card for an agent that just went away
    // with the app; they will get a fresh advert on the next handshake.
    for (const record of registry.list()) withdraw(record);
    await Promise.all([...live.keys()].map((id) => stopAgent(id)));
  }

  return {
    list: () => registry.publicList(),
    add,
    update,
    remove,
    test,
    setEnabled,
    setSharing,
    setAllowedPeers: (agentId, peers) => {
      const record = registry.update(agentId, { allowedPeers: peers });
      // Visibility now follows permission, so a change here has to reach both
      // the local roster and the peers who just gained or lost the agent.
      if (record) announce(record);
      hub.emitPresence();
      return registry.publicList().find((a) => a.id === agentId);
    },
    answerApproval,
    stopRun,
    routeFromPeer,
    routeDirect,
    announce,
    announceAll,
    startAll,
    stopAll,
    isAgent: isAgentId,
    isDelegate: isDelegateId,
    parseDelegate: parseDelegateId,
    KINDS,
  };
}

module.exports = { createAgentHub, LOCAL_ORIGIN };
