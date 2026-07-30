'use strict';

const crypto = require('node:crypto');

// One-shot permits to upload a file.
//
// Chat rides an authenticated WebSocket. A file does not — it arrives as a fresh
// HTTP POST, on a new TCP connection, with nothing tying it to any session. The
// sender was read straight off an `x-lanchat-from` header, which meant one curl
// wrote a file into ~/Downloads and filed a message into any peer's conversation
// under that peer's name.
//
// The source address cannot fix this: two peers behind one NAT share it, the
// tests all share 127.0.0.1, and the address we have on file uses the port from
// the peer's own card rather than the socket's. So the upload carries a token
// instead, minted over the authenticated socket and redeemed once. The peer the
// bytes are filed under is the peer the token was issued to — never the header.
//
// The token also carries the size the sender declared when it offered, which is
// what finally puts a ceiling on an upload. There was none at all: the body was
// piped to disk unconditionally, and `x-lanchat-size` only drove a progress bar.

// Long enough for a person to accept a file, short enough that a leaked token is
// not a standing invitation.
const TTL_MS = 5 * 60 * 1000;

// Slack over the declared size, for whatever framing a transport adds. Small
// enough that "declared 2KB, sent 4GB" is still refused.
const SIZE_SLACK = 64 * 1024;

function createGrants({ now = () => Date.now() } = {}) {
  const byToken = new Map();

  function sweep() {
    const t = now();
    for (const [token, grant] of byToken) {
      if (grant.expires <= t) byToken.delete(token);
    }
  }

  // Issued to a peer we have authenticated, for a transfer it has announced.
  function issue({ peerId, transferId, maxBytes }) {
    if (!peerId || !transferId) return null;
    sweep();
    const token = crypto.randomBytes(32).toString('base64url');
    const declared = Number(maxBytes) || 0;
    byToken.set(token, {
      peerId,
      transferId,
      // A declared size of zero means the sender told us nothing useful, so the
      // cap falls back to the slack rather than to infinity.
      maxBytes: declared > 0 ? declared + SIZE_SLACK : SIZE_SLACK,
      expires: now() + TTL_MS,
    });
    return { token, transferId, maxBytes: declared };
  }

  // Redeeming consumes. A token that worked once must not work twice, or a
  // captured upload becomes a standing write permit.
  function redeem(token) {
    if (!token || typeof token !== 'string') return null;
    sweep();
    const grant = byToken.get(token);
    if (!grant) return null;
    byToken.delete(token);
    return grant;
  }

  // A peer going offline takes its outstanding permits with it.
  function revokePeer(peerId) {
    for (const [token, grant] of byToken) {
      if (grant.peerId === peerId) byToken.delete(token);
    }
  }

  return { issue, redeem, revokePeer, size: () => byToken.size, TTL_MS, SIZE_SLACK };
}

// Answer an offer with a permit.
//
// This lives beside the grants rather than in the ipc router because it is part
// of the transfer protocol, not part of the app: the router's job is to tell the
// window a file is coming, and it should not also be the thing that decides a
// peer may send one. Keeping it here also means the wiring is identical in the
// app and in the tests, instead of the tests having to imitate the router.
//
// Issued automatically for any peer that reached us, which is now a peer that
// authenticated — so nothing about sending a file to a friend changes, and a
// stranger cannot begin one at all.
function attachGrantIssuer({ hub, bus, grants }) {
  const onMessage = (msg) => {
    if (!msg || msg.type !== 'file-offer' || !msg.from) return;
    const permit = grants.issue({ peerId: msg.from, transferId: msg.transferId, maxBytes: msg.size });
    if (permit) hub.send(msg.from, { type: 'file-grant', ...permit });
  };
  bus.on('peer-message', onMessage);
  // Permits do not outlive the connection that earned them.
  const onPresence = () => {
    for (const peer of hub.presenceList()) {
      if (!peer.online) grants.revokePeer(peer.id);
    }
  };
  bus.on('presence', onPresence);
  return () => {
    bus.off('peer-message', onMessage);
    bus.off('presence', onPresence);
  };
}

module.exports = { createGrants, attachGrantIssuer, GRANT_TTL_MS: TTL_MS, SIZE_SLACK };
