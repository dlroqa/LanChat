'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const { AgentRegistry, isAgentId, KINDS } = require('./registry');
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

// `transports` is injectable so tests can drive the lifecycle with a stub that
// never touches the network; production always uses the real table above.
function createAgentHub({ userDataDir, hub, bus, store, safeStorage, transports = TRANSPORTS }) {
  const registry = new AgentRegistry(userDataDir, { safeStorage });
  const live = new Map(); // agentId -> { transport, socket, busy, pendingApproval }

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
    const message = { from: agentId, type: 'chat', id: crypto.randomUUID(), text, ts: Date.now() };
    message[LOCAL_ORIGIN] = true;
    bus.emit('peer-message', message);
    // If a remote peer asked, relay the answer back to that peer alone — never
    // to everyone, and never to a peer that did not ask.
    if (origin) hub.send(origin, { type: 'chat', id: crypto.randomUUID(), text: `[${nameOf(agentId)}] ${text}`, ts: Date.now() });
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
    return registry.publicList().find((a) => a.id === agentId);
  }

  // ---- public API ----

  async function add(draft) {
    const record = registry.add(draft);
    if (record.enabled) await startAgent(record);
    else hub.setIdentity(record.id, identityFor(record));
    return registry.publicList().find((a) => a.id === record.id);
  }

  // Removal must leave nothing behind — this is the "nothing permanent" contract.
  async function remove(agentId) {
    const record = registry.get(agentId);
    if (!record) return false;
    await stopAgent(agentId);
    hub.identities.delete(agentId);
    hub.addresses.delete(agentId);
    try {
      fs.rmSync(store.fileFor(agentId), { force: true });
    } catch (err) {
      console.error('[agents] history cleanup failed:', err.message);
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
      if (!(record.allowedPeers || []).includes(peerId)) return false; // not allowlisted
      if (!live.has(record.id)) return false;
      deliver(record.id, trimmed.slice(prefix.length).trim(), peerId);
      return true;
    }
    return false;
  }

  async function startAll() {
    for (const record of registry.list()) {
      if (record.enabled === false) {
        hub.setIdentity(record.id, identityFor(record)); // visible, offline
        continue;
      }
      await startAgent(record);
    }
  }

  async function stopAll() {
    await Promise.all([...live.keys()].map((id) => stopAgent(id)));
  }

  return {
    list: () => registry.publicList(),
    add,
    remove,
    test,
    setEnabled,
    setAllowedPeers: (agentId, peers) => {
      registry.update(agentId, { allowedPeers: peers });
      return registry.publicList().find((a) => a.id === agentId);
    },
    answerApproval,
    stopRun,
    routeFromPeer,
    startAll,
    stopAll,
    isAgent: isAgentId,
    KINDS,
  };
}

module.exports = { createAgentHub, LOCAL_ORIGIN };
