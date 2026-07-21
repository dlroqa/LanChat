'use strict';

const http = require('node:http');
const dgram = require('node:dgram');
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
function parseTailnetPeers(status) {
  if (!status) return [];
  const selfIps = new Set(status.Self?.TailscaleIPs || []);
  const peers = status.Peer || {};
  const out = [];
  for (const key of Object.keys(peers)) {
    const p = peers[key];
    const ipv4 = (p.TailscaleIPs || []).find((a) => a.includes('.'));
    if (!ipv4 || selfIps.has(ipv4)) continue;
    out.push({
      hostname: p.HostName,
      dnsName: p.DNSName,
      ip: ipv4,
      os: p.OS,
      online: Boolean(p.Online),
      hasApp: false,
    });
  }
  return out;
}

function tailscaleStatus() {
  return new Promise((resolve) => {
    execFile('tailscale', ['status', '--json'], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

function createDiscovery({ config, getIdentity, hub, bus }) {
  let tailTimer = null;
  let lanTimer = null;
  let lanSock = null;
  let stopped = false;

  async function adoptPeer(ip, defaultPort) {
    const port = defaultPort || config.get('servicePort');
    const who = await probeWhoami(ip, port);
    if (!who || !who.id || who.id === getIdentity().id) return who;
    const svcPort = who.servicePort || port;
    hub.setIdentity(who.id, who);
    hub.connect(who.id, `${ip}:${svcPort}`);
    return who;
  }

  async function pollTailscale() {
    if (stopped || !config.get('enableTailscale')) return;
    const status = await tailscaleStatus();
    if (!status) return;
    const tailnet = parseTailnetPeers(status);
    const probes = [];
    for (const entry of tailnet) {
      if (entry.online) {
        probes.push(
          adoptPeer(entry.ip).then((who) => {
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

module.exports = { createDiscovery, probeWhoami, parseTailnetPeers };
