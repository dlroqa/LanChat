'use strict';

// Connection quality per peer, measured with real round-trips over the existing
// peer WebSocket. Feeds the connection graphs in the UI, so what is drawn is
// genuine latency rather than decorative animation.

const PING_INTERVAL = 2000;
const HISTORY = 40; // ~80s of samples
const TIMEOUT = 6000;

// Thresholds tuned for LAN / tailnet links, where anything above ~150ms is poor.
function qualityFor(rtt, loss) {
  if (rtt == null) return 'offline';
  if (loss > 0.3) return 'poor';
  if (rtt < 20) return 'excellent';
  if (rtt < 60) return 'good';
  if (rtt < 150) return 'fair';
  return 'poor';
}

function createLinkStats({ hub, bus }) {
  const peers = new Map(); // peerId -> { samples:[], pending:Map, sent, lost }
  let timer = null;

  function entry(peerId) {
    if (!peers.has(peerId)) {
      peers.set(peerId, { samples: [], pending: new Map(), sent: 0, lost: 0 });
    }
    return peers.get(peerId);
  }

  function snapshot(peerId) {
    const e = peers.get(peerId);
    if (!e) return null;
    const samples = e.samples;
    const recent = samples.slice(-10).filter((s) => s != null);
    const rtt = recent.length ? recent[recent.length - 1] : null;
    const avg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null;
    const loss = e.sent > 0 ? e.lost / e.sent : 0;
    return {
      peerId,
      rtt,
      avg: avg == null ? null : Math.round(avg),
      loss,
      samples: samples.slice(),
      quality: hub.isConnected(peerId) ? qualityFor(avg, loss) : 'offline',
      connected: hub.isConnected(peerId),
    };
  }

  function emit(peerId) {
    const s = snapshot(peerId);
    if (s) bus.emit('link-stats', s);
  }

  // Called from the message router when a control frame arrives.
  function handleMessage(msg) {
    if (!msg || !msg.from) return false;
    if (msg.type === 'ping') {
      hub.send(msg.from, { type: 'pong', t: msg.t });
      return true;
    }
    if (msg.type === 'pong') {
      const e = entry(msg.from);
      const sentAt = e.pending.get(msg.t);
      if (sentAt != null) {
        e.pending.delete(msg.t);
        const rtt = Date.now() - sentAt;
        e.samples.push(rtt);
        if (e.samples.length > HISTORY) e.samples.shift();
        emit(msg.from);
      }
      return true;
    }
    return false;
  }

  function tick() {
    const now = Date.now();
    for (const peer of hub.presenceList()) {
      if (!peer.online) continue;
      const e = entry(peer.id);

      // Anything still outstanding past the timeout counts as loss.
      for (const [t, sentAt] of e.pending) {
        if (now - sentAt > TIMEOUT) {
          e.pending.delete(t);
          e.lost += 1;
          e.samples.push(null);
          if (e.samples.length > HISTORY) e.samples.shift();
        }
      }

      const stamp = now;
      e.pending.set(stamp, now);
      e.sent += 1;
      if (!hub.send(peer.id, { type: 'ping', t: stamp })) {
        e.pending.delete(stamp);
        e.sent -= 1;
      }
    }
    // Drop stats for peers that went away.
    for (const id of peers.keys()) {
      if (!hub.isConnected(id)) emit(id);
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, PING_INTERVAL);
    tick();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, handleMessage, snapshot, all: () => [...peers.keys()].map(snapshot) };
}

module.exports = { createLinkStats, qualityFor };
