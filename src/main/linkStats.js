'use strict';

// Connection quality per peer, measured with real round-trips over the existing
// peer WebSocket. Feeds the connection graphs in the UI, so what is drawn is
// genuine latency rather than decorative animation.
//
// ---------------------------------------------------------------------------
// Windows measures differently, and only Windows.
//
// On macOS and Linux this has always worked, so those platforms keep the code
// they have been running: an application `ping` frame, a sample recorded when
// the matching `pong` comes back, and a lifetime loss ratio. Not one line of
// that path changes shape here.
//
// On Windows the panel showed nothing at all — no latency, no average, no loss,
// on links that were plainly carrying files and presence. Two things caused it,
// and both are fixed for that platform alone:
//
//   1. The round trip was an application message, so it only came back if every
//      gate on the far side let it through. The Windows path uses the WebSocket
//      protocol ping instead (RFC 6455 control frame), which the `ws` library on
//      the peer answers by itself before a single line of LanChat code runs. It
//      needs nothing of the peer's version or routing.
//   2. Stats were published only when an answer arrived, so a link answering
//      nothing emitted nothing, and the panel sat on "measuring…" indefinitely
//      with no way to tell that apart from a link still warming up. The Windows
//      path publishes what it knows on every tick.
//
// A peer's own application ping is answered on every platform, so nothing about
// how others measure *us* changes.
// ---------------------------------------------------------------------------

const PING_INTERVAL = 2000;
const HISTORY = 40; // ~80s of samples
const TIMEOUT = 6000;
// Windows only: latency, average and loss are reported over the same recent
// window, so the three figures in the panel describe the same stretch of time.
const RECENT = 10;

// Thresholds tuned for LAN / tailnet links, where anything above ~150ms is poor.
function qualityFor(rtt, loss) {
  if (rtt == null) return 'offline';
  if (loss > 0.3) return 'poor';
  if (rtt < 20) return 'excellent';
  if (rtt < 60) return 'good';
  if (rtt < 150) return 'fair';
  return 'poor';
}

