'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Persistent registry of connected agents, stored as plain JSON in the Electron
// userData dir — deliberately in its own file rather than config.json, so that
// removing an agent is a clean record deletion and so agent secrets never pass
// through the config publicConfig()/setConfig() surface that reaches the renderer.
//
// Secrets are sealed with Electron's safeStorage (OS keychain: Keychain /
// libsecret / DPAPI). Only ciphertext is written to disk, and the plaintext is
// materialised in main-process memory at call time and never sent to the renderer.

const AGENT_ID_PREFIX = 'agent:';
const REMOTE_AGENT_ID_PREFIX = 'remote-agent:';
const DELEGATE_SEPARATOR = '#';
const KINDS = Object.freeze(['http', 'command', 'acp', 'ssh']);

// Who may answer this agent's approval prompts besides the owner, and when.
// Every field is off or inert by default, so an agent that predates this — or
// one added without thinking about it — keeps the old rule: approvals are the
// owner's alone. See approvalGate.js for the passcode that backs `delegated`.
//
// `handoverMs` is how long the owner is given to answer before the notice is
// also offered to a holder. It is a delay, never a deadline: the local card
// stays until it is answered either way.
const DEFAULT_APPROVALS = Object.freeze({ delegated: false, unattended: false, handoverMs: 20000 });

// Long enough to walk back to the machine, short enough to be worth having.
const MIN_HANDOVER_MS = 0;
const MAX_HANDOVER_MS = 10 * 60 * 1000;

function normaliseApprovals(patch, base = DEFAULT_APPROVALS) {
  const merged = { ...DEFAULT_APPROVALS, ...base, ...(patch && typeof patch === 'object' ? patch : {}) };
  const ms = Number(merged.handoverMs);
  return {
    delegated: merged.delegated === true,
    // Unattended is meaningless without delegation and would be a trap to store
    // on its own: an owner who switched delegation off and later back on would
    // find the wider setting still armed from months ago.
    unattended: merged.delegated === true && merged.unattended === true,
    handoverMs: Number.isFinite(ms)
      ? Math.min(Math.max(Math.round(ms), MIN_HANDOVER_MS), MAX_HANDOVER_MS)
      : DEFAULT_APPROVALS.handoverMs,
  };
}

function isAgentId(id) {
  return typeof id === 'string' && id.startsWith(AGENT_ID_PREFIX);
}

function newAgentId() {
  return `${AGENT_ID_PREFIX}${crypto.randomUUID()}`;
}

// A delegate thread is where one peer's conversation with a local agent lives,
// so agent traffic never lands in the human chat with that peer. It stays inside
// the `agent:` namespace on purpose: the impersonation guard in ipc.js drops any
// wire frame claiming an `agent:` id, and a delegate thread is a purely local
// construct that must never be addressable from the network.
function delegateIdFor(agentId, peerId) {
  return `${agentId}${DELEGATE_SEPARATOR}${peerId}`;
}

function isDelegateId(id) {
  return isAgentId(id) && id.includes(DELEGATE_SEPARATOR);
}

// Splits a delegate thread id back into its parts. Returns null for a plain
// agent id, so callers can use it as the "is this a delegate?" test as well.
function parseDelegateId(id) {
  if (!isDelegateId(id)) return null;
  const at = id.indexOf(DELEGATE_SEPARATOR);
  return { agentId: id.slice(0, at), peerId: id.slice(at + DELEGATE_SEPARATOR.length) };
}

// The mirror image: an agent owned by *another* peer, seen from this machine.
// Deliberately outside the `agent:` namespace — a remote agent's traffic
// legitimately arrives off the wire, and the guard that protects local agents
// would otherwise drop every frame it sends.
function remoteAgentIdFor(ownerPeerId, agentId) {
  return `${REMOTE_AGENT_ID_PREFIX}${ownerPeerId}:${agentId}`;
}

