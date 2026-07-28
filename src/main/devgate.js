'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Gate for the Developer panel — a local convenience lock, not a real security
// boundary. Deliberately its own file (like agents.json) rather than a
// config.json key, so the hash never rides the renderer-readable
// setConfig()/publicConfig() surface. Only main ever sees the hash; the
// renderer only ever gets a boolean back from verify().
//
// A salted scrypt hash is the right primitive here (unlike agents/registry.js's
// safeStorage sealing, which exists so a secret can be *decrypted back* for use
// at call time): a login gate only ever needs to check an attempt, never
// recover the plaintext, and it must keep working even where the OS keychain
// (safeStorage) is unavailable.

const DEFAULT_PASSWORD = '12345@54321';
const SCRYPT_KEYLEN = 64;
const UNLOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes
const LOCKOUT_BASE_MS = 1000;
const LOCKOUT_MAX_MS = 30000;
const LOCKOUT_FREE_ATTEMPTS = 2; // first 2 wrong attempts have no delay

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), s, SCRYPT_KEYLEN).toString('hex');
  return { salt: s, hash };
}

class DevGate {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'devgate.json');
    this.failures = 0;
    this.lockedUntil = 0;
    this.unlockedUntil = 0;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw.salt === 'string' && typeof raw.hash === 'string') {
        this.salt = raw.salt;
        this.hash = raw.hash;
        return;
      }
      throw new Error('malformed devgate.json');
    } catch {
      // First run (or an unreadable file) — seed the default password's hash.
      // The plaintext constant is used exactly once, here, and is never itself
      // persisted or sent over IPC.
      const seeded = hashPassword(DEFAULT_PASSWORD);
      this.salt = seeded.salt;
      this.hash = seeded.hash;
      this.save();
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ salt: this.salt, hash: this.hash }, null, 2), 'utf8');
    } catch (err) {
      console.error('[devgate] save failed:', err.message);
    }
  }

  // Wrong attempts get exponentially longer lockouts so a script can't just spin
  // on the default password. While locked, verify() refuses *any* password
  // (even the correct one) without hashing at all, so lockout can't be skipped
  // by knowing the answer, and spamming during a lockout can't extend the wait.
  verify(password) {
    const now = Date.now();
    if (now < this.lockedUntil) {
      return { ok: false, lockedMs: this.lockedUntil - now };
    }
    const attempt = hashPassword(password, this.salt).hash;
    const a = Buffer.from(attempt, 'hex');
    const b = Buffer.from(this.hash, 'hex');
    const match = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (match) {
      this.failures = 0;
      this.unlockedUntil = now + UNLOCK_TTL_MS;
      return { ok: true };
    }
    this.failures += 1;
    if (this.failures > LOCKOUT_FREE_ATTEMPTS) {
      const step = this.failures - LOCKOUT_FREE_ATTEMPTS - 1;
      const delay = Math.min(LOCKOUT_BASE_MS * 2 ** step, LOCKOUT_MAX_MS);
      this.lockedUntil = now + delay;
      return { ok: false, lockedMs: delay };
    }
    return { ok: false };
  }

  isUnlocked() {
    return Date.now() < this.unlockedUntil;
  }

  // Revoke the unlocked session immediately (called when the Dev panel closes),
  // rather than relying solely on the TTL to expire it.
  lock() {
    this.unlockedUntil = 0;
  }

  setPassword(newPassword) {
    if (!this.isUnlocked()) throw new Error('Developer panel is locked.');
    const value = String(newPassword || '');
    if (!value) throw new Error('A new password is required.');
    const seeded = hashPassword(value);
    this.salt = seeded.salt;
    this.hash = seeded.hash;
    this.save();
  }
}

module.exports = { DevGate, DEFAULT_PASSWORD };
