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
const KINDS = Object.freeze(['http', 'command', 'acp', 'ssh']);

function isAgentId(id) {
  return typeof id === 'string' && id.startsWith(AGENT_ID_PREFIX);
}

function newAgentId() {
  return `${AGENT_ID_PREFIX}${crypto.randomUUID()}`;
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
      hasSecret: Boolean(a.secret && a.secret.mode && a.secret.mode !== 'none'),
      secretMode: (a.secret && a.secret.mode) || 'none',
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
    if (patch.config !== undefined) agent.config = { ...agent.config, ...patch.config };
    if (patch.enabled !== undefined) agent.enabled = Boolean(patch.enabled);
    if (patch.allowedPeers !== undefined) {
      agent.allowedPeers = Array.isArray(patch.allowedPeers) ? patch.allowedPeers.filter(Boolean) : [];
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

module.exports = { AgentRegistry, isAgentId, newAgentId, AGENT_ID_PREFIX, KINDS };
