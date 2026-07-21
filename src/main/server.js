'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const { guessMime: mimeFromName } = require('./fileTransfer');

// Per-node local server. Two responsibilities:
//   1. HTTP  — /lanchat/whoami (discovery handshake) and /lanchat/files (uploads)
//   2. WS    — /lanchat/ws persistent channel for chat + WebRTC signaling
//
// It is intentionally unauthenticated beyond the tailnet/LAN boundary: reach is
// already gated by Tailscale ACLs / the local network. Peers self-identify via a
// `hello` frame carrying their id + display card.

function createServer({ config, getIdentity, hub, bus, downloadsDir }) {
  let server = null;
  let wss = null;

  // Only files we sent or received may be previewed over the local HTTP endpoint,
  // so the renderer can show inline image/video thumbnails without exposing the FS.
  const previewable = new Set();
  bus.on('file-received', (info) => info?.path && previewable.add(info.path));
  bus.on('file-sent', (p) => p && previewable.add(p));
  bus.on('allow-preview', (p) => p && previewable.add(p));
  // Custom notification sounds persist across restarts, so re-allow them.
  for (const key of ['customRingtonePath', 'customNotificationPath']) {
    const p = config.get(key);
    if (p) previewable.add(p);
  }

  function handleWhoami(res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getIdentity()));
  }

  function handleFileUpload(req, res) {
    const from = req.headers['x-lanchat-from'] || 'unknown';
    const fromName = decodeURIComponent(req.headers['x-lanchat-name'] || 'unknown');
    const transferId = req.headers['x-lanchat-transfer'] || crypto.randomUUID();
    const mime = req.headers['x-lanchat-mime'] || 'application/octet-stream';
    const rawName = decodeURIComponent(req.headers['x-lanchat-filename'] || 'file');
    const declaredSize = Number(req.headers['x-lanchat-size'] || 0);

    // Sanitize the filename and avoid collisions.
    const safeBase = path.basename(rawName).replace(/[^\w.\- ]+/g, '_') || 'file';
    fs.mkdirSync(downloadsDir, { recursive: true });
    let dest = path.join(downloadsDir, safeBase);
    let i = 1;
    while (fs.existsSync(dest)) {
      const ext = path.extname(safeBase);
      const stem = safeBase.slice(0, safeBase.length - ext.length);
      dest = path.join(downloadsDir, `${stem} (${i})${ext}`);
      i += 1;
    }

    const out = fs.createWriteStream(dest);
    let received = 0;
    req.on('data', (chunk) => {
      received += chunk.length;
      bus.emit('file-progress', { transferId, direction: 'in', from, received, total: declaredSize });
    });
    req.pipe(out);
    out.on('finish', () => {
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
      console.error('[server] file write error:', err.message);
      res.writeHead(500);
      res.end('write error');
    });
  }

  function handlePreview(url, res) {
    const p = url.searchParams.get('path');
    if (!p || !previewable.has(p) || !fs.existsSync(p)) {
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

  function onRequest(req, res) {
    // Permissive CORS so a peer's renderer can pull previews if needed.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
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
      return handlePreview(url, res);
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
    // Greet inbound peers so both directions learn each other's identity.
    ws.send(JSON.stringify({ type: 'hello', from: getIdentity().id, identity: getIdentity() }));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        peerId = msg.from;
        hub.register(peerId, ws);
        if (msg.identity) hub.setIdentity(peerId, msg.identity);
        // Their listening port comes from the identity card — the source port of
        // this socket is ephemeral and not something we can connect back to.
        const servicePort = (msg.identity && msg.identity.servicePort) || config.get('servicePort');
        if (remoteIp && servicePort) hub.setAddress(peerId, `${remoteIp}:${servicePort}`);
        bus.emit('peer-hello', { peerId, identity: msg.identity, direction: 'in' });
        return;
      }
      // Everything else is application traffic routed to the app bus.
      bus.emit('peer-message', msg);
    });

    ws.on('close', () => {
      if (peerId) hub.unregister(peerId, ws);
    });
    ws.on('error', () => {
      if (peerId) hub.unregister(peerId, ws);
    });
  }

  function start() {
    return new Promise((resolve, reject) => {
      server = http.createServer(onRequest);
      wss = new WebSocketServer({ server, path: '/lanchat/ws' });
      wss.on('connection', onWsConnection);
      server.on('error', reject);
      const port = config.get('servicePort');
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

// Node reports IPv4 connections on a dual-stack socket in IPv4-mapped IPv6 form
// ("::ffff:192.168.1.5"). Strip that back to a plain address so it can be used
// as an HTTP host and compared against addresses learned from discovery.
function normalizeIp(addr) {
  if (!addr) return null;
  const plain = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  // A bare IPv6 address must be bracketed to be usable in a host:port string.
  return plain.includes(':') ? `[${plain}]` : plain;
}

module.exports = { createServer, normalizeIp };
