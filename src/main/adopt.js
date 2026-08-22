'use strict';

const http = require('node:http');

// Turning an address into a peer, and remembering the addresses not to bother.
//
// Every discovery backend answers the same question in a different way — the
// Tailscale CLI lists a tailnet, a UDP beacon hears a subnet, a Netmaker mesh is
// read from netclient — but they all end up holding an IP and needing the same
// four steps: probe it, ignore ourselves, record what we worked out locally, and
// dial. That sequence lived inside discovery.js's closure while there was only
// one caller. It is here so a second backend uses the *same* funnel rather than
// a copy of it, which matters most for the backoff below: two copies would mean
// an address that refused one transport being hammered over the other.

const PROBE_TIMEOUT = 2500;

function probeWhoami(ip, port) {
  return new Promise((resolve) => {
    const req = http.get({ host: ip, port, path: '/lanchat/whoami', timeout: PROBE_TIMEOUT }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

// A manual peer, however it was written down.
//
// This list was flat "ip:port" strings for a long time, and a peer code needs to
// record more than that — the id and fingerprint it promised, so the first
// connection can be checked against them. So the entries became records, and
// **both spellings are read here rather than only after a migration**. That is
// deliberate: config.migrate() upgrades the file on load, but nothing stops a
// string being written into config afterwards (the wiring suite does exactly
// that), and a reader that only understood records would refuse an address the
// user had added by hand.
function manualPeerRecord(entry, defaultPort = null) {
  if (entry && typeof entry === 'object') {
    const address = String(entry.address || '').trim();
    if (!address) return null;
    return {
      address,
      port: Number(entry.port) || defaultPort || null,
      peerId: entry.peerId || null,
      fingerprint: entry.fingerprint || null,
      label: entry.label || null,
      networkKey: entry.networkKey || null,
    };
  }
  const [ip, portStr] = String(entry || '').split(':');
  const address = String(ip || '').trim();
  if (!address) return null;
  return {
    address,
    port: Number(portStr) || defaultPort || null,
    peerId: null,
    fingerprint: null,
    label: null,
    networkKey: null,
  };
}

// Addresses that failed to authenticate, and when to bother them again.
//
// This became necessary the moment the handshake did. Every online tailnet
// node is adopted every five seconds and the `dialing` guard clears on close,
// so a node that is not running LanChat — or is running a version that cannot
// authenticate — produced a failed handshake every five seconds, forever, with
// a log line and a roster entry each time. Strict refusal without backoff is a
// denial of service you inflict on yourself.
const BACKOFF_BASE_MS = 30000;
const BACKOFF_MAX_MS = 15 * 60 * 1000;

// `probe` is injectable so the funnel can be exercised without a socket.
function createAdopter({ config, getIdentity, hub, bus, probe = probeWhoami }) {
  const backoff = new Map(); // "ip:port" -> { until, failures }

  function isBackedOff(address) {
    const entry = backoff.get(address);
    if (!entry) return false;
    if (Date.now() >= entry.until) return false;
    return true;
  }

  function noteAuthFailure(address) {
    if (!address) return;
    const entry = backoff.get(address) || { failures: 0 };
    entry.failures += 1;
    // Doubling, capped. A peer that is simply switched off should not be waited
    // on for an hour once they come back.
    entry.until = Date.now() + Math.min(BACKOFF_BASE_MS * 2 ** (entry.failures - 1), BACKOFF_MAX_MS);
    backoff.set(address, entry);
  }

  // A peer that authenticates has earned a clean slate.
  bus.on('peer-hello', ({ peerId }) => {
    const address = hub.addresses.get(peerId);
    if (address) backoff.delete(address);
  });
  bus.on('peer-auth-failed', ({ address }) => noteAuthFailure(address));

  // `extra` carries facts we know locally (e.g. the peer is shared in from
  // another tailnet) which the peer itself cannot tell us about.
  //
  // The probe response is an unauthenticated stranger's word, so it decides one
  // thing only: where to dial. It used to go straight into `hub.setIdentity`,
  // which meant a name and an avatar of somebody else's choosing appeared in the
  // roster before a single frame had been authenticated — and appeared whether
  // or not the dial ever succeeded. What a peer looks like now arrives with the
  // handshake, signed. What we worked out ourselves goes in as a hint, which
  // display treats as the weakest source.
  async function adopt(ip, defaultPort, extra = {}) {
    const port = defaultPort || config.get('servicePort');
    if (isBackedOff(`${ip}:${port}`)) return null;
    const who = await probe(ip, port);
    if (!who || !who.id || who.id === getIdentity().id) return who;
    const svcPort = who.servicePort || port;
    if (Object.keys(extra).length) hub.setDiscoveryHint(who.id, extra);
    hub.connect(who.id, `${ip}:${svcPort}`);
    return who;
  }

  return { adopt, isBackedOff, noteAuthFailure };
}

module.exports = {
  createAdopter,
  probeWhoami,
  manualPeerRecord,
  PROBE_TIMEOUT,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
};
