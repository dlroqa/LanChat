'use strict';

const os = require('node:os');

const { bareAddress, meshInterfaces, networkKey, resolveNetwork } = require('./mesh');

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

// `bareAddress` lives in mesh.js so mesh membership and inbound admission cannot
// drift apart by having been written twice; it is re-exported below because
// callers and tests have always reached it through this module.

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

  // One walk of the interface list, two answers: which of our addresses are on a
  // tailnet, and which are on an overlay mesh. Read together because they come
  // from the same syscall and are asked on the same code path — an inbound
  // connection.
  function scan({ fresh = false } = {}) {
    const t = now();
    if (!fresh && cached && t - cachedAt < CACHE_MS) return cached;
    const tailnet = new Set();
    let list;
    try {
      list = interfaces() || {};
    } catch {
      list = {};
    }
    for (const entries of Object.values(list)) {
      for (const entry of entries || []) {
        if (!entry || entry.internal) continue;
        if (inTailscaleRange(entry.address)) tailnet.add(bareAddress(entry.address));
      }
    }
    const mesh = new Map();
    for (const entry of meshInterfaces(list)) mesh.set(entry.address, entry);
    cached = { tailnet, mesh };
    cachedAt = t;
    return cached;
  }

  // Our own tailnet addresses. Empty is a meaningful answer — it means this
  // machine is not on a tailnet at all — and callers have to treat it as such
  // rather than as "not looked yet".
  function tailnetAddresses({ fresh = false } = {}) {
    return scan({ fresh }).tailnet;
  }

  function refresh() {
    return scan({ fresh: true }).tailnet;
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

  // Which mesh network one of our own addresses belongs to.
  //
  // The interface name is the gate and the address is the discriminator, in that
  // order, and the order is the point. An overlay hands out operator-chosen
  // ranges — Netmaker's are usually somewhere in 10.x — which a café LAN is
  // indistinguishable from, so a range test alone would promote whatever network
  // the machine is sitting on. And modern netclient puts *one* interface on the
  // machine carrying an address per joined network, so the name alone cannot say
  // which network either: it would collapse every network into a single trust
  // decision and quietly undo the per-network choice the user made.
  //
  // The records come from config, which is on disk before server.start() runs.
  // That is what keeps this synchronous and true during boot, for the same
  // reason this module reads os.networkInterfaces() rather than a CLI.
  function meshNetworkFor(localAddress) {
    const a = bareAddress(localAddress);
    if (!a) return null;
    const entry = scan().mesh.get(a);
    if (!entry) return null;
    const records = (config && config.get('netmakerNetworks')) || [];
    const matched = resolveNetwork(a, entry.iface, records);
    if (matched) return matched;
    // Nothing stored yet, or two records overlap so the address cannot say which
    // network it is in. Fall back to the key the interface alone implies, which
    // is the same one netmaker.js computes from the same facts — and which is
    // null when even that is unknown, so the caller refuses rather than guesses.
    const key = networkKey({ iface: entry.iface, cidr: entry.cidr });
    return key ? { key, network: null, iface: entry.iface, cidr: entry.cidr } : null;
  }

  function isMeshLocal(localAddress) {
    return Boolean(meshNetworkFor(localAddress));
  }

  // Read live and never cached, exactly like acceptLan(): a network the user has
  // just untrusted must stop being reachable on the next connection, not on the
  // next restart.
  function trustedMeshKeys() {
    return new Set((config && config.get('netmakerTrusted')) || []);
  }

  function isTrustedMeshLocal(localAddress) {
    const rec = meshNetworkFor(localAddress);
    return Boolean(rec && rec.key && trustedMeshKeys().has(rec.key));
  }

  // The policy. Loopback is always ours — it is how the renderer reaches its own
  // preview endpoint and how the tests connect. Beyond that, a connection is
  // accepted if it arrived on the tailnet, on a mesh network the owner has
  // ticked, or if they have said they want to be reachable over the plain LAN
  // as well.
  //
  // The mesh clause is opt-in per network and empty by default, so on every
  // installation that upgrades into it this line is a no-op and the policy is
  // exactly the one that was here before. Joining a network to reach one person
  // is not consent to be reachable from every network you are enrolled in.
  //
  // With no tailnet present and LAN accept off, this refuses everything. That is
  // deliberate and it is not silent: `reachability()` reports the state so the
  // window can say why nobody can reach you, rather than the app looking broken.
  // Failing open here would mean a Tailscale outage quietly reopening the app to
  // whatever network it happens to be sitting on.
  function allowInbound(localAddress, remoteAddress = null) {
    if (isLoopback(localAddress)) return true;
    if (isTailnetLocal(localAddress)) return true;
    if (isTrustedMeshLocal(localAddress)) return true;
    if (acceptLan()) return true;
    // Typed in by hand, which is consent.
    const from = bareAddress(remoteAddress);
    return Boolean(from && manualAddresses().some((a) => bareAddress(a) === from));
  }

  function acceptLan() {
    return Boolean(config && config.get('acceptLan'));
  }

  // The mesh networks we hold an address on, and whether each may reach us.
  function meshState() {
    const trusted = trustedMeshKeys();
    const out = [];
    const seen = new Set();
    for (const entry of scan().mesh.values()) {
      const rec = meshNetworkFor(entry.address);
      const key = rec && rec.key;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({
        key,
        network: (rec && rec.network) || null,
        iface: entry.iface,
        address: entry.address,
        trusted: trusted.has(key),
      });
    }
    return out;
  }

  function reachability() {
    const tailnet = hasTailnet();
    const lan = acceptLan();
    const mesh = meshState();
    const meshTrusted = mesh.some((m) => m.trusted);
    return {
      tailnet,
      lan,
      mesh,
      meshTrusted,
      // Nothing outside this machine can reach us in this state.
      unreachable: !tailnet && !lan && !meshTrusted,
      // Deliberately still the tailnet addresses only. Settings shows these
      // under "Tailscale", and widening the field would make that block say
      // something untrue; the mesh addresses have a field of their own above.
      addresses: [...tailnetAddresses()],
    };
  }

  return {
    allowInbound,
    isTailnetLocal,
    isMeshLocal,
    isTrustedMeshLocal,
    meshNetworkFor,
    isLoopback,
    hasTailnet,
    reachability,
    refresh,
  };
}

module.exports = { createNetScope, isLoopback, inTailscaleRange, bareAddress };
