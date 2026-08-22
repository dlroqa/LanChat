'use strict';

// A peer code: how two people on different Netmaker tenants introduce themselves.
//
// Trust on first use is weaker across a tenant boundary than it is on your own
// tailnet, because the mesh operator is not necessarily you. This closes that
// gap with the thing the app already has: a fingerprint of the device key, which
// Settings already asks people to read out to each other. Putting it in the code
// alongside the address means the first connection can be *checked* rather than
// merely accepted — a match is real evidence, because the fingerprint arrived
// out of band with the address rather than over the wire being verified.
//
// **A peer code is not a secret.** Everything in it is public: an address, a
// port, a display name, and a fingerprint that is already read aloud in Settings
// by design. It grants nothing on its own — the ordinary handshake still has to
// succeed — so it can be sent by any means at all. That is worth saying plainly
// wherever it is shown, because a long opaque string trains people to treat it
// as a password.
//
// `addrs` is a list rather than one address so somebody on three networks hands
// out one code that works from any of them, and so a later version can add a
// candidate of a different kind without a new codec. The version prefix is what
// makes that possible without guessing.

const PREFIX = 'lanchat1:';

// The exact shape authProto.fingerprint() produces: SHA-256 of the raw key,
// first 24 hex characters, in dash-separated groups of four.
const FINGERPRINT_RE = /^[0-9A-F]{4}(-[0-9A-F]{4}){5}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Small enough that a bad paste is rejected before it is parsed, and generous
// enough for a person on several networks.
const MAX_CODE_BYTES = 512;
const MAX_ADDRS = 8;

function isPlainIp(value) {
  const a = String(value || '').trim();
  if (!a) return false;
  if (a.includes(':')) return /^[0-9a-f:.]+$/i.test(a) && a.length <= 45;
  const parts = a.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function isPort(value) {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}

function trimmed(value, max) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.slice(0, max);
}

// Build a code. Returns null rather than a half-formed one: a code that cannot
// be redeemed is worse than no code, because it is pasted before it fails.
function encodePeerCode({ id, fingerprint, name = null, addrs = [] } = {}) {
  if (!UUID_RE.test(String(id || ''))) return null;
  if (!FINGERPRINT_RE.test(String(fingerprint || ''))) return null;

  const cleaned = [];
  for (const entry of Array.isArray(addrs) ? addrs : []) {
    if (cleaned.length >= MAX_ADDRS) break;
    const addr = String((entry && entry.addr) || '').trim();
    const port = Number((entry && entry.port) || 0);
    if (!isPlainIp(addr) || !isPort(port)) continue;
    if (cleaned.some((c) => c.addr === addr && c.port === port)) continue;
    cleaned.push({
      addr,
      port,
      ...(trimmed(entry.net, 64) ? { net: trimmed(entry.net, 64) } : {}),
      ...(trimmed(entry.server, 128) ? { server: trimmed(entry.server, 128) } : {}),
    });
  }
  if (!cleaned.length) return null;

  const body = {
    v: 1,
    id: String(id),
    fp: String(fingerprint),
    ...(trimmed(name, 64) ? { name: trimmed(name, 64) } : {}),
    addrs: cleaned,
  };
  const code = PREFIX + Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  return Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES ? null : code;
}

// Read a code. Null for anything at all doubtful — this string was typed or
// pasted by a person from a channel we know nothing about, so every field is
// checked rather than trusted, and a failure is silent rather than partial.
function decodePeerCode(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith(PREFIX)) return null;
  if (Buffer.byteLength(raw, 'utf8') > MAX_CODE_BYTES) return null;

  let body;
  try {
    body = JSON.parse(Buffer.from(raw.slice(PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (body.v !== 1) return null;
  if (!UUID_RE.test(String(body.id || ''))) return null;
  if (!FINGERPRINT_RE.test(String(body.fp || ''))) return null;
  if (!Array.isArray(body.addrs) || !body.addrs.length) return null;

  const addrs = [];
  for (const entry of body.addrs.slice(0, MAX_ADDRS)) {
    if (!entry || typeof entry !== 'object') continue;
    const addr = String(entry.addr || '').trim();
    const port = Number(entry.port);
    if (!isPlainIp(addr) || !isPort(port)) continue;
    addrs.push({
      addr,
      port,
      net: trimmed(entry.net, 64),
      server: trimmed(entry.server, 128),
    });
  }
  if (!addrs.length) return null;

  return { v: 1, id: String(body.id), fp: String(body.fp), name: trimmed(body.name, 64), addrs };
}

module.exports = { encodePeerCode, decodePeerCode, PREFIX, MAX_CODE_BYTES, FINGERPRINT_RE };
