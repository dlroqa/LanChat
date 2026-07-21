'use strict';

const os = require('node:os');

// Identity is the public "card" a node advertises to peers over discovery and
// the /lanchat/whoami handshake. Derived from Config plus host info.

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

module.exports = { buildIdentity };