function isRemoteAgentId(id) {
  return typeof id === 'string' && id.startsWith(REMOTE_AGENT_ID_PREFIX);
}

function parseRemoteAgentId(id) {
  if (!isRemoteAgentId(id)) return null;
  const rest = id.slice(REMOTE_AGENT_ID_PREFIX.length);
  const at = rest.indexOf(':');
  if (at === -1) return null;
  // The agent id keeps its own `agent:` prefix, which contains a colon — split
  // on the first separator only.
  return { ownerPeerId: rest.slice(0, at), agentId: rest.slice(at + 1) };
}

class AgentRegistry {
  constructor(userDataDir, { safeStorage } = {}) {
    this.file = path.join(userDataDir, 'agents.json');
    this.safeStorage = safeStorage || null;
    this.agents = [];
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.agents = Array.isArray(raw.agents) ? raw.agents : [];
    } catch {
      // First run or unreadable file — start empty.
      this.agents = [];
    }
    return this.agents;
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify({ agents: this.agents }, null, 2), 'utf8');
    } catch (err) {
      console.error('[agents] save failed:', err.message);
    }
  }

  get(id) {
    return this.agents.find((a) => a.id === id) || null;
  }

  list() {
    return this.agents.slice();
  }

  // Renderer-facing view. The sealed secret is reduced to a boolean so that a
  // key can never travel back across IPC once it has been entered.
  publicList() {
    return this.agents.map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      config: a.config,
      enabled: a.enabled !== false,
      allowedPeers: a.allowedPeers || [],
      // Who may reach it, and how discoverable it is. Both default off, so an
      // agent added before these existed stays exactly as private as it was.
      networkWide: a.networkWide === true,
      directChat: a.directChat === true,
      // Whether approvals may be handed to a named peer, and how. Booleans and
      // a number — the passcode itself lives in agent-approvals.json and never
      // appears here. `hasApprovalPasscode` is filled in by the hub, which is
      // the half that holds the gate.
      approvals: normaliseApprovals(a.approvals),
      hasSecret: Boolean(a.secret && a.secret.mode && a.secret.mode !== 'none'),
      secretMode: (a.secret && a.secret.mode) || 'none',
      // The variable name is not itself sensitive — only the value it resolves
      // to is, and that is never persisted — so it can be echoed back to
      // prefill the edit form. Sealed ciphertext is still never exposed.
      secretEnv: (a.secret && a.secret.mode === 'env' && a.secret.name) || null,
      createdAt: a.createdAt,
    }));
  }

  // ---- secret sealing ----

  // `secret` is { mode: 'sealed', value } | { mode: 'env', name } | { mode: 'none' }.
  // 'env' stores only a variable name and resolves at call time, so nothing
  // sensitive is persisted at all — the fallback when no OS keychain exists.
  sealSecret(secret) {
    if (!secret || !secret.mode || secret.mode === 'none') return { mode: 'none' };
    if (secret.mode === 'env') {
      const name = String(secret.name || '').trim();
      if (!name) throw new Error('An environment variable name is required.');
      return { mode: 'env', name };
    }
    if (secret.mode !== 'sealed') throw new Error(`Unknown secret mode: ${secret.mode}`);
    const value = String(secret.value || '');
    if (!value) return { mode: 'none' };
    if (!this.safeStorage || !this.safeStorage.isEncryptionAvailable()) {
      // Refuse rather than silently writing a plaintext key to disk.
      throw new Error(
        'OS secure storage is unavailable, so the key cannot be stored safely. ' +
          'Use the environment-variable option instead.'
      );
    }
    return { mode: 'sealed', cipher: this.safeStorage.encryptString(value).toString('base64') };
  }

  // Plaintext secret for an agent, resolved at call time. Main process only.
  secretFor(id) {
    const agent = this.get(id);
    if (!agent || !agent.secret) return null;
    const { mode } = agent.secret;
    if (mode === 'env') return process.env[agent.secret.name] || null;
    if (mode !== 'sealed') return null;
    try {
      return this.safeStorage.decryptString(Buffer.from(agent.secret.cipher, 'base64'));
    } catch (err) {
      console.error('[agents] could not decrypt secret:', err.message);
      return null;
    }
  }

  // ---- mutations ----

  add(draft) {
    const name = String(draft.name || '').trim();
    if (!name) throw new Error('An agent name is required.');
    if (!KINDS.includes(draft.kind)) throw new Error(`Unknown agent transport: ${draft.kind}`);
    const record = {
      id: newAgentId(),
      name,
      kind: draft.kind,
      config: draft.config && typeof draft.config === 'object' ? draft.config : {},
      secret: this.sealSecret(draft.secret),
      allowedPeers: Array.isArray(draft.allowedPeers) ? draft.allowedPeers.filter(Boolean) : [],
      // Sharing is never inherited from a draft by accident: both must be asked
      // for explicitly, so a newly connected agent starts local-only.
      networkWide: draft.networkWide === true,
      directChat: draft.directChat === true,
      // Never inherited from a draft either, and for a stronger version of the
      // same reason: a new agent that could hand its approvals to a peer the
      // moment it was added would be handing over the one thing sharing has
      // always kept back.
      approvals: { ...DEFAULT_APPROVALS },
      enabled: draft.enabled !== false,
      createdAt: Date.now(),
    };
    this.agents.push(record);
    this.save();
    return record;
  }

  update(id, patch) {
    const agent = this.get(id);
    if (!agent) return null;
    if (patch.name !== undefined) agent.name = String(patch.name).trim() || agent.name;
    // Switching transport replaces the config rather than merging it, so a
    // record never keeps settings belonging to a transport it no longer uses.
    // Same-transport edits merge, which is what preserves fields the form does
    // not show (timeoutMs) when only the base URL changes.
    const switching = patch.kind !== undefined && patch.kind !== agent.kind;
    if (switching) {
      if (!KINDS.includes(patch.kind)) throw new Error(`Unknown agent transport: ${patch.kind}`);
      agent.kind = patch.kind;
    }
    if (patch.config !== undefined) {
      agent.config = switching ? { ...patch.config } : { ...agent.config, ...patch.config };
    }
    if (patch.enabled !== undefined) agent.enabled = Boolean(patch.enabled);
    if (patch.networkWide !== undefined) agent.networkWide = Boolean(patch.networkWide);
    if (patch.directChat !== undefined) agent.directChat = Boolean(patch.directChat);
    if (patch.allowedPeers !== undefined) {
      agent.allowedPeers = Array.isArray(patch.allowedPeers) ? patch.allowedPeers.filter(Boolean) : [];
    }
    // Merged onto what is already there rather than replacing it, so a caller
    // that means to move one switch does not silently reset the other two.
    if (patch.approvals !== undefined) {
      agent.approvals = normaliseApprovals(patch.approvals, agent.approvals);
    }
    // Only reseal when a new secret is actually supplied, so that editing an
    // agent does not silently wipe a key the user did not retype.
    if (patch.secret !== undefined) agent.secret = this.sealSecret(patch.secret);
    this.save();
    return agent;
  }

  remove(id) {
    const before = this.agents.length;
    this.agents = this.agents.filter((a) => a.id !== id);
    if (this.agents.length === before) return false;
    this.save();
    return true;
  }
}

module.exports = {
  AgentRegistry,
  DEFAULT_APPROVALS,
  normaliseApprovals,
  isAgentId,
  newAgentId,
  delegateIdFor,
  isDelegateId,
  parseDelegateId,
  remoteAgentIdFor,
  isRemoteAgentId,
  parseRemoteAgentId,
  AGENT_ID_PREFIX,
  REMOTE_AGENT_ID_PREFIX,
  KINDS,
};
