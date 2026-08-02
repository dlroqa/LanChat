'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { guessMime: mimeFromName } = require('./fileTransfer');
const { isLoopback: isLoopbackAddress } = require('./netScope');
const { buildPublicCard } = require('./identity');
const {
  createHandshake,
  applyPinVerdict,
  refusalForWire,
  WIRE_REASON,
  WIRE_CLOSE_CODE,
  TIMED_OUT,
} = require('./handshake');

// How long a socket may sit without completing a handshake. Generous enough for
// a slow link, short enough that an unanswered dial does not wedge a peer.
const AUTH_TIMEOUT_MS = 8000;

// Per-node local server. Two responsibilities:
//   1. HTTP  — /lanchat/whoami (discovery handshake) and /lanchat/files (uploads)
//   2. WS    — /lanchat/ws persistent channel for chat + WebRTC signaling
//
// Reach is scoped by netScope: which of our own interfaces a connection landed
// on decides whether it is entertained at all. Identity on top of that is proven
// per-connection — peers no longer merely assert who they are.

// `windows` is a parameter rather than a bare platform check so both paths can
// be exercised on one machine — the point of confining a fix to a platform is
// lost if the confinement itself is untested. `netScope` is a parameter for the
// same reason: a machine either is or is not on a tailnet, and both branches of
// that have to be testable from wherever the suite happens to run.
function createServer({
  config,
  getIdentity,
  getPublicCard = null,
  deviceKey,
  pins,
  grants = null,
  hub,
  bus,
  downloadsDir,
  store,
  netScope = null,
  windows = process.platform === 'win32',
}) {
  let server = null;
  let wss = null;

  // Only files we sent or received may be previewed over the local HTTP endpoint,
  // so the renderer can show inline image/video thumbnails without exposing the FS.
  //
  // Windows names the same file more than one way — drive letter and folder
  // names differ in case between what a file dialog hands back and what a peer's
  // transfer header carried, and separators can arrive either way round — while
  // the filesystem treats them all as one file. Comparing the raw strings meant a
  // path the app had itself just allowed could still miss, so the key is
  // normalised there: nothing is served that was not allowed, it is simply
  // recognised however it is spelled. Elsewhere the string is the key, as it has
  // always been.
  const previewable = new Set();
  const previewKey = (p) => (windows ? path.normalize(String(p)).toLowerCase() : String(p));
  const allowPreview = (p) => p && previewable.add(previewKey(p));
  bus.on('file-received', (info) => allowPreview(info?.path));
  bus.on('file-sent', (p) => allowPreview(p));
  bus.on('allow-preview', (p) => allowPreview(p));
  // Custom notification sounds persist across restarts, so re-allow them. Keep
  // in step with SOUND_KINDS in ipc.js, which is what writes these keys.
  for (const key of ['customRingtonePath', 'customNotificationPath', 'customAgentMusicPath']) {
    allowPreview(config.get(key));
  }
  // Windows only: so do the files already in a conversation. The allowlist was
  // rebuilt from live events alone, so it held whatever had been sent or
  // received since launch and nothing else — every photo already in a thread
  // came back 404 on the next start and drew as a broken thumbnail. Reading the
  // paths back off disk does not widen what may be read: the same files, still
  // named explicitly, still nothing else on the machine.
  if (windows && store && typeof store.filePaths === 'function') {
    for (const p of store.filePaths()) allowPreview(p);
  }
  // Every platform: so do the pictures an agent made and the ones a message
  // named. Those were never in the allowlist to begin with — nothing sent them
  // and nothing received them — so unlike the loop above this is not a rebuild
  // confined to one platform, it is the only way a picture already in a thread
  // survives a restart anywhere. Still nothing wider: main wrote these paths
  // down only after checking each one (see media.js).
  if (store && typeof store.mediaPaths === 'function') {
    for (const p of store.mediaPaths()) allowPreview(p);
  }

  // The least a stranger needs in order to decide whether to dial us: an id, a
  // port, the protocol we speak and the key we will prove we hold. It used to
  // return the whole card — display name, avatar image, hostname, OS, app
  // version — to any unauthenticated GET that could reach the port, which is a
  // fingerprint of the machine handed out for free. The rest now rides the
  // authenticated hello, where it is signed for.
  function handleWhoami(res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getPublicCard ? getPublicCard() : buildPublicCard(config)));
  }

  function handleFileUpload(req, res) {
    // The permit decides everything about who this is. `x-lanchat-from` is still
    // sent for older receivers but is no longer read: it was the whole
    // vulnerability, since a fresh TCP connection carries no proof of anything
    // and the header could name any peer at all.
    const grant = grants ? grants.redeem(req.headers['x-lanchat-grant']) : null;
    if (!grant) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no valid transfer grant' }));
      req.resume(); // drain, so the sender gets the status rather than a reset
      return;
    }
    const from = grant.peerId;
    const fromName = (hub.identities.get(from) || {}).name || 'unknown';
    const transferId = grant.transferId;
    const mime = req.headers['x-lanchat-mime'] || 'application/octet-stream';
    const rawName = decodeURIComponent(req.headers['x-lanchat-filename'] || 'file');
    const declaredSize = Number(req.headers['x-lanchat-size'] || 0);

    const dest = uniqueDest(downloadsDir, rawName);

    const out = fs.createWriteStream(dest);
    let received = 0;
    let aborted = false;

    // The ceiling the grant carries. Without it an authenticated peer could
    // still fill the disk — the body used to be piped through unconditionally
    // and the declared size only drove a progress bar.
    const overrun = () => {
      aborted = true;
      req.destroy();
      out.destroy();
      fs.rm(dest, { force: true }, () => {});
      bus.emit('file-refused', { transferId, from, reason: 'larger than it said it was' });
      if (!res.headersSent) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'file larger than the transfer offered' }));
      }
    };

    req.on('data', (chunk) => {
      if (aborted) return;
      received += chunk.length;
      if (received > grant.maxBytes) return overrun();
      bus.emit('file-progress', { transferId, direction: 'in', from, received, total: declaredSize });
    });
    req.pipe(out);
    out.on('finish', () => {
      if (aborted) return;
      bus.emit('file-received', {
        transferId,
        from,
        fromName,
        mime,
        name: path.basename(dest),
        path: dest,
        size: received,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, transferId, size: received }));
    });
    out.on('error', (err) => {
      if (aborted) return;
      console.error('[server] file write error:', err.message);
      res.writeHead(500);
      res.end('write error');
    });
  }

  // Inline thumbnails for our own renderer, and nobody else's. The only caller
  // is this window fetching http://localhost — no peer has ever used it — so the
  // endpoint is bound to loopback rather than scoped per peer, which would mean
  // inventing a peer-facing API that nothing asks for and still leaving it open
  // on every interface.
  //
  // It mattered: `previewable` is seeded on Windows from every file ever
  // exchanged with anyone (see the loop above), so a single peer could read back
  // files a different peer had sent. Loopback closes that without needing to
  // know which peer asked.
  function handlePreview(url, req, res) {
    if (!isLocalRequest(req)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const p = url.searchParams.get('path');
    if (!p || !previewable.has(previewKey(p)) || !fs.existsSync(p)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const stat = fs.statSync(p);
    res.writeHead(200, {
      'Content-Type': mimeFromName(p),
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(p).pipe(res);
  }

  // Whether a request came from this machine. Asked of the address the socket
  // landed on, not the one it claims to come from.
  function isLocalRequest(req) {
    const local = req && req.socket && req.socket.localAddress;
    return netScope ? netScope.isLoopback(local) : isLoopbackAddress(local);
  }

  function onRequest(req, res) {
    // CORS is for the renderer reaching its own endpoints over localhost. It used
    // to be `*` on every path, with a comment about a peer's renderer pulling
    // previews — a use that does not exist, and a header that told every browser
    // on the network it was welcome to read the responses.
    if (isLocalRequest(req)) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/lanchat/whoami') {
      return handleWhoami(res);
    }
    if (req.method === 'POST' && url.pathname === '/lanchat/files') {
      return handleFileUpload(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/lanchat/preview') {
      return handlePreview(url, req, res);
    }
    res.writeHead(404);
    res.end('not found');
  }

  function onWsConnection(ws, req) {
    let peerId = null;
    // The address a peer dialed in from. Chat rides the socket, but file
    // transfer opens a fresh HTTP connection and needs somewhere to send it —
    // without this, a peer who dialed us first has no recorded address and
    // sending them a file fails with "peer address unknown".
    const remoteIp = normalizeIp(req && req.socket && req.socket.remoteAddress);

    // We speak first, and the nonce rides that frame — which is why the
    // handshake costs no extra round trip. It was already the shape of the
    // protocol; it just carried nothing worth having.
    const shake = createHandshake({ role: 'server', deviceKey, getIdentity });
    ws.send(JSON.stringify(shake.helloFrame()));

    // A socket that opens and then says nothing holds a slot and, on the dialing
    // side, holds the peer in `dialing` where it can never be retried. Both ends
    // put a clock on it.
    let authTimer = setTimeout(() => refuse(TIMED_OUT), AUTH_TIMEOUT_MS);
    const clearAuthTimer = () => {
      if (authTimer) clearTimeout(authTimer);
      authTimer = null;
    };

    function refuse(reason) {
      clearAuthTimer();
      // The wire hears one word. The specific reason goes to the window, where
      // an attacker cannot read it — which is what makes it safe for the roster
      // to say something as helpful as "ask them to update".
      try {
        ws.send(JSON.stringify(refusalForWire()));
      } catch {
        /* the socket may already be gone */
      }
      bus.emit('peer-auth-failed', { reason, address: remoteIp, direction: 'in' });
      try {
        ws.close(WIRE_CLOSE_CODE, WIRE_REASON);
      } catch {
        /* already closing */
      }
    }

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'hello') {
        if (peerId) return; // one handshake per socket
        const result = shake.acceptClientHello(msg);
        if (!result.ok) return refuse(result.reason);

        const verdict = applyPinVerdict({ pins, hub, claim: result.peer });
        if (!verdict.ok) {
          bus.emit('peer-key-alarm', {
            peerId: result.peer.id,
            reason: verdict.reason,
            offered: result.peer.key,
            known: (pins.get(result.peer.id) || {}).key || null,
          });
          return refuse(verdict.reason);
        }

        // Only now, with the proof checked and the key agreed, does this socket
        // acquire an identity. This single assignment is what used to be
        // `peerId = msg.from` — a peer's unsupported word.
        clearAuthTimer();
        peerId = result.peer.id;
        // The proof goes out before anything else, and that order is
        // load-bearing rather than tidy.
        //
        // The two ends of a three-frame handshake cannot finish at the same
        // moment: we are satisfied here, one frame before the dialer is. Between
        // those two points we consider the peer connected and it does not, so
        // anything we send in reaction to `peer-hello` below — the agent
        // adverts, most of all — would arrive at a socket that is still dropping
        // frames, and be lost silently.
        //
        // Sending the proof first closes that window, because a TCP stream is
        // ordered: whatever `peer-hello` triggers is queued behind the frame
        // that authorises it. Move this line after the emit and the adverts go
        // missing on exactly the fast connections nobody tests on.
        ws.send(JSON.stringify(shake.serverProof()));
        hub.register(peerId, ws, { publicKey: result.peer.key });
        hub.setIdentity(peerId, result.peer.identity);
        // Their listening port comes from the identity card — the source port of
        // this socket is ephemeral and not something we can connect back to.
        const servicePort = result.peer.identity.servicePort || config.get('servicePort');
        if (remoteIp && servicePort) hub.setAddress(peerId, `${remoteIp}:${servicePort}`);
        bus.emit('peer-hello', {
          peerId,
          identity: result.peer.identity,
          direction: 'in',
          firstUse: verdict.firstUse,
        });
        return;
      }

      // Everything else is application traffic routed to the app bus. `from` is
      // re-stamped from the socket's own handshake rather than trusted from the
      // payload, so a peer cannot attribute traffic to somebody else. A frame
      // arriving before the handshake completes has no established sender and is
      // dropped — and now "established" means proved rather than asserted.
      if (!peerId) return;
      bus.emit('peer-message', { ...msg, from: peerId });
    });

    ws.on('close', () => {
      clearAuthTimer();
      if (peerId) hub.unregister(peerId, ws);
    });
    ws.on('error', () => {
      clearAuthTimer();
      if (peerId) hub.unregister(peerId, ws);
    });
  }

  // Which of our interfaces the connection arrived on. Asked before anything
  // else happens, because the cheapest refusal is the one that never allocates.
  function inScope(socket) {
    if (!netScope) return true;
    return netScope.allowInbound(socket && socket.localAddress, socket && socket.remoteAddress);
  }

  function start() {
    return new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        if (!inScope(req.socket)) {
          // Nothing about why. A scanner on the wrong network learns only that
          // there is something here, which it already knew from the open port.
          res.writeHead(404);
          res.end('not found');
          req.socket.destroy();
          return;
        }
        onRequest(req, res);
      });
      wss = new WebSocketServer({ noServer: true });
      wss.on('connection', onWsConnection);

      // Handled here rather than inside onWsConnection: the upgrade has to be
      // refused before it completes, or /lanchat/files and /lanchat/whoami are
      // reachable on a network we have already decided not to accept.
      server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname !== '/lanchat/ws' || !inScope(socket)) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      });

      server.on('error', reject);
      const port = config.get('servicePort');
      // Still bound to every interface: which networks are *accepted* is decided
      // per connection, above, so that turning LAN accept on or off takes effect
      // immediately rather than needing the listener torn down and rebuilt while
      // sockets are live.
      server.listen(port, '0.0.0.0', () => {
        console.log(`[server] listening on 0.0.0.0:${port}`);
        resolve(port);
      });
    });
  }

  function stop() {
    if (wss) wss.close();
    if (server) server.close();
  }

  return { start, stop };
}

