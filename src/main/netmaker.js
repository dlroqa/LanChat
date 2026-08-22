'use strict';

const os = require('node:os');
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const { execFile } = require('node:child_process');

const { meshInterfaces, networkKey, parseCidr, bareAddress } = require('./mesh');

// Netmaker, as a second overlay beside Tailscale.
//
// Netmaker (netmaker.io) is a self-hosted WireGuard mesh. A server hosts
// networks with operator-chosen CIDRs — usually somewhere in 10.x — and the
// `netclient` agent brings up an interface carrying an address per network this
// machine has joined. Two people on different Netmaker servers reach each other
// by both joining one shared network on one of them, which is why this module
// carries a *list* of networks rather than the single tailnet discovery.js
// assumes, and tags every peer with the network it came in over.
//
// Peers are learned in tiers, because the obvious source is not always readable:
//
//   A. `netclient list` — the direct equivalent of `tailscale status --json`.
//   B. a Netmaker server's REST API — needs a URL and a token, but works when
//      netclient's own config is root-owned and unreadable to a desktop app.
//   C. our own interfaces — always available, needs no credentials and spawns
//      nothing, and is the only tier that can run before either of the others.
//
// Tier C cannot enumerate peers, and deliberately does not try. WireGuard is
// point-to-point with no broadcast, so the UDP beacon discovery.js uses cannot
// work here; and sweeping a /24 every poll would push 254 addresses through the
// shared auth backoff, which is the denial of service that backoff exists to
// prevent. What C gives us is which networks we are on and what our address is
// on each — enough to admit inbound connections and to show the user a list to
// choose from, with peers arriving from A, B, or a pasted peer code.
//
const IFACE_INTERVAL = 5000;
const NETCLIENT_INTERVAL = 15000;
// Below its interval, so a hung call fails cleanly and the next tick retries
// rather than stacking up — the same reason TAILSCALE_STATUS_TIMEOUT is set
// below its own poll.
const NETCLIENT_TIMEOUT = 6000;

// Where netclient actually lives, per platform.
//
// The same trap discovery.js documents for the Tailscale CLI applies here: a
// GUI-launched app does not inherit the shell's PATH, so a bare
// execFile('netclient') fails with ENOENT and the mesh silently never returns a
// peer. Probing known locations is what makes this work outside a terminal.
const NETCLIENT_PATHS = {
  linux: ['/usr/bin/netclient', '/usr/local/bin/netclient', '/sbin/netclient'],
  darwin: ['/usr/local/bin/netclient', '/opt/homebrew/bin/netclient', '/usr/bin/netclient'],
  win32: ['C:\\Program Files\\Netclient\\netclient.exe', 'C:\\ProgramData\\Netclient\\netclient.exe'],
};

let cachedBinary; // undefined = not looked up yet, null = genuinely not found

function findNetclientBinary(configured = null) {
  if (configured) return configured;
  if (cachedBinary !== undefined) return cachedBinary;
  for (const candidate of NETCLIENT_PATHS[process.platform] || []) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      cachedBinary = candidate;
      return cachedBinary;
    } catch {
      // Not installed at this location — try the next.
    }
  }
  cachedBinary = 'netclient';
  return cachedBinary;
}

// Exposed so a failed lookup is retried once netclient is installed, without
// restarting the app.
function resetNetclientBinary() {
  cachedBinary = undefined;
}

// Every binary worth trying, most likely first, PATH last. A configured path
// goes to the front: netclient has no bundle location to guess at, so it needs
// the escape hatch the Tailscale lookup never got.
function netclientCandidates(configured = null) {
  const list = [];
  if (configured) list.push(configured);
  if (cachedBinary) list.push(cachedBinary);
  for (const p of NETCLIENT_PATHS[process.platform] || []) if (!list.includes(p)) list.push(p);
  if (!list.includes('netclient')) list.push('netclient');
  return list;
}

