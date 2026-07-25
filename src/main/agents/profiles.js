'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');

// Which Hermes profiles an HTTP agent can be pointed at.
//
// A Hermes API server can host several profiles behind one port, selected with a
// `/p/<name>/` prefix. Two things about that shape the design here, and both are
// limitations of the server rather than choices:
//
//   * There is no endpoint that lists profiles. `/v1/capabilities` reports the
//     same thing under every prefix, so the names cannot be asked for — they are
//     read from the Hermes install on this machine instead.
//   * An unrecognised prefix is not an error. The server silently serves the
//     default profile, so a name cannot be validated by probing either: a
//     made-up one answers exactly like a real one. That is why the UI says a
//     name it does not recognise falls back to the default, rather than claiming
//     to have checked.
//
// Because the names come from this machine, they are only meaningful when the
// agent's server is also on this machine. Pointed anywhere else, the list would
// be a guess about somebody else's filesystem, so none is offered.
//
// Nothing here writes to the Hermes installation; it only reads a directory.

function profilesDir() {
  const home = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
  return path.join(home, 'profiles');
}

function isLocalHost(baseUrl) {
  try {
    const { hostname } = new URL(String(baseUrl));
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

// Profile directories belonging to the Hermes install on this machine. Hidden
// entries and loose files are skipped; an unreadable or missing directory simply
// yields nothing, and the form falls back to a typed name.
function localProfiles() {
  try {
    return fs
      .readdirSync(profilesDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function discoverProfiles({ kind, baseUrl } = {}) {
  if (kind !== 'http' || !isLocalHost(baseUrl)) return [];
  return localProfiles();
}

module.exports = { discoverProfiles, localProfiles, isLocalHost, profilesDir };
