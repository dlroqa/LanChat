'use strict';

// What a mesh interface is, and which network an address belongs to.
//
// Pure and dependency-free on purpose. Two modules need this vocabulary and
// neither may require the other: netScope.js has to answer "did this connection
// land on a network I trust?" synchronously, during the window before any
// discovery poll has run, while netmaker.js reads the same interfaces on a timer
// and talks to a CLI and a server. Putting the shared facts here keeps netScope
// free of child_process and http, which is the property its header comment is
// really about.
//
// A note on identification. An overlay is recognised by its interface *name*,
// not by its address range. Netmaker hands out operator-chosen CIDRs — usually
// somewhere in 10.x — which is indistinguishable from an ordinary office LAN, so
// a range test alone would silently promote a café's network to a mesh. The name
// is the gate; the address then says *which* mesh network, because modern
// netclient puts one `netmaker` interface on the machine carrying an address per
// joined network rather than an interface each.

// Adding an overlay here is a data change. Order is not significant; the first
// pattern that matches names the backend.
const MESH_BACKENDS = Object.freeze([Object.freeze({ backend: 'netmaker', pattern: /^(netmaker|nm-.+)$/i })]);

// Strip the two decorations an address picks up on its way through Node: the
// IPv4-mapped IPv6 form a dual-stack socket reports, and the brackets a bare
// IPv6 address wears inside a host:port string. `server.js` produces the
// bracketed form, `os.networkInterfaces()` the plain one, and they have to
// compare equal or every check built on this silently refuses everything.
//
// This lives here rather than in netScope.js so there is exactly one of it:
// netScope re-exports it, and mesh comparisons cannot drift from admission
// comparisons by having been written twice.
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

function isMeshInterfaceName(name) {
  if (!name) return null;
  const n = String(name).trim();
  for (const entry of MESH_BACKENDS) if (entry.pattern.test(n)) return entry.backend;
  return null;
}

function familyOf(addr) {
  const a = bareAddress(addr);
  if (!a) return null;
  if (a.includes(':')) return 6;
  return a.includes('.') ? 4 : null;
}

// Addresses become BigInts so one set of masking rules covers v4 and v6. Returns
// null for anything malformed rather than throwing: these values come from an
// operator's config and from a CLI, and a bad one must narrow what we trust
// rather than crash the poll that reads it.
function ipToInt(addr) {
  const a = bareAddress(addr);
  if (!a) return null;
  if (!a.includes(':')) {
    const parts = a.split('.');
    if (parts.length !== 4) return null;
    let out = 0n;
    for (const p of parts) {
      if (!/^\d{1,3}$/.test(p)) return null;
      const n = Number(p);
      if (n > 255) return null;
      out = (out << 8n) | BigInt(n);
    }
    return out;
  }
  // IPv6, possibly with a "::" run and possibly with a trailing v4 form.
  let text = a;
  let tail = 0n;
  let tailGroups = 0;
  const lastColon = text.lastIndexOf(':');
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const v4 = ipToInt(maybeV4);
    if (v4 === null) return null;
    tail = v4;
    tailGroups = 2;
    text = text.slice(0, lastColon + 1) + '0';
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  const groups = [];
  for (const g of head) groups.push(g);
  if (rest === null) {
    if (groups.length !== 8 - tailGroups + (tailGroups ? 1 : 0)) {
      // No "::" means every group must be written out.
      if (groups.length !== 8) return null;
    }
  } else {
    const fill = 8 - (head.length + rest.length);
    if (fill < 0) return null;
    for (let i = 0; i < fill; i += 1) groups.push('0');
    for (const g of rest) groups.push(g);
  }
  if (groups.length !== 8) return null;
  let out = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out = (out << 16n) | BigInt(parseInt(g, 16));
  }
  if (tailGroups) out = (out & ~0xffffffffn) | tail;
  return out;
}

function intToIp(value, family) {
  if (value === null || value === undefined) return null;
  if (family === 4) {
    const o = [];
    for (let i = 3; i >= 0; i -= 1) o.push(Number((value >> BigInt(i * 8)) & 0xffn));
    return o.join('.');
  }
  const groups = [];
  for (let i = 7; i >= 0; i -= 1) groups.push(Number((value >> BigInt(i * 16)) & 0xffffn).toString(16));
  // Compress the longest run of zero groups, as the address will be shown to a
  // person in Settings, not only used as a map key.
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  for (let i = 0; i <= groups.length; i += 1) {
    if (i < groups.length && groups[i] === '0') {
      if (runStart === -1) runStart = i;
    } else if (runStart !== -1) {
      const len = i - runStart;
      if (len > bestLen) {
        bestLen = len;
        bestStart = runStart;
      }
      runStart = -1;
    }
  }
  if (bestLen < 2) return groups.join(':');
  return `${groups.slice(0, bestStart).join(':')}::${groups.slice(bestStart + bestLen).join(':')}`;
}