// The stderr of a netclient that cannot read its own configuration.
//
// This is the case that makes the interface tier and the server tier necessary
// rather than merely nice: netclient keeps its config in /etc/netclient (or
// C:\ProgramData\Netclient), owned by root, so on an ordinary desktop account
// the CLI is present, runs, and can tell us nothing.
const PERMISSION_RE = /permission denied|operation not permitted|must be run as (root|admin)|EACCES/i;

// Pulls the JSON out of `netclient list`, tolerating noise around it.
//
// Same two hazards as the Tailscale status: a CLI can print a log line before
// the JSON, and can emit a complete answer while exiting non-zero. Trust a
// parseable payload wherever it is found, and only fall back to an error when
// there is genuinely nothing.
function extractListJson(stdout) {
  if (!stdout) return null;
  const text = String(stdout);
  const shaped = (o) => Array.isArray(o) || (o && typeof o === 'object');
  try {
    const obj = JSON.parse(text);
    if (shaped(obj)) return obj;
  } catch {
    // Not clean JSON — carve it out of the surrounding noise.
  }
  for (const [open, close] of [
    ['[', ']'],
    ['{', '}'],
  ]) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start >= 0 && end > start) {
      try {
        const obj = JSON.parse(text.slice(start, end + 1));
        if (shaped(obj)) return obj;
      } catch {
        // Try the other bracket shape.
      }
    }
  }
  return null;
}

// A host address out of an allowed-ips entry: "10.101.0.9/32" -> "10.101.0.9".
// Anything wider is a route, not a peer, and is kept separately as an egress
// range — see reachableRanges.
function hostOfAllowedIp(entry) {
  const parsed = parseCidr(String(entry || ''));
  if (!parsed) return null;
  const full = parsed.family === 4 ? 32 : 128;
  return parsed.prefix === full ? parsed.base : null;
}

function rangeOfAllowedIp(entry) {
  const parsed = parseCidr(String(entry || ''));
  if (!parsed) return null;
  const full = parsed.family === 4 ? 32 : 128;
  return parsed.prefix === full ? null : `${parsed.base}/${parsed.prefix}`;
}

// Pure parse of `netclient list [-l]`. Exported for tests.
//
// Every field is treated as optional and several spellings are accepted. The
// exact shape is not pinned by any documentation I could verify, and a netclient
// that renames a field should cost us the field rather than the whole mesh.
function parseNetclientList(payload) {
  const raw = typeof payload === 'string' ? extractListJson(payload) : payload;
  if (!raw) return [];
  const rows = Array.isArray(raw)
    ? raw
    : Array.isArray(raw.networks)
      ? raw.networks
      : Array.isArray(raw.nodes)
        ? raw.nodes
        : [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const network = row.network || row.Network || null;
    if (!network) continue;
    const addresses = [row.ipv4_addr, row.ipv6_addr, row.address, row.Address]
      .map((a) => bareAddress(a && String(a).split('/')[0]))
      .filter(Boolean);
    const peers = [];
    const ranges = [];
    for (const peer of Array.isArray(row.peers) ? row.peers : []) {
      if (!peer || typeof peer !== 'object') continue;
      const allowed = Array.isArray(peer.allowed_ips) ? peer.allowed_ips : [];
      for (const entry of allowed) {
        const host = hostOfAllowedIp(entry);
        if (host) {
          peers.push({ address: host, publicKey: peer.public_key || null, endpoint: peer.endpoint || null });
          continue;
        }
        // A prefix wider than a single host is a route another node advertises —
        // an egress gateway bridging a second network into this one.
        const range = rangeOfAllowedIp(entry);
        if (range) ranges.push({ cidr: range, viaPeer: peer.public_key || peer.endpoint || null });
      }
    }
    out.push({
      network,
      nodeId: row.node_id || row.NodeID || null,
      connected: row.connected !== false,
      addresses,
      peers,
      reachableRanges: ranges,
      discovered: 'netclient',
    });
  }
  return out;
}

