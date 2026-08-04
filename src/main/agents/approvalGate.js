'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Who, besides the owner of this machine, may answer an agent's request to run
// something on it.
//
// The default has always been nobody, and it stays nobody: an approval is the
// one thing agent sharing never handed over. What this adds is a way for the
// owner to hand it over *on purpose*, to peers they name, for one agent at a
// time — because an agent shared with somebody while the machine is unattended
// asks a question that only the person who asked it is there to answer, and the
// alternative is a run that blocks until it is cancelled.
//
// Two independent gates, and this file is only the second of them. The first is
// reach — `peerMayReach()` in index.js, the allowlist the owner already keeps —
// and it is checked by the caller. A passcode redeemed by a peer who was never
// given reach buys nothing, which is the property that makes a leaked passcode
// survivable.
//
// The passcode is checked here and never leaves: like devgate.js this keeps a
// salted scrypt hash in a file of its own rather than in agents.json, because
// agents.json has a renderer-facing view (`publicList`) and a hash must never
// ride one. Like grants.js, what a correct passcode buys is a random token with
// a TTL that dies with the connection that earned it — so the passcode crosses
// the wire once, over the authenticated E2E socket, rather than on every answer.

const SCRYPT_KEYLEN = 64;

// Long enough to cover an unattended stretch, short enough that a token found in
// a peer's memory hours later is worthless. Refreshed by redeeming again.
const TOKEN_TTL_MS = 30 * 60 * 1000;

// Same shape as devgate's, and for the same reason: a peer can retry a passcode
// as fast as the socket allows, so wrong attempts have to start costing time.
// Counted per (agent, peer) rather than globally — one peer fumbling their
// passcode must not lock out another peer who has theirs right.
const LOCKOUT_BASE_MS = 1000;
const LOCKOUT_MAX_MS = 30000;
const LOCKOUT_FREE_ATTEMPTS = 2;

function hashPasscode(passcode, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(passcode), s, SCRYPT_KEYLEN).toString('hex');
  return { salt: s, hash };
}

