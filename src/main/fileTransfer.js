'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Sender side of file transfer. Streams a local file to a peer's
// POST /lanchat/files endpoint, emitting progress. Metadata rides in headers so
// the receiver can name/preview the file without a separate negotiation step.

function createFileSender({ hub, getIdentity, bus }) {
  function send(peerId, filePath) {
    return new Promise((resolve, reject) => {
      const address = hub.addresses.get(peerId);
      if (!address)
        return reject(new Error("no address known for this peer yet — try again once they're connected"));
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch (err) {
        return reject(err);
      }
      const { host: ip, port: parsedPort } = parseAddress(address);
      const port = parsedPort || getIdentity().servicePort;
      const name = path.basename(filePath);
      const transferId = crypto.randomUUID();
      const mime = guessMime(name);
      const me = getIdentity();

      const req = http.request(
        {
          host: ip,
          port,
          path: '/lanchat/files',
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': stat.size,
            'x-lanchat-from': me.id,
            'x-lanchat-name': encodeURIComponent(me.name),
            'x-lanchat-filename': encodeURIComponent(name),
            'x-lanchat-transfer': transferId,
            'x-lanchat-mime': mime,
            'x-lanchat-size': String(stat.size),
          },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            if (res.statusCode === 200) resolve({ transferId, name, size: stat.size, mime });
            else reject(new Error(`upload failed: ${res.statusCode} ${body}`));
          });
        }
      );
      req.on('error', reject);

      // Announce the incoming file over the signaling channel for a chat bubble.
      hub.send(peerId, { type: 'file-offer', transferId, name, size: stat.size, mime });

      const stream = fs.createReadStream(filePath);
      let sent = 0;
      stream.on('data', (chunk) => {
        sent += chunk.length;
        bus.emit('file-progress', {
          transferId,
          direction: 'out',
          to: peerId,
          received: sent,
          total: stat.size,
        });
      });
      stream.on('error', reject);
      stream.pipe(req);
    });
  }

  return { send };
}

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  // Audio-only WebM/MP4. Distinct extensions matter: a ".webm" voice note would
  // be typed video/webm and render as a video player with a black rectangle.
  '.weba': 'audio/webm',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.zip': 'application/zip',
};

function guessMime(name) {
  return MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

// Splits an "ip:port" address. Handles bracketed IPv6 ("[::1]:47100"), where a
// naive split on ':' would take the first hextet as the host.
function parseAddress(address) {
  const str = String(address || '');
  if (str.startsWith('[')) {
    const end = str.indexOf(']');
    return { host: str.slice(1, end), port: Number(str.slice(end + 2)) || null };
  }
  const idx = str.lastIndexOf(':');
  if (idx === -1) return { host: str, port: null };
  return { host: str.slice(0, idx), port: Number(str.slice(idx + 1)) || null };
}

module.exports = { createFileSender, guessMime, parseAddress };