function runNetclientList(bin, { timeout = NETCLIENT_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    const attempt = (args, thenPlain) => {
      execFile(bin, args, { maxBuffer: 8 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
        const parsed = extractListJson(stdout);
        if (parsed) return resolve({ payload: parsed });
        if (err && err.code === 'ENOENT') return resolve({ missing: true });
        const detail = String(stderr || (err && err.message) || '')
          .trim()
          .slice(0, 300);
        if (PERMISSION_RE.test(detail)) return resolve({ permission: true, detail });
        // `-l` asks the server for peer detail and is the newer spelling; an
        // older netclient rejects the flag rather than the command.
        if (thenPlain) return attempt(['list'], false);
        resolve({ detail: detail || null });
      });
    };
    attempt(['list', '-l'], true);
  });
}

// Tier A. Returns the parsed networks, or a reason nobody could be listed.
async function netclientNetworks({ configured = null, run = runNetclientList } = {}) {
  let sawRunnable = false;
  let lastDetail = null;
  for (const bin of netclientCandidates(configured)) {
    const r = await run(bin);
    if (r.payload) {
      if (cachedBinary !== bin && !configured) console.log('[netmaker] netclient answered:', bin);
      if (!configured) cachedBinary = bin;
      const parsed = parseNetclientList(r.payload);
      return parsed.length ? { networks: parsed } : { __error: 'no-networks' };
    }
    if (r.permission) return { __error: 'permission', detail: r.detail };
    if (!r.missing) {
      sawRunnable = true;
      lastDetail = r.detail || lastDetail;
    }
  }
  if (!sawRunnable) {
    resetNetclientBinary(); // re-scan next time, in case it gets installed
    return { __error: 'not-installed' };
  }
  return { __error: 'unavailable', detail: lastDetail };
}

function nowMs() {
  return Date.now();
}

// A server's host, which is the half of a network key that names the tenant.
function hostOf(apiUrl) {
  try {
    return new URL(apiUrl).host.toLowerCase();
  } catch {
    return null;
  }
}

// A record per network, merged over whatever we knew before.
//
// `firstSeen` is preserved across polls because it decides which network is this
// machine's home when the user has not said — and a home that changed every time
// the interface list was re-read would move the "not your home network" tag
// around under them.
function mergeNetworks(previous, observed, at = nowMs()) {
  const before = new Map();
  for (const rec of Array.isArray(previous) ? previous : []) {
    if (rec && rec.key) before.set(rec.key, rec);
  }
  const out = [];
  for (const rec of observed) {
    // A record whose key just became more specific is the same network it always
    // was. Without this it would look newly discovered the moment netclient
    // named it — and `home`, which is decided by first sighting, would move to
    // whichever network happened not to be renamed.
    const prior = before.get(rec.key) || (rec.supersedes ? before.get(rec.supersedes) : null);
    out.push({
      ...prior,
      ...rec,
      // Never let a later, thinner sighting blank out something a richer tier
      // already told us.
      server: rec.server || (prior && prior.server) || null,
      network: rec.network || (prior && prior.network) || null,
      cidr: rec.cidr || (prior && prior.cidr) || null,
      reachableRanges: rec.reachableRanges || (prior && prior.reachableRanges) || [],
      firstSeen: (prior && prior.firstSeen) || at,
      lastSeen: at,
    });
  }
  return out.sort((a, b) => a.firstSeen - b.firstSeen || String(a.key).localeCompare(String(b.key)));
}

// Which network is this machine's own. The user's choice wins; otherwise the one
// we were on first, which is the network you had before you joined one to reach
// somebody else.
function homeKeyOf(records, chosen = null) {
  const list = Array.isArray(records) ? records : [];
  if (chosen && list.some((r) => r && r.key === chosen)) return chosen;
  let best = null;
  for (const rec of list) {
    if (!rec || !rec.key) continue;
    if (!best || (rec.firstSeen || 0) < (best.firstSeen || 0)) best = rec;
  }
  return best ? best.key : null;
}

