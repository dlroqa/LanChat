'use strict';

const http = require('node:http');
const dgram = require('node:dgram');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

// Discovery feeds the PeerHub with reachable LanChat nodes via two paths:
//   1. Tailscale — `tailscale status --json` lists tailnet peers + IPs; we probe
//      each for the /lanchat/whoami handshake to see who is actually running it.
//   2. LAN — a UDP broadcast beacon finds same-subnet peers not on Tailscale.
// A manual peer list ("ip:port") covers locked-down networks and local testing.

const TAILSCALE_INTERVAL = 5000;
const LAN_INTERVAL = 3000;
const PROBE_TIMEOUT = 2500;

function probeWhoami(ip, port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: ip, port, path: '/lanchat/whoami', timeout: PROBE_TIMEOUT },
      (res) => {
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
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

// Pure parse of `tailscale status --json` into a peer list. Exported for tests.
//
// Devices shared in from another tailnet (Tailscale device sharing) show up as
// ordinary peers with a 100.x address, but keep their OWNER's MagicDNS suffix —
// that is the documented way to tell them apart. We flag them so the UI can say
// so, because shared devices are quarantined by default: they can answer
// connections we open, but cannot open connections back to us.
function parseTailnetPeers(status) {
  if (!status) return [];
  const selfIps = new Set(status.Self?.TailscaleIPs || []);
  const suffix = status.CurrentTailnet?.MagicDNSSuffix || '';
  const peers = status.Peer || {};
  const out = [];
  for (const key of Object.keys(peers)) {
    const p = peers[key];
    const ipv4 = (p.TailscaleIPs || []).find((a) => a.includes('.'));
    if (!ipv4 || selfIps.has(ipv4)) continue;
    const dnsName = p.DNSName || '';
    out.push({
      hostname: p.HostName,
      dnsName,
      ip: ipv4,
      os: p.OS,
      online: Boolean(p.Online),
      // Only claim "shared" when we have a suffix to compare against.
      shared: Boolean(suffix && dnsName && !dnsName.includes(suffix)),
      hasApp: false,
    });
  }
  return out;
}

// Where the Tailscale CLI actually lives, per platform.
//
// This matters more than it looks: a GUI-launched app does NOT inherit the
// shell's PATH. On macOS a bundled LanChat sees roughly
// /usr/bin:/bin:/usr/sbin:/sbin, which contains none of the paths Tailscale
// installs to — so a bare execFile('tailscale') fails with ENOENT and tailnet
// discovery silently never returns a single peer. Probing known locations is
// what makes discovery work outside a terminal.
const TAILSCALE_PATHS = {
  darwin: [
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale', // Mac App Store build
    '/usr/local/bin/tailscale', // standalone pkg / Homebrew (Intel)
    '/opt/homebrew/bin/tailscale', // Homebrew (Apple Silicon)
  ],
  linux: ['/usr/bin/tailscale', '/usr/local/bin/tailscale'],
  win32: ['C:\\Program Files\\Tailscale\\tailscale.exe', 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe'],
};

let cachedBinary; // undefined = not looked up yet, null = genuinely not found

function findTailscaleBinary() {
  if (cachedBinary !== undefined) return cachedBinary;
  for (const candidate of TAILSCALE_PATHS[process.platform] || []) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      cachedBinary = candidate;
      return cachedBinary;
    } catch {
      // Not installed at this location — try the next.
    }
  }
  // Fall back to PATH: correct when launched from a terminal, and the only
  // option for installs in a location we do not know about.
  cachedBinary = 'tailscale';
  return cachedBinary;
}

// Exposed so a failed lookup can be re-tried after the user installs Tailscale
// without restarting the app.
function resetTailscaleBinary() {
  cachedBinary = undefined;
}

function tailscaleStatus() {
  return new Promise((resolve) => {
    execFile(findTailscaleBinary(), ['status', '--json'], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        // ENOENT means we never found the CLI at all; anything else (not logged
        // in, daemon down) is a real Tailscale state worth surfacing separately.
        resolve({ __error: err.code === 'ENOENT' ? 'not-installed' : 'unavailable' });
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ __error: 'unavailable' });
      }
    });
  });
}

