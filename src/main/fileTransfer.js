'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Sender side of file transfer. Streams a local file to a peer's
// POST /lanchat/files endpoint, emitting progress. Metadata rides in headers so
// the receiver can name/preview the file without a separate negotiation step.

// How long to wait for the far end to hand back a permit. A peer that cannot
// issue one is either not running this version or not willing, and either way
// the answer arrives quickly or not at all.
const GRANT_WAIT_MS = 10000;

function createFileSender({ hub, getIdentity, bus }) {
  // Transfers waiting on a permit, by transferId.
  const awaitingGrant = new Map();

  // The permit comes back over the same authenticated socket the offer went out
  // on, so it is picked up here rather than routed through ipc.js — nothing in
  // the app layer has an opinion about it.
  bus.on('peer-message', (msg) => {
    if (!msg || msg.type !== 'file-grant') return;
    const pending = awaitingGrant.get(msg.transferId);
    if (!pending || pending.peerId !== msg.from) return;
    awaitingGrant.delete(msg.transferId);
    pending.resolve(msg);
  });

  function requestGrant(peerId, transferId, size, name, mime) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        awaitingGrant.delete(transferId);
        reject(new Error('the other end did not accept the transfer — they may be running an older LanChat'));
      }, GRANT_WAIT_MS);
      awaitingGrant.set(transferId, {
        peerId,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
      // Announce the file first and open the connection second. The order used
      // to be the other way round, which is what made the upload independent of
      // the conversation it belonged to.
      const sent = hub.send(peerId, { type: 'file-offer', transferId, name, size, mime });
      if (!sent) {
        clearTimeout(timer);
        awaitingGrant.delete(transferId);
        reject(new Error("no open connection to this peer — try again once they're online"));
      }
    });
  }

  async function send(peerId, filePath) {
    const address = hub.addresses.get(peerId);
    if (!address) {
      throw new Error("no address known for this peer yet — try again once they're connected");
    }
    const stat = fs.statSync(filePath);
    const name = path.basename(filePath);
    const transferId = crypto.randomUUID();
    const mime = guessMime(name);

    const grant = await requestGrant(peerId, transferId, stat.size, name, mime);
    if (!grant.token) throw new Error('the other end declined the transfer');

    const { host: ip, port: parsedPort } = parseAddress(address);
    const port = parsedPort || getIdentity().servicePort;
    const me = getIdentity();

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: ip,
          port,
          path: '/lanchat/files',
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': stat.size,
            // The permit is what identifies the sender now. The two below are
            // kept because they cost nothing and a mixed-version pair reads
            // better with them, but the receiver does not trust either one.
            'x-lanchat-from': me.id,
            'x-lanchat-name': encodeURIComponent(me.name),
            'x-lanchat-grant': grant.token,
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