// Tier C. Pure given an interface list, so it can be replayed in a test.
function networksFromInterfaces(list) {
  const seen = new Map();
  for (const entry of meshInterfaces(list)) {
    const key = networkKey({ iface: entry.iface, cidr: entry.cidr });
    if (!key) continue;
    // One interface can carry several networks; two addresses in the same
    // network (v4 and v6) are one network with two addresses.
    const existing = seen.get(key);
    if (existing) {
      if (!existing.addresses.includes(entry.address)) existing.addresses.push(entry.address);
      continue;
    }
    seen.set(key, {
      key,
      server: null,
      network: null,
      cidr: entry.cidr,
      iface: entry.iface,
      backend: entry.backend,
      ourAddress: entry.address,
      addresses: [entry.address],
      reachableRanges: [],
      discovered: 'interface',
    });
  }
  return [...seen.values()];
}

// Two networks whose CIDRs overlap cannot be told apart by address, and Netmaker
// cannot bridge them either. Reported rather than resolved, so Settings can say
// so instead of the machine silently attaching a trust decision to the wrong one.
function overlappingKeys(records) {
  const list = (Array.isArray(records) ? records : []).filter((r) => r && r.cidr);
  const clashes = new Set();
  for (const a of list) {
    for (const b of list) {
      if (a === b || a.key === b.key) continue;
      const na = parseCidr(a.cidr);
      const nb = parseCidr(b.cidr);
      if (!na || !nb || na.family !== nb.family) continue;
      const wider = na.prefix <= nb.prefix ? na : nb;
      const inner = na.prefix <= nb.prefix ? nb : na;
      if ((inner.first & wider.mask) === wider.first) {
        clashes.add(a.key);
        clashes.add(b.key);
      }
    }
  }
  return [...clashes];
}

const API_TIMEOUT = 6000;
const API_INTERVAL = 30000;

// Tier B: a Netmaker server's own node list.
//
// This is the tier that makes cross-tenant work. netclient only knows the
// networks *this* machine has joined, so somebody on another Netmaker server is
// invisible to it; a read token for that server is what makes them appear. It is
// also the fallback when netclient is installed but its configuration is
// root-owned and unreadable.
//
// `GET {apiUrl}/api/nodes` with a bearer token. Deliberately read-only: nothing
// here creates, joins or modifies anything on the server.
function fetchNetmakerNodes({ apiUrl, token, timeout = API_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL('/api/nodes', apiUrl);
    } catch {
      return resolve({ __error: 'api-unreachable', detail: 'that is not a valid address' });
    }
    const client = url.protocol === 'http:' ? http : https;
    const req = client.get(
      url,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, timeout },
      (res) => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          res.resume();
          return resolve({ __error: 'unauthorised' });
        }
        if (res.statusCode !== 200) {
          res.resume();
          return resolve({ __error: 'api-unreachable', detail: `the server answered ${res.statusCode}` });
        }
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve({ payload: JSON.parse(body) });
          } catch {
            resolve({ __error: 'api-unreachable', detail: 'the server did not answer with JSON' });
          }
        });
      }
    );
    req.on('timeout', () => req.destroy());
    // A message, never a stack: this string can reach a Settings panel.
    req.on('error', (err) => resolve({ __error: 'api-unreachable', detail: err.message }));
  });
}