function bitsFor(family) {
  return family === 4 ? 32 : 128;
}

// "10.101.0.0/24" -> { base, prefix, family, first } with `first` the masked
// network address, so two spellings of the same network compare equal.
function parseCidr(text) {
  if (!text) return null;
  const raw = String(text).trim();
  const slash = raw.lastIndexOf('/');
  if (slash === -1) return null;
  const addr = bareAddress(raw.slice(0, slash));
  const prefix = Number(raw.slice(slash + 1));
  const family = familyOf(addr);
  if (!family) return null;
  const bits = bitsFor(family);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return null;
  const value = ipToInt(addr);
  if (value === null) return null;
  const mask = prefix === 0 ? 0n : (~0n << BigInt(bits - prefix)) & ((1n << BigInt(bits)) - 1n);
  const first = value & mask;
  return { base: intToIp(first, family), prefix, family, first, mask };
}

function inCidr(addr, cidr) {
  const net = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  if (!net) return false;
  if (familyOf(addr) !== net.family) return false;
  const value = ipToInt(addr);
  if (value === null) return false;
  return (value & net.mask) === net.first;
}

// Prefix length from a dotted netmask, for the older interface shape that
// reports `netmask` without `cidr`.
function prefixFromNetmask(netmask, family) {
  const value = ipToInt(netmask);
  if (value === null) return null;
  const bits = bitsFor(family);
  let count = 0;
  for (let i = bits - 1; i >= 0; i -= 1) {
    if ((value >> BigInt(i)) & 1n) count += 1;
    else break;
  }
  return count;
}

// The mesh addresses this machine currently holds.
//
// Takes the interface map rather than calling os.networkInterfaces() itself, so
// both callers can inject one and the same list can be replayed in a test.
// Entries without a `cidr` or `netmask` are kept — an address we cannot place in
// a network is still an address we hold, and the caller decides what that is
// worth.
function meshInterfaces(list) {
  const out = [];
  if (!list || typeof list !== 'object') return out;
  for (const [iface, entries] of Object.entries(list)) {
    const backend = isMeshInterfaceName(iface);
    if (!backend) continue;
    for (const entry of entries || []) {
      if (!entry || entry.internal) continue;
      const address = bareAddress(entry.address);
      const family = familyOf(address);
      if (!address || !family) continue;
      let prefix = null;
      if (entry.cidr) {
        const parsed = parseCidr(entry.cidr);
        if (parsed) prefix = parsed.prefix;
      }
      if (prefix === null && entry.netmask) prefix = prefixFromNetmask(entry.netmask, family);
      const network = prefix === null ? null : parseCidr(`${address}/${prefix}`);
      out.push({
        iface,
        backend,
        address,
        family,
        prefix,
        cidr: network ? `${network.base}/${network.prefix}` : null,
      });
    }
  }
  return out;
}

// A network's stable identity.
//
// The user's decision to trust a network has to survive a restart, an interface
// rename, and the CLI that named it going away — so the key is built from the
// most durable facts available, and degrades in a fixed order rather than
// changing shape when a source appears or disappears:
//
//   1. server + network  — the real identity, once anything has told us both
//   2. network only      — upgraded to (1) the first time a server is learned
//   3. neither           — the interface and the CIDR, which are the only things
//                          visible synchronously with no CLI and no credentials
//
// Rule 3 deliberately avoids the host address: an address can be reassigned by
// the server while the network stays the same one the user ticked.
function networkKey({ server = null, network = null, iface = null, cidr = null } = {}) {
  if (server && network) return `${String(server).toLowerCase()}|${network}`;
  if (network) return `?|${network}`;
  if (iface && cidr) {
    const parsed = parseCidr(cidr);
    if (parsed) return `iface:${iface}/${parsed.base}/${parsed.prefix}`;
  }
  return iface ? `iface:${iface}` : null;
}

// Which known network an address of ours belongs to. `records` are the stored
// network records; the interface has already been established as a mesh one by
// the caller, so this only has to choose between networks.
function resolveNetwork(address, iface, records) {
  const list = Array.isArray(records) ? records : [];
  const matches = list.filter((r) => r && r.cidr && inCidr(address, r.cidr));
  if (matches.length === 1) return matches[0];
  // Two networks claiming one address is a real state (overlapping CIDRs, which
  // Netmaker cannot bridge either). Refusing to guess is the honest answer, and
  // the caller reports it rather than trusting whichever sorted first.
  if (matches.length > 1) return null;
  return null;
}

module.exports = {
  MESH_BACKENDS,
  bareAddress,
  isMeshInterfaceName,
  familyOf,
  ipToInt,
  intToIp,
  parseCidr,
  inCidr,
  prefixFromNetmask,
  meshInterfaces,
  networkKey,
  resolveNetwork,
};