// Where a file arriving from outside is written: inside the downloads folder,
// under a name that cannot climb out of it and cannot overwrite what is already
// there. `basename` is what stops "../../.bashrc" from being a filename, and the
// numbered suffix is what stops the second photo called "graph.png" from
// erasing the first.
//
// Shared with saveImage in ipc.js: a picture fetched from the web lands in the
// same folder, under the same rules, as one a peer sent.
function uniqueDest(dir, rawName) {
  // Trimmed before the fallback, so a name that is nothing but spaces takes it
  // too. A file really can be called "  " on most filesystems, and one that is
  // invisible in every listing is worse than one plainly called `file`.
  const named = path.basename(String(rawName || ''));
  const safeBase = named.replace(/[^\w.\- ]+/g, '_').trim() || 'file';
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(safeBase);
  const stem = safeBase.slice(0, safeBase.length - ext.length);
  let dest = path.join(dir, safeBase);
  let i = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(dir, `${stem} (${i})${ext}`);
    i += 1;
  }
  return dest;
}

// Node reports IPv4 connections on a dual-stack socket in IPv4-mapped IPv6 form
// ("::ffff:192.168.1.5"). Strip that back to a plain address so it can be used
// as an HTTP host and compared against addresses learned from discovery.
function normalizeIp(addr) {
  if (!addr) return null;
  const plain = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  // A bare IPv6 address must be bracketed to be usable in a host:port string.
  return plain.includes(':') ? `[${plain}]` : plain;
}

module.exports = { createServer, normalizeIp, uniqueDest };