// Pure parse of a node list. Exported for tests.
//
// Three envelope shapes are accepted because Netmaker has used more than one,
// and every field is optional for the same reason parseNetclientList treats them
// so: a renamed field should cost us the field, not the server.
function parseNetmakerNodes(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload && payload.Response)
      ? payload.Response
      : Array.isArray(payload && payload.data)
        ? payload.data
        : Array.isArray(payload && payload.nodes)
          ? payload.nodes
          : [];
  const byNetwork = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const network = row.network || row.Network || null;
    if (!network) continue;
    const address = bareAddress(String(row.address || row.Address || '').split('/')[0]);
    const address6 = bareAddress(String(row.address6 || row.Address6 || '').split('/')[0]);
    const rec = byNetwork.get(network) || { network, peers: [], addresses: [], reachableRanges: [] };
    // `connected` and `lastcheckin` are the server's opinion of liveness. A node
    // it believes to be down is still worth listing: the probe decides, not this.
    for (const a of [address, address6]) {
      if (a) rec.peers.push({ address: a, hostId: row.hostid || row.HostID || null, name: row.name || null });
    }
    for (const range of Array.isArray(row.egressgatewayranges) ? row.egressgatewayranges : []) {
      const parsed = parseCidr(String(range));
      if (parsed)
        rec.reachableRanges.push({ cidr: `${parsed.base}/${parsed.prefix}`, viaPeer: address || null });
    }
    byNetwork.set(network, rec);
  }
  return [...byNetwork.values()].map((rec) => ({ ...rec, connected: true, discovered: 'api' }));
}

// A named tier's rows — netclient's or a server's — in the shape mergeNetworks
// unions on. The key can be the real one (server + network) as soon as a server
// is known; until then the network name alone, which networkKey upgrades in
// place once it learns the server.
function toNetworkRecords(rows, server = null) {
  const out = [];
  for (const row of rows || []) {
    const key = networkKey({ server, network: row.network });
    if (!key) continue;
    out.push({
      key,
      server,
      network: row.network,
      cidr: null,
      iface: null,
      ourAddress: (row.addresses || [])[0] || null,
      addresses: row.addresses || [],
      reachableRanges: row.reachableRanges || [],
      peers: row.peers || [],
      connected: row.connected,
      // Preserved rather than assumed: these rows come from netclient or from a
      // server, and Settings says which.
      discovered: row.discovered || 'netclient',
    });
  }
  return out;
}

// One network described by two tiers, made into one record.
//
// The tiers see different halves of the same thing and key them differently:
// the interface tier knows the CIDR and the interface but not what the network
// is called, so it keys on `iface:…`; netclient knows the name and the peers but
// not which local interface carries it, so it keys on the name. Left alone they
// would sit side by side as two records for one network — and netScope, which
// resolves an inbound address through the stored CIDR, would lose the half it
// needs the moment netclient started answering.
//
// They are matched on a shared address. If netclient says this machine is
// 10.101.0.5 on `office`, and an interface record holds 10.101.0.5, they are the
// same network; nothing else needs to agree.
// Which node in a server's list is this machine.
//
// netclient answers that question itself; a server's /api/nodes does not — it
// returns every node in the network, ours among them, with nothing marking which
// is which. So it is worked out the only way that needs no guesswork: an address
// the server lists which is also an address on one of our own mesh interfaces is
// ours. Without this a server-derived network has no address to be matched on,
// reconcile cannot join it to the interface record that carries the CIDR, and
// netScope loses the half it needs to admit an inbound connection.
//
// Our own entry is then taken out of the peer list — dialling ourselves is
// refused further down anyway, but asking is still a probe nobody needed.
function locateSelf(records, ourAddresses) {
  const mine = new Set(ourAddresses || []);
  return records.map((rec) => {
    if ((rec.addresses || []).length) return rec;
    const ours = (rec.peers || []).filter((p) => mine.has(p.address)).map((p) => p.address);
    if (!ours.length) return rec;
    return {
      ...rec,
      addresses: [...new Set(ours)],
      ourAddress: ours[0],
      peers: (rec.peers || []).filter((p) => !mine.has(p.address)),
    };
  });
}