// `windows` is a parameter rather than a bare platform check so both paths can
// be exercised on one machine — the point of confining a fix to a platform is
// lost if the confinement itself is untested.
function createLinkStats({ hub, bus, windows = process.platform === 'win32' }) {
  const peers = new Map(); // peerId -> { samples:[], pending:Map, sent, lost }
  // Windows: sockets already listening for protocol pongs. A WeakSet so a closed
  // socket is collected along with its listener rather than tracked forever.
  const wired = new WeakSet();
  let timer = null;

  function entry(peerId) {
    if (!peers.has(peerId)) {
      peers.set(peerId, { samples: [], pending: new Map(), sent: 0, lost: 0 });
    }
    return peers.get(peerId);
  }

  function record(e, rtt) {
    e.samples.push(rtt);
    if (e.samples.length > HISTORY) e.samples.shift();
  }

  function snapshot(peerId) {
    const e = peers.get(peerId);
    if (!e) return null;
    const samples = e.samples;
    const connected = hub.isConnected(peerId);

    if (!windows) {
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
        quality: connected ? qualityFor(avg, loss) : 'offline',
        connected,
      };
    }

    // A dropped ping is a null in the same series, so loss is simply how much of
    // the recent window went unanswered — no separate counter to drift out of
    // step with the graph, and no lifetime total that a single bad minute stains
    // forever.
    const recent = samples.slice(-RECENT);
    const answered = recent.filter((s) => s != null);
    const rtt = answered.length ? answered[answered.length - 1] : null;
    const avg = answered.length ? Math.round(answered.reduce((a, b) => a + b, 0) / answered.length) : null;
    const loss = recent.length ? (recent.length - answered.length) / recent.length : 0;
    // Three states share "no number to show", and telling them apart is the
    // difference between a panel that explains itself and one that just sits
    // there: nobody there, nothing measured yet, and a socket that is open but
    // answering nothing.
    let quality;
    if (!connected) quality = 'offline';
    else if (avg != null) quality = qualityFor(avg, loss);
    else if (recent.length === 0) quality = 'measuring';
    else quality = 'unreachable';
    return { peerId, rtt, avg, loss, samples: samples.slice(), quality, connected };
  }

  function emit(peerId) {
    const s = snapshot(peerId);
    if (s) bus.emit('link-stats', s);
  }

  // A round trip came back, however it was measured.
  function complete(peerId, stamp) {
    const e = entry(peerId);
    let sentAt = e.pending.get(stamp);
    if (sentAt != null) {
      e.pending.delete(stamp);
    } else if (windows && !Number.isFinite(stamp) && e.pending.size > 0) {
      // The spec says a pong echoes the ping's payload, but a stripped or empty
      // one must not read as total loss on a link that is plainly answering.
      // Control frames come back in order, so the oldest outstanding is the one
      // this answers.
      const [oldest] = e.pending.keys();
      sentAt = e.pending.get(oldest);
      e.pending.delete(oldest);
    } else {
      return; // a late answer to a ping already written off, or not ours
    }
    record(e, Date.now() - sentAt);
    emit(peerId);
  }

  // Windows: listen once per socket for the library-level answer.
  function wire(peerId, ws) {
    if (wired.has(ws)) return;
    wired.add(ws);
    ws.on('pong', (data) => {
      // An empty echo carries no stamp — `Number('')` is 0, which would match
      // nothing and quietly read as loss, so it is passed on as unknown.
      const text = String(data == null ? '' : data).trim();
      complete(peerId, text === '' ? NaN : Number(text));
    });
  }

  // Windows prefers the protocol ping, falling back to the application frame for
  // a socket that cannot carry one (an agent's virtual socket). Everywhere else
  // this is the application frame and nothing but, exactly as before.
  function probe(peerId, stamp) {
    if (windows) {
      const ws = hub.openSocket ? hub.openSocket(peerId) : null;
      if (ws && typeof ws.ping === 'function' && typeof ws.on === 'function') {
        try {
          wire(peerId, ws);
          ws.ping(String(stamp));
          return true;
        } catch {
          // Socket went away mid-tick — fall through and try the app frame.
        }
      }
    }
    return hub.send(peerId, { type: 'ping', t: stamp });
  }

  // Called from the message router when a control frame arrives.
  function handleMessage(msg) {
    if (!msg || !msg.from) return false;
    if (msg.type === 'ping') {
      hub.send(msg.from, { type: 'pong', t: msg.t });
      return true;
    }
    if (msg.type === 'pong') {
      complete(msg.from, msg.t);
      return true;
    }
    return false;
  }

  function tick() {
    const now = Date.now();
    for (const peer of hub.presenceList()) {
      if (!peer.online) continue;
      // Agents ride a virtual socket that only carries chat, so a ping to one is
      // never answered and every sample counts as loss — which then renders as
      // "Offline, 100% loss" for an agent that is working perfectly. There is no
      // network path to measure here, so there is nothing to measure.
      if (peer.kind === 'agent') continue;
      const e = entry(peer.id);

      // Anything still outstanding past the timeout counts as loss.
      for (const [t, sentAt] of e.pending) {
        if (now - sentAt > TIMEOUT) {
          e.pending.delete(t);
          e.lost += 1;
          record(e, null);
        }
      }

      const stamp = now;
      e.pending.set(stamp, now);
      e.sent += 1;
      if (!probe(peer.id, stamp)) {
        e.pending.delete(stamp);
        e.sent -= 1;
      }
    }

    if (!windows) {
      // Drop stats for peers that went away.
      for (const id of peers.keys()) {
        if (!hub.isConnected(id)) emit(id);
      }
      return;
    }

    // Windows publishes every tick rather than only when an answer arrives. A
    // link that is answering nothing is exactly the case worth showing, and
    // emitting on success alone was what left the panel blank.
    for (const [id, e] of peers) {
      // A peer that dropped takes its outstanding pings with it. They were never
      // going to be answered, so writing them off as loss would greet them on
      // reconnect with a figure the link never earned.
      if (!hub.isConnected(id)) e.pending.clear();
      emit(id);
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
