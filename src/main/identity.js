'use strict';

const os = require('node:os');
const { PROTO } = require('./authProto');

// Identity is the "card" a node presents to peers. There are two of them, and
// the difference is who has proved what.
//
//   buildIdentity   — the full card. It rides the authenticated `hello`, inside
//                     the signed transcript, so a peer that shows you one has
//                     proved it holds the key the card names.
//   buildPublicCard — the least a stranger needs to decide whether to open a
//                     socket to us, served unauthenticated over /lanchat/whoami.
//
// They used to be the same thing, and /lanchat/whoami handed the display name,
// avatar image, hostname, OS and app version to anything that could reach the
// port — a fingerprint of the machine, to an unauthenticated GET. Discovery
// needs an id, a port and a key; it does not need to know what you look like.

function buildIdentity(config, extra = {}) {
  return {
    id: config.get('id'),
    name: config.get('displayName') || os.hostname(),
    avatar: config.get('avatar') || null,
    hostname: os.hostname(),
    platform: process.platform, // 'darwin' | 'win32' | 'linux'
    version: require('../../package.json').version,
    servicePort: config.get('servicePort'),
    ...extra,
  };
}

// The unauthenticated card. Everything here is either already public (the port
// we listen on) or is what the handshake is about to prove anyway (the id and
// the key), so disclosing it costs nothing that connecting would not.
//
// `proto` is advertised so a peer knows before dialing whether we can complete a
// handshake at all — it is a courtesy, not a negotiation. What we accept is a
// build constant, and no wire field lowers it.
function buildPublicCard(config, deviceKey = null) {
  return {
    id: config.get('id'),
    servicePort: config.get('servicePort'),
    proto: PROTO,
    publicKey: deviceKey ? deviceKey.publicKey() : null,
  };
}

module.exports = { buildIdentity, buildPublicCard };