function reconcile(fromInterfaces, fromNamed) {
  const out = [];
  const claimed = new Set();
  for (const named of fromNamed) {
    const match = fromInterfaces.find(
      (iface) =>
        !claimed.has(iface.key) && (named.addresses || []).some((a) => (iface.addresses || []).includes(a))
    );
    if (match) claimed.add(match.key);
    out.push({
      ...match,
      ...named,
      // The interface half is the part netScope reads, so it survives even
      // though the named record is the one whose key wins.
      cidr: (match && match.cidr) || named.cidr || null,
      iface: (match && match.iface) || null,
      addresses: [...new Set([...(named.addresses || []), ...((match && match.addresses) || [])])],
      // Where the key came from, so the migration below knows what to rewrite.
      supersedes: match ? match.key : null,
    });
  }
  // A network we can see but netclient did not mention is still one we are on.
  for (const iface of fromInterfaces) if (!claimed.has(iface.key)) out.push(iface);
  return out;
}

// A network's key becomes more specific as tiers learn more about it, and the
// user's decision to trust it has to survive that.
//
// Only ever carried forward, never invented: a key inherits trust because the
// key it replaced had it. An untrusted network cannot become trusted this way.
function migrateKeys(records, { trusted, homeKey }) {
  const moves = records.filter((r) => r.supersedes && r.supersedes !== r.key);
  if (!moves.length) return null;
  const nextTrusted = new Set(trusted || []);
  let nextHome = homeKey;
  let changed = false;
  for (const rec of moves) {
    if (nextTrusted.has(rec.supersedes)) {
      nextTrusted.delete(rec.supersedes);
      nextTrusted.add(rec.key);
      changed = true;
    }
    if (nextHome === rec.supersedes) {
      nextHome = rec.key;
      changed = true;
    }
  }
  return changed ? { netmakerTrusted: [...nextTrusted], netmakerHomeKey: nextHome } : null;
}

