'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');

// Which Hermes profile an agent runs under, for the two transports that can
// choose one — and how the choice is expressed, which is different for each.
//
// Over HTTP a profile is a `/p/<name>/` prefix on a server that can host
// several behind one port. Two things about that shape the design, and both are
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
// Over ACP neither limitation applies, and the copy differs because of it. The
// agent is a child process on *this* machine, so the local profile list is not
// a guess about somebody else's filesystem — it is authoritative. And the name
// is a launch flag rather than a URL prefix, so a wrong one fails loudly:
// `hermes --profile nosuchprofile acp` exits non-zero with "Profile
// 'nosuchprofile' does not exist". An unknown ACP profile is an error, not a
// silent fallback, and the form must not promise otherwise.
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

// Hermes' own rule for a profile name, from hermes_cli/main.py. Mirrored rather
// than approximated: a name that fails this is not a name Hermes will accept.
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Is the thing we are about to run actually Hermes? `--profile` is Hermes' own
// flag and means nothing to another ACP agent — passing it to `claude-code-acp`
// or `gemini` would break a working agent with an unrecognised argument.
//
// A filename is a heuristic, and a deliberately narrow one: it decides only
// whether to *offer* the feature and whether to emit the flag. Someone running
// Hermes through a differently-named wrapper loses the picker, not the ability
// — they can still type `--profile <name> acp` into the Arguments box, which is
// passed through verbatim.
function isHermesCommand(command) {
  const base = path.basename(String(command || '').trim()).toLowerCase();
  return base === 'hermes' || base === 'hermes.exe';
}

function discoverProfiles({ kind, baseUrl, command } = {}) {
  // An ACP agent runs here by definition, so there is no "is the server local?"
  // question to ask — only whether it is Hermes at all.
  if (kind === 'acp') return isHermesCommand(command) ? localProfiles() : [];
  if (kind !== 'http' || !isLocalHost(baseUrl)) return [];
  return localProfiles();
}

// The argv for launching a Hermes ACP agent under a chosen profile.
//
// `--profile` leads rather than trails. Hermes finds it anywhere before `--`,
// so both orders work today; putting it first is the canonical form and stays
// correct if that scan is ever narrowed to the head of argv.
//
// The validation is a security control, not input polish. This value becomes an
// argv element on a command line LanChat does not own. `shell: false` rules out
// shell injection, but not argv injection: a name beginning with `-` would be
// read as another flag, and `hermes --profile --yolo acp` is the shape that
// matters. Refusing anything outside PROFILE_ID_RE means only that character set
// can ever reach argv — no leading dash, no whitespace, no path separator.
//
// A stale profile is why this checks the command too. Editing an agent merges
// its config, so a record configured as `hermes` with a profile keeps that
// profile if the command is later changed to something else — and the flag must
// not follow it there.
function hermesLaunchArgs({ command, args, profile }) {
  const argv = Array.isArray(args) ? args.map(String) : [];
  const name = String(profile || '').trim();
  if (!name || !isHermesCommand(command)) return argv;
  if (!PROFILE_ID_RE.test(name)) {
    throw new Error(
      `"${name}" is not a valid Hermes profile name. Use lowercase letters, digits, dashes and underscores.`
    );
  }
  // `hermes` still needs its subcommand: argv of just the flag would run the
  // top-level CLI with nothing to do. When the user left Arguments blank the
  // transport would have supplied `acp`, so supply it here instead — this is
  // the one place that is adding to argv, and it has to hand back a complete
  // command line rather than half of one.
  return ['--profile', name, ...(argv.length ? argv : ['acp'])];
}

module.exports = {
  discoverProfiles,
  localProfiles,
  isLocalHost,
  isHermesCommand,
  hermesLaunchArgs,
  profilesDir,
  PROFILE_ID_RE,
};