function createDiscovery({ config, getIdentity, hub, bus }) {
  let tailTimer = null;
  let lanTimer = null;
  let lanSock = null;
  let stopped = false;

  // `extra` carries facts we know locally (e.g. the peer is shared in from
  // another tailnet) which the peer itself cannot tell us about.
  async function adoptPeer(ip, defaultPort, extra = {}) {
    const port = defaultPort || config.get('servicePort');
    const who = await probeWhoami(ip, port);
    if (!who || !who.id || who.id === getIdentity().id) return who;
    const svcPort = who.servicePort || port;
    hub.setIdentity(who.id, { ...who, ...extra });
    hub.connect(who.id, `${ip}:${svcPort}`);
    return who;
  }

  async function pollTailscale() {
    if (stopped || !config.get('enableTailscale')) return;
    const status = await tailscaleStatus();
    if (!status || status.__error) {
      // Surface *why* the tailnet list is empty instead of showing nothing at
      // all — "not installed" and "installed but signed out" need different fixes.
      if (status && status.__error === 'not-installed') resetTailscaleBinary();
      bus.emit('tailnet-status', { ok: false, reason: (status && status.__error) || 'unavailable' });
      bus.emit('tailnet-peers', []);
      return;
    }
    bus.emit('tailnet-status', { ok: true, reason: null });
    const tailnet = parseTailnetPeers(status);
    const probes = [];
    for (const entry of tailnet) {
      if (entry.online) {
        probes.push(
          adoptPeer(entry.ip, undefined, { shared: entry.shared, tailnetName: entry.dnsName }).then((who) => {
            if (who && who.id) entry.hasApp = true;
          })
        );
      }
    }
    await Promise.allSettled(probes);
    bus.emit('tailnet-peers', tailnet);
  }

  function startLan() {
    if (!config.get('enableLan')) return;
    const port = config.get('discoveryPort');
    lanSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    lanSock.on('error', (err) => {
      console.error('[discovery] LAN socket error:', err.message);
      try {
        lanSock.close();
      } catch {}
      lanSock = null;
    });
    lanSock.on('message', (raw, rinfo) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type !== 'lanchat-beacon' || !msg.id || msg.id === getIdentity().id) return;
      adoptPeer(rinfo.address, msg.servicePort);
    });
    lanSock.bind(port, () => {
      try {
        lanSock.setBroadcast(true);
      } catch {}
    });

    const beacon = () => {
      if (stopped || !lanSock) return;
      const id = getIdentity();
      const payload = Buffer.from(
        JSON.stringify({ type: 'lanchat-beacon', id: id.id, name: id.name, servicePort: id.servicePort })
      );
      try {
        lanSock.send(payload, 0, payload.length, port, '255.255.255.255');
      } catch {}
    };
    lanTimer = setInterval(beacon, LAN_INTERVAL);
    beacon();
  }

  function pollManual() {
    for (const entry of config.get('manualPeers') || []) {
      const [ip, portStr] = String(entry).split(':');
      if (ip) adoptPeer(ip.trim(), Number(portStr) || undefined);
    }
  }

  function start() {
    stopped = false;
    pollTailscale();
    tailTimer = setInterval(pollTailscale, TAILSCALE_INTERVAL);
    startLan();
    pollManual();
    // Re-poll manual peers periodically for reconnects.
    setInterval(pollManual, TAILSCALE_INTERVAL);
  }

  function refresh() {
    pollTailscale();
    pollManual();
  }

  function stop() {
    stopped = true;
    if (tailTimer) clearInterval(tailTimer);
    if (lanTimer) clearInterval(lanTimer);
    if (lanSock)
      try {
        lanSock.close();
      } catch {}
  }

  return { start, stop, refresh, probeWhoami };
}

module.exports = { createDiscovery, probeWhoami, parseTailnetPeers, findTailscaleBinary, TAILSCALE_PATHS };