function createNetmaker({
  config,
  bus,
  // The shared adopt funnel. Optional so the service can be built for its
  // network list alone — which is all netScope needs, and all tier C can give.
  adopter = null,
  // The keychain, for reading server tokens back. Absent means tier B simply
  // never runs — it is never a reason to keep a token in the clear.
  safeStorage = null,
  interfaces = () => os.networkInterfaces(),
  runList = runNetclientList,
  fetchNodes = fetchNetmakerNodes,
  now = nowMs,
} = {}) {
  let timer = null;
  let stopped = false;
  let records = [];
  let peers = [];
  let dueNetclient = 0;
  let dueApi = 0;
  let fetching = false;
  let listing = false; // single-flight: a hung CLI must not stack up calls
  let lastListError = null;
  let serverErrors = [];
  let last = { ok: true, source: null, reason: null, detail: null, networks: 0, trusted: 0 };

  // A thrown interface list narrows what we report rather than crashing the poll
  // that reads it.
  function readInterfaces() {
    try {
      return interfaces() || {};
    } catch {
      return {};
    }
  }

  function trustedKeys() {
    return new Set(config.get('netmakerTrusted') || []);
  }

  function decorate(list) {
    const trusted = trustedKeys();
    const home = homeKeyOf(list, config.get('netmakerHomeKey'));
    const clashing = new Set(overlappingKeys(list));
    return list.map((rec) => ({
      ...rec,
      home: rec.key === home,
      trusted: trusted.has(rec.key),
      overlapping: clashing.has(rec.key),
    }));
  }

  // What actually belongs on disk: the derived fields are recomputed on every
  // poll from their real sources, and writing them here would give trust two
  // homes that could disagree.
  function storable(list) {
    return list.map(({ trusted, home, overlapping, ...rest }) => rest);
  }

  // Written back only when something actually changed: config.save() rewrites
  // the whole file, and this runs every few seconds.
  //
  // `lastSeen` is excluded from the comparison rather than from the record. It
  // moves on every single poll, so comparing it would mean rewriting the entire
  // config file every five seconds for as long as the app is open — which is
  // what this guard exists to prevent. It still rides along whenever something
  // real changes; a slightly stale one on disk costs nothing, because the field
  // that decides anything (`firstSeen`) never moves.
  function persist(list) {
    const stored = config.get('netmakerNetworks') || [];
    const compare = (l) => JSON.stringify(storable(l).map(({ lastSeen, ...rest }) => rest));
    if (compare(list) === compare(stored)) return false;
    config.set({ netmakerNetworks: storable(list) });
    return true;
  }

  // Tier A, on its own slower cadence and never more than one at a time.
  async function pollNetclient() {
    if (stopped || listing || !config.get('enableNetmaker')) return null;
    if (now() < dueNetclient) return null;
    listing = true;
    try {
      return await netclientNetworks({ configured: config.get('netmakerBinaryPath'), run: runList });
    } finally {
      listing = false;
      dueNetclient = now() + NETCLIENT_INTERVAL;
    }
  }

  // A server's token, unsealed. Stored exactly as agentSpeechKeys are: sealed by
  // the OS keychain, never written to disk in the clear, and never handed to the
  // renderer — Settings is told only whether one exists.
  function tokenFor(serverId) {
    const all = config.get('netmakerApiTokens');
    const secret = all && typeof all === 'object' ? all[serverId] : null;
    if (!secret || typeof secret !== 'object') return null;
    if (secret.mode === 'env') return process.env[secret.name] || null;
    if (secret.mode !== 'sealed' || !secret.cipher || !safeStorage) return null;
    try {
      return safeStorage.decryptString(Buffer.from(secret.cipher, 'base64'));
    } catch (err) {
      console.error(`[netmaker] could not decrypt the token for ${serverId}:`, err.message);
      return null;
    }
  }

  // Tier B, per configured server, on its own slower cadence.
  //
  // Runs for every server that has a token, not only when tier A failed: a
  // second server is precisely how somebody on another tenant becomes visible,
  // and netclient can never see them.
  async function pollServers() {
    if (stopped || fetching || !config.get('enableNetmaker')) return [];
    if (now() < dueApi) return [];
    const servers = (config.get('netmakerServers') || []).filter((srv) => srv && srv.id && srv.apiUrl);
    if (!servers.length) return [];
    fetching = true;
    try {
      const out = [];
      for (const srv of servers) {
        const token = tokenFor(srv.id);
        if (!token) {
          out.push({ server: srv, __error: 'no-token' });
          continue;
        }
        const answer = await fetchNodes({ apiUrl: srv.apiUrl, token });
        if (answer.__error) out.push({ server: srv, __error: answer.__error, detail: answer.detail });
        else out.push({ server: srv, networks: parseNetmakerNodes(answer.payload) });
      }
      return out;
    } finally {
      fetching = false;
      dueApi = now() + API_INTERVAL;
    }
  }

  // Every mesh address a tier told us about, dialled through the shared funnel.
  //
  // Identical mechanics to discovery.js's tailnet arm: the probe decides only
  // where to dial, and what we worked out locally goes in as a hint that
  // presenceList() merges *underneath* the signed identity.
  function adoptPeers(list) {
    if (!adopter || !config.get('enableNetmaker')) return;
    const home = homeKeyOf(list, config.get('netmakerHomeKey'));
    const seen = [];
    for (const rec of list) {
      for (const peer of rec.peers || []) {
        if (!peer.address) continue;
        seen.push({ ...peer, key: rec.key, network: rec.network, foreign: rec.key !== home });
        adopter.adopt(peer.address, undefined, {
          source: 'netmaker',
          network: rec.network,
          networkServer: rec.server,
          networkKey: rec.key,
          foreign: rec.key !== home,
        });
      }
    }
    peers = seen;
    bus.emit('netmaker-peers', peers);
  }

  function poll() {
    if (stopped) return last;

    // Tier C always runs, even with the feature switched off: knowing which of
    // our own interfaces belong to a mesh is what lets netScope answer an
    // inbound connection, and that question is asked whether or not we are
    // looking for peers.
    const observed = networksFromInterfaces(readInterfaces());

    records = decorate(mergeNetworks(config.get('netmakerNetworks'), observed, now()));
    persist(records);

    // Tier A runs on its own cadence and lands on a later tick; the interface
    // tier has already answered by then, so a slow CLI never delays the floor.
    Promise.all([pollNetclient(), pollServers()])
      .then(([answer, serverAnswers]) => {
        if (stopped) return;
        const named = [];
        if (answer && !answer.__error) {
          lastListError = null;
          named.push(...toNetworkRecords(answer.networks));
        } else if (answer) {
          lastListError = answer;
        }
        serverErrors = [];
        for (const reply of serverAnswers || []) {
          if (reply.__error) {
            serverErrors.push({ id: reply.server.id, reason: reply.__error, detail: reply.detail || null });
            continue;
          }
          named.push(...toNetworkRecords(reply.networks, hostOf(reply.server.apiUrl)));
        }
        // A tier that named something reshapes the record list. One that named
        // nothing still has something to say — a refused token and an
        // unreachable server need different fixes and must not read alike — so
        // the status is always refreshed, whether or not the networks moved.
        if (named.length) {
          const fromInterfaces = networksFromInterfaces(readInterfaces());
          const ourAddresses = fromInterfaces.flatMap((r) => r.addresses || []);
          const observed = reconcile(fromInterfaces, locateSelf(named, ourAddresses));
          const migration = migrateKeys(observed, {
            trusted: config.get('netmakerTrusted'),
            homeKey: config.get('netmakerHomeKey'),
          });
          if (migration) config.set(migration);
          records = decorate(mergeNetworks(config.get('netmakerNetworks'), observed, now()));
          persist(records);
          adoptPeers(records);
          bus.emit('netmaker-networks', records);
        }
        // Assigned, not just emitted: status() answers synchronously from this,
        // and a listener seeing a fresher answer than the getter is a state with
        // two truths in it.
        last = report();
        bus.emit('netmaker-status', last);
      })
      .catch((err) => console.warn('[netmaker] netclient list failed:', err.message));

    last = report();
    bus.emit('netmaker-networks', records);
    bus.emit('netmaker-status', last);
    return last;
  }

  // No mesh interface is a fact, not a fault — and neither is having one without
  // netclient. Conflating "nothing to report" with "broken" is the mistake the
  // tailnet arm was written to avoid, so a reason is only reported when there is
  // genuinely nothing to show.
  function report() {
    const named = records.some((r) => r.network);
    const source = named ? 'netclient' : records.length ? 'interfaces' : null;
    let reason = records.length ? null : 'no-networks';
    let detail = null;
    if (lastListError && !named) {
      reason = lastListError.__error;
      detail = lastListError.detail || null;
    }
    return {
      ok: true,
      source,
      reason,
      detail,
      networks: records.length,
      trusted: records.filter((r) => r.trusted).length,
      peers: peers.length,
      servers: serverErrors,
    };
  }

  function start() {
    stopped = false;
    poll();
    timer = setInterval(poll, IFACE_INTERVAL);
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  function refresh() {
    poll();
  }

  // Look now rather than waiting for the next tick. Deliberately does not clear
  // `stopped`: a service that has been torn down reports what it last knew
  // rather than quietly coming back to life because something asked it a
  // question. Async because tiers A and B will be.
  async function probeOnce() {
    return poll();
  }

  return {
    start,
    stop,
    refresh,
    probeOnce,
    status: () => last,
    networks: () => records,
    peers: () => peers,
    ourAddresses: () =>
      records.flatMap((r) =>
        (r.addresses || []).map((address) => ({ address, key: r.key, network: r.network }))
      ),
  };
}

module.exports = {
  createNetmaker,
  networksFromInterfaces,
  toNetworkRecords,
  locateSelf,
  parseNetmakerNodes,
  fetchNetmakerNodes,
  hostOf,
  reconcile,
  migrateKeys,
  parseNetclientList,
  extractListJson,
  netclientNetworks,
  findNetclientBinary,
  resetNetclientBinary,
  NETCLIENT_PATHS,
  mergeNetworks,
  homeKeyOf,
  overlappingKeys,
  IFACE_INTERVAL,
};
