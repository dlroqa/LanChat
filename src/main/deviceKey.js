'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { generateSigningKey, importSigningPrivate, fingerprint } = require('./authProto');

// This device's long-lived signing key — what makes the peer id mean something.
//
// The id in config.json is a random UUID that is broadcast over UDP every three
// seconds and served to any HTTP client that asks. It was, until this key
// existed, a bearer token: knowing it was the same as being it. The UUID keeps
// its job as a label — it is the primary key of every conversation file, every
// agent allowlist and every outbox queue, and changing it would orphan all of
// them — and this key becomes the thing a peer actually proves.
//
// Kept out of config.json on purpose, in a file of its own, for the same reason
// agents.json and devgate.json are: config.json crosses IPC as `publicConfig`
// and is rewritten wholesale by `setConfig`. A secret in it is one careless
// allowlist edit from the renderer.

const FILE = 'device-key.json';

// Sealed when the OS will do it, a 0600 file when it will not — deliberately
// unlike registry.js, which refuses rather than degrading.
//
// The trade is different in both directions. An agent secret is a bearer
// credential for somebody else's service: leaking it is worse than losing the
// feature, and there is a safe alternative in reading it from the environment.
// This key is self-generated and locally scoped, refusing means the app cannot
// network at all, and the fallback sits in the same directory as the entire
// plaintext message history — so an attacker who can read it has already read
// everything it protects. Refusing would cost the whole product to buy almost
// nothing. On Linux without a keychain, which is the ordinary minimal-desktop
// and CI case, sealing simply is not available.
function createDeviceKey({ userDataDir, safeStorage = null }) {
  const file = path.join(userDataDir, FILE);
  let state = null;

  function sealingAvailable() {
    try {
      return Boolean(safeStorage && safeStorage.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  // Written to a temp name and renamed, so a crash mid-write cannot leave a
  // half-file — which for this file would be indistinguishable from an attack.
  function writeAtomic(data) {
    fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    // writeFileSync's mode applies only when it creates the file; an existing
    // one keeps whatever it had. The chmod is not redundant.
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      /* win32 has no POSIX mode; DPAPI-backed sealing covers it there */
    }
    fs.renameSync(tmp, file);
  }

  function create() {
    const pair = generateSigningKey();
    const sealed = sealingAvailable();
    const data = {
      v: 1,
      mode: sealed ? 'sealed' : 'plain',
      // The public half is always in the clear. If sealing breaks — a keychain
      // reset, a restored backup — the roster and the fingerprint still work and
      // the failure is legible instead of total.
      publicKey: pair.publicKey,
      privateKey: sealed
        ? safeStorage.encryptString(pair.privateKey).toString('base64')
        : pair.privateKey,
    };
    writeAtomic(data);
    return { ...data, plainPrivate: pair.privateKey };
  }

  function open(raw) {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !data.publicKey || !data.privateKey) {
      throw new Error('the device key file is not shaped like a key');
    }
    let plainPrivate;
    if (data.mode === 'sealed') {
      if (!sealingAvailable()) {
        throw new Error('this device key was sealed by the OS keychain, which is not available now');
      }
      plainPrivate = safeStorage.decryptString(Buffer.from(data.privateKey, 'base64'));
    } else {
      plainPrivate = data.privateKey;
    }
    // Prove the halves belong together before anything depends on them. A
    // mismatch means the file was edited or partially restored, and signing with
    // it would produce proofs no peer could verify.
    const derived = importSigningPrivate(plainPrivate).publicKey;
    if (derived !== data.publicKey) throw new Error('the device key halves do not match');
    return { ...data, plainPrivate };
  }

  // Absent means first run and a key is minted. Present-but-unreadable is fatal,
  // and that distinction is the whole point.
  //
  // Regenerating over a broken file would hand every peer we have ever met the
  // exact signature of an attack — same UUID, different key — all at once, and
  // every one of them would raise an alarm about us. Better to refuse to network
  // and say the key could not be read. `reset()` exists for when the user
  // genuinely wants a new identity, and it mints a new UUID alongside so we
  // arrive as a new contact rather than as a changed key.
  function load() {
    if (state) return state;
    let raw = null;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw new Error(`Could not read the device key at ${file}: ${err.message}`);
      }
    }
    if (raw === null) {
      state = create();
      return state;
    }
    // Deliberately not a fallback to create(): see above. The wrap is so the
    // failure names the file and says what to do about it — a bare JSON parse
    // error is true and useless when it is the reason the app will not network.
    try {
      state = open(raw);
    } catch (err) {
      throw new Error(
        `The device key at ${file} could not be read (${err.message}). ` +
          'LanChat will not connect until this is resolved, because replacing it ' +
          'would look to every peer exactly like somebody impersonating you.'
      );
    }
    warnIfWorldReadable();
    return state;
  }

  // SSH's "permissions are too open", minus the refusal — the mode is corrected
  // rather than made fatal, because a restored backup or a careless umask is a
  // likelier cause here than an attack, and the file has just been proved intact.
  function warnIfWorldReadable() {
    if (process.platform === 'win32') return;
    try {
      const mode = fs.statSync(file).mode & 0o777;
      if (mode & 0o077) {
        console.warn(`[key] ${FILE} was mode ${mode.toString(8)}; tightening it to 600`);
        fs.chmodSync(file, 0o600);
      }
    } catch {
      /* not fatal — the key itself already verified */
    }
  }

  return {
    load,
    publicKey: () => load().publicKey,
    privateKey: () => load().plainPrivate,
    mode: () => load().mode,
    fingerprint: () => fingerprint(load().publicKey),
    // A deliberate new identity. The caller mints a new UUID with it — arriving
    // as an unknown contact is benign, arriving as a changed key is an alarm on
    // every peer at once.
    reset() {
      state = null;
      state = create();
      return state;
    },
    file,
  };
}

module.exports = { createDeviceKey, DEVICE_KEY_FILE: FILE };
