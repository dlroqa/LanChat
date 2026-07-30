'use strict';

const os = require('node:os');

// Which network a connection arrived on, and whether we want to talk to it.
//
// The listener binds 0.0.0.0, so it is reachable on every network the machine
// joins — a café's Wi-Fi as readily as a tailnet. The question this module
// answers is which of *our own* interfaces a connection landed on, taken from
// `socket.localAddress`. That is the one part of an inbound connection the peer
// cannot choose: a remote address can be spoofed, and a `100.x` source arriving
// on a LAN interface would sail through a check that looked at the peer's IP
// instead of ours.
//
// The tailnet is identified from `os.networkInterfaces()` rather than from
// `tailscale status`. The CLI is a five-second poll of an external binary, and
// `server.start()` runs before `discovery.start()` — so for the first seconds
// after launch the CLI's answer is "no tailnet", and anchoring on it would
// refuse every connection during exactly the window a peer is most likely to
// reconnect. The interface list is synchronous, local, and already true.

// Tailscale hands out CGNAT v4 (RFC 6598) and a fixed ULA v6 range.
const CGNAT_V4 = { octet: 100, min: 64, max: 127 };
const TAILSCALE_V6_PREFIX = 'fd7a:115c:a1e0';

// The interface list changes when a VPN comes up or Wi-Fi is joined, so it is
// re-read rather than captured once — but not on every packet.
const CACHE_MS = 5000;

// Strip the two decorations an address picks up on its way through Node: the
// IPv4-mapped IPv6 form a dual-stack socket reports, and the brackets a bare
// IPv6 address wears inside a host:port string. `server.js` produces the
// bracketed form, `os.networkInterfaces()` the plain one, and they have to
// compare equal or every check here silently refuses everything.
function bareAddress(addr) {
  if (!addr) return null;
  let a = String(addr).trim();
  if (a.startsWith('[')) {
    const close = a.indexOf(']');
    a = close === -1 ? a.slice(1) : a.slice(1, close);
  }
  if (a.startsWith('::ffff:')) a = a.slice(7);
  // A zone index ("fe80::1%en0") is about routing, not identity.
  const zone = a.indexOf('%');
  if (zone !== -1) a = a.slice(0, zone);
  return a.toLowerCase();
}

function isLoopback(addr) {
  const a = bareAddress(addr);
  if (!a) return false;
  return a === '::1' || a === '127.0.0.1' || a.startsWith('127.');
}

// Whether an address falls in a range Tailscale hands out. Membership in a range
// is not by itself proof of anything — a LAN host can carry a 100.x address —
// which is why this is only ever asked about our *own* interface addresses.
function inTailscaleRange(addr) {
  const a = bareAddress(addr);
  if (!a) return false;
  if (a.includes('.')) {
    const parts = a.split('.');
    if (parts.length !== 4) return false;
    const octets = parts.map((p) => Number(p));
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    return octets[0] === CGNAT_V4.octet && octets[1] >= CGNAT_V4.min && octets[1] <= CGNAT_V4.max;
  }
  return a.startsWith(`${TAILSCALE_V6_PREFIX}:`) || a === TAILSCALE_V6_PREFIX;
}

// `interfaces` and `now` are injectable so both branches of the policy below can
// be exercised on one machine — the same reason `windows` is a parameter in
// server.js. A confinement that cannot be tested is a confinement nobody knows
// the shape of.
// `manualAddresses` is supplied by discovery once it exists: an address the user
// typed in by hand is an explicit instruction to talk to that machine, and
// refusing it inbound while dialing it outbound would present as a connection
// that keeps flapping rather than as a policy.
function createNetScope({
  config,
  interfaces = () => os.networkInterfaces(),
  now = () => Date.now(),
  manualAddresses = () => [],
} = {}) {
  let cached = null;
  let cachedAt = 0;

  // Our own tailnet addresses. Empty is a meaningful answer — it means this
  // machine is not on a tailnet at all — and callers have to treat it as such
  // rather than as "not looked yet".
  function tailnetAddresses({ fresh = false } = {}) {
    const t = now();
    if (!fresh && cached && t - cachedAt < CACHE_MS) return cached;
    const found = new Set();
    let list;
    try {
      list = interfaces() || {};
    } catch {
      list = {};
    }
    for (const entries of Object.values(list)) {
      for (const entry of entries || []) {
        if (!entry || entry.internal) continue;
        if (inTailscaleRange(entry.address)) found.add(bareAddress(entry.address));
      }
    }
    cached = found;
    cachedAt = t;
    return found;
  }

  function refresh() {
    return tailnetAddresses({ fresh: true });
  }

  function hasTailnet() {
    return tailnetAddresses().size > 0;
  }

  // Did this connection land on our tailnet interface?
  function isTailnetLocal(localAddress) {
    const a = bareAddress(localAddress);
    if (!a) return false;
    return tailnetAddresses().has(a);
  }

  // The policy. Loopback is always ours — it is how the renderer reaches its own
  // preview endpoint and how the tests connect. Beyond that, a connection is
  // accepted if it arrived on the tailnet, or if the machine's owner has said
  // they want to be reachable over the plain LAN as well.
  //
  // With no tailnet present and LAN accept off, this refuses everything. That is
  // deliberate and it is not silent: `reachability()` reports the state so the
  // window can say why nobody can reach you, rather than the app looking broken.
  // Failing open here would mean a Tailscale outage quietly reopening the app to
  // whatever network it happens to be sitting on.
  function allowInbound(localAddress, remoteAddress = null) {
    if (isLoopback(localAddress)) return true;
    if (isTailnetLocal(localAddress)) return true;
    if (acceptLan()) return true;
    // Typed in by hand, which is consent.
    const from = bareAddress(remoteAddress);
    return Boolean(from && manualAddresses().some((a) => bareAddress(a) === from));
  }

  function acceptLan() {
    return Boolean(config && config.get('acceptLan'));
  }

  function reachability() {
    const tailnet = hasTailnet();
    const lan = acceptLan();
    return {
      tailnet,
      lan,
      // Nothing outside this machine can reach us in this state.
      unreachable: !tailnet && !lan,
      addresses: [...tailnetAddresses()],
    };
  }

  return { allowInbound, isTailnetLocal, isLoopback, hasTailnet, reachability, refresh };
}

module.exports = { createNetScope, isLoopback, inTailscaleRange, bareAddress };