function createApprovalGate({ userDataDir, now = () => Date.now() } = {}) {
  const file = path.join(userDataDir, 'agent-approvals.json');
  // agentId -> { salt, hash }
  let passcodes = new Map();
  // token -> { agentId, peerId, expires }
  const tokens = new Map();
  // `${agentId}|${peerId}` -> { failures, lockedUntil }
  const attempts = new Map();

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const agents = (raw && raw.agents) || {};
      passcodes = new Map(
        Object.entries(agents).filter(
          ([, v]) => v && typeof v.salt === 'string' && typeof v.hash === 'string'
        )
      );
    } catch {
      // First run, or a file we cannot read. Starting empty means "no agent has
      // a passcode", which is the same as "nothing is delegated" — the safe end
      // of this feature rather than the open one.
      passcodes = new Map();
    }
  }

  function save() {
    try {
      const agents = Object.fromEntries(passcodes);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ v: 1, agents }, null, 2), 'utf8');
    } catch (err) {
      console.error('[approvals] save failed:', err.message);
    }
  }

  load();

  // ---- the passcode ----

  function setPasscode(agentId, passcode) {
    const value = String(passcode || '');
    if (!agentId) throw new Error('An agent is required.');
    if (!value) throw new Error('A passcode is required.');
    passcodes.set(agentId, hashPasscode(value));
    save();
    // Changing the passcode is how an owner takes the right back, so it has to
    // invalidate what the old one bought.
    revokeAgent(agentId, { keepPasscode: true });
    return true;
  }

  function clearPasscode(agentId) {
    const had = passcodes.delete(agentId);
    if (had) save();
    revokeAgent(agentId, { keepPasscode: true });
    return had;
  }

  function has(agentId) {
    return passcodes.has(agentId);
  }

  // ---- tokens ----

  function sweep() {
    const t = now();
    for (const [token, held] of tokens) {
      if (held.expires <= t) tokens.delete(token);
    }
  }

  // A peer offering a passcode for an agent. The caller has already established
  // that this peer may reach the agent and that the owner has switched
  // delegation on; this decides only whether they know the passcode.
  //
  // While locked out, *any* passcode is refused without being hashed — so the
  // wait cannot be skipped by finally getting it right, and spamming during a
  // lockout costs nothing to answer.
  function redeem({ agentId, peerId, passcode }) {
    if (!agentId || !peerId) return { ok: false };
    const record = passcodes.get(agentId);
    if (!record) return { ok: false };

    const key = `${agentId}|${peerId}`;
    const state = attempts.get(key) || { failures: 0, lockedUntil: 0 };
    const t = now();
    if (t < state.lockedUntil) return { ok: false, lockedMs: state.lockedUntil - t };

    const attempt = hashPasscode(passcode, record.salt).hash;
    const a = Buffer.from(attempt, 'hex');
    const b = Buffer.from(record.hash, 'hex');
    const match = a.length === b.length && crypto.timingSafeEqual(a, b);

    if (!match) {
      state.failures += 1;
      if (state.failures > LOCKOUT_FREE_ATTEMPTS) {
        const step = state.failures - LOCKOUT_FREE_ATTEMPTS - 1;
        const delay = Math.min(LOCKOUT_BASE_MS * 2 ** step, LOCKOUT_MAX_MS);
        state.lockedUntil = t + delay;
        attempts.set(key, state);
        return { ok: false, lockedMs: delay };
      }
      attempts.set(key, state);
      return { ok: false };
    }

    attempts.delete(key);
    sweep();
    // One live token per (agent, peer). Redeeming again refreshes rather than
    // accumulates, so a peer that reconnects repeatedly does not leave a trail
    // of usable tokens behind it.
    for (const [token, held] of tokens) {
      if (held.agentId === agentId && held.peerId === peerId) tokens.delete(token);
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = t + TOKEN_TTL_MS;
    tokens.set(token, { agentId, peerId, expires });
    return { ok: true, token, expires };
  }

  // Unlike a file grant, this is not consumed by use: one claim covers every
  // approval that agent raises for that peer until it expires or is revoked.
  // Checked afresh on every answer, which is what makes revocation immediate.
  function verifyToken({ agentId, peerId, token }) {
    if (!agentId || !peerId || !token) return false;
    sweep();
    const held = tokens.get(token);
    return Boolean(held && held.agentId === agentId && held.peerId === peerId);
  }

  // Every peer currently holding approval rights for this agent. This is the
  // audience for an unattended run — one the owner started, with nobody at the
  // machine to answer for it.
  function holders(agentId) {
    sweep();
    const out = new Set();
    for (const held of tokens.values()) {
      if (held.agentId === agentId) out.add(held.peerId);
    }
    return [...out];
  }

  // One peer's rights over one agent — what a peer losing reach to that agent
  // costs them, and nothing more. Their standing with every other agent the
  // owner shares is a separate grant and is left alone.
  function revokeHolder(agentId, peerId) {
    for (const [token, held] of tokens) {
      if (held.agentId === agentId && held.peerId === peerId) tokens.delete(token);
    }
    attempts.delete(`${agentId}|${peerId}`);
  }

  // A peer going offline, or being re-pinned, takes its rights with it. Same
  // rule as grants.js: nothing outlives the connection that earned it.
  function revokePeer(peerId) {
    for (const [token, held] of tokens) {
      if (held.peerId === peerId) tokens.delete(token);
    }
    for (const key of [...attempts.keys()]) {
      if (key.endsWith(`|${peerId}`)) attempts.delete(key);
    }
  }

  // An agent switched off, removed, unshared, or with delegation turned back
  // off. `keepPasscode` is for the callers above, which have already decided
  // what happens to the passcode itself.
  function revokeAgent(agentId, { keepPasscode = false } = {}) {
    for (const [token, held] of tokens) {
      if (held.agentId === agentId) tokens.delete(token);
    }
    for (const key of [...attempts.keys()]) {
      if (key.startsWith(`${agentId}|`)) attempts.delete(key);
    }
    if (!keepPasscode && passcodes.delete(agentId)) save();
  }

  return {
    setPasscode,
    clearPasscode,
    has,
    redeem,
    verifyToken,
    holders,
    revokeHolder,
    revokePeer,
    revokeAgent,
    file,
    size: () => tokens.size,
  };
}

module.exports = {
  createApprovalGate,
  APPROVAL_TOKEN_TTL_MS: TOKEN_TTL_MS,
  LOCKOUT_MAX_MS,
};
