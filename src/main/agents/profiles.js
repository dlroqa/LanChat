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
// A third difference decides how the blank option is described. Over ACP,
// sending no flag does not mean "the default profile": `hermes profile use`
// writes a sticky choice that every later bare invocation follows, so blank
// means whatever Hermes is currently set to — which is why activeProfile()
// exists, and why `default` is offered as a name in its own right.
//
// Nothing here writes to the Hermes installation. It reads one directory and
// one file, both belonging to Hermes, and nothing else.

// Where Hermes keeps its own home, by Hermes' rule rather than ours.
//
// `HERMES_HOME` is not the root: it is the home of *one* profile, and pointing
// it at `~/.hermes/profiles/zima` is the supported way to run inside that
// profile. Reading `$HERMES_HOME/profiles` therefore looked for profiles inside
// a profile and found none — the picker went empty for exactly the people who
// had committed to a profile hardest. Ported from Hermes' own
// get_default_hermes_root(): inside the native root means the native root, a
// home whose parent is named `profiles` means two levels up, anything else is
// a root in its own right.
function nativeRoot() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'hermes');
  }
  return path.join(os.homedir(), '.hermes');
}

function isInside(child, parent) {
  return child === parent || child.startsWith(parent + path.sep);
}

function hermesRoot() {
  const native = path.resolve(nativeRoot());
  const home = String(process.env.HERMES_HOME || '').trim();
  if (!home) return native;
  const resolved = path.resolve(home);
  if (isInside(resolved, native)) return native;
  if (path.basename(path.dirname(resolved)) === 'profiles') {
    return path.dirname(path.dirname(resolved));
  }
  return resolved;
}

function profilesDir() {
  return path.join(hermesRoot(), 'profiles');
}

// The root profile's name. It is not a directory under `profiles/` — the root
// *is* it — which is why it is added to the list rather than found in it, and
// why a stray directory of that name is skipped rather than listed twice.
const DEFAULT_PROFILE = 'default';

// Which profile a bare `hermes acp` would actually run under.
//
// This is the fact the form was missing. `hermes profile use <name>` writes a
// sticky choice here, and every later invocation without a flag follows it — so
// "leave blank for the default profile" was not true on any machine where that
// had been used, and an agent could launch under a profile nobody chose in
// LanChat. Absent, empty or unreadable means the root profile, which is Hermes'
// own reading of the file.
function activeProfile() {
  try {
    const name = fs.readFileSync(path.join(hermesRoot(), 'active_profile'), 'utf8').trim();
    return PROFILE_ID_RE.test(name) ? name : DEFAULT_PROFILE;
  } catch {
    return DEFAULT_PROFILE;
  }
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
    return (
      fs
        .readdirSync(profilesDir(), { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        // A name Hermes would refuse is not a profile it can be asked for, and
        // `default` names the root rather than anything under `profiles/` — so a
        // directory of that name is skipped instead of offered twice. Both rules
        // are Hermes' own, from list_profiles().
        .filter((name) => name !== DEFAULT_PROFILE && PROFILE_ID_RE.test(name))
        .sort()
    );
  } catch {
    return [];
  }
}

// Hermes' own rule for a profile name, from hermes_cli/main.py. Mirrored rather
// than approximated: a name that fails this is not a name Hermes will accept.
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Hermes' reserved names, from its validate_profile_name(). `default` is on
// Hermes' list too but is accepted as the root profile's name, so it is not
// here — it is the one reserved name that is also a legal thing to ask for.
const RESERVED_PROFILES = new Set(['hermes', 'test', 'tmp', 'root', 'sudo']);

// Is the thing we are about to run actually Hermes? `--profile` is Hermes' own
// flag and means nothing to another ACP agent — passing it to `claude-code-acp`
// or `gemini` would break a working agent with an unrecognised argument.
//
// A filename is a heuristic, and a deliberately narrow one: it decides only
// whether to *offer* the feature and whether to emit the flag. A differently
// named command loses the picker, not the ability — and often does not need it,
// because `hermes profile alias` generates wrapper scripts that already select
// their own profile. The form says which of the two it is rather than accepting
// a value and dropping it; typing `--profile <name> acp` into the Arguments box
// still works either way, since those are passed through verbatim.
//
// The basename is taken on both separators rather than with path.basename,
// which splits on a backslash only when it is itself running on Windows. An
// agent record is portable — written on one machine, read on another — so
// `C:\tools\hermes.exe` has to answer the same everywhere, and this has to
// agree with the renderer's copy in lib/agentCommand.js on every input. The
// suite asserts that agreement rather than assuming it.
function isHermesCommand(command) {
  const base = String(command || '')
    .trim()
    .split(/[\\/]/)
    .pop()
    .toLowerCase();
  return base === 'hermes' || base === 'hermes.exe';
}

function discoverProfiles({ kind, baseUrl, command } = {}) {
  // An ACP agent runs here by definition, so there is no "is the server local?"
  // question to ask — only whether it is Hermes at all.
  //
  // `default` is offered here and nowhere else. Over ACP it is a real, nameable
  // choice: `--profile default` pins the root profile for this launch and
  // overrides a sticky one, which is otherwise something LanChat cannot express
  // at all — leaving the field blank follows the sticky choice rather than
  // overriding it. Over HTTP a profile is a `/p/<name>` URL prefix and there is
  // no such name to send, so the blank option stays the only way to ask a
  // server for its default.
  if (kind === 'acp') return isHermesCommand(command) ? [DEFAULT_PROFILE, ...localProfiles()] : [];
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
  // Lowercased before validating, not after, because of how Hermes fails on a
  // name it will not take. Its pre-parser tests the raw token against this same
  // regex and, when that fails, *abandons the override and leaves the flag in
  // argv* — so `-p Zima acp` reaches an argparse with no such option and dies
  // on the flag rather than on the name. Normalising the way Hermes' own
  // normalize_profile_name() does means LanChat can never produce that shape.
  //
  // It cannot widen what reaches argv: lowercasing maps into [a-z] and can
  // introduce no leading dash, no whitespace and no path separator, and the
  // regex below still has the final say.
  const name = String(profile || '')
    .trim()
    .toLowerCase();
  if (!name || !isHermesCommand(command)) return argv;
  if (!PROFILE_ID_RE.test(name)) {
    throw new Error(
      `"${name}" is not a valid Hermes profile name. Use lowercase letters, digits, dashes and underscores.`
    );
  }
  // Names Hermes keeps for itself. They pass the regex but its resolver refuses
  // them, so without this the agent saves cleanly and then fails at launch with
  // an error about a profile the user never suspected was special. `default` is
  // Hermes' deliberate exception — it names the root profile.
  if (RESERVED_PROFILES.has(name)) {
    throw new Error(`"${name}" is a name Hermes reserves. Choose another profile name.`);
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
  activeProfile,
  isLocalHost,
  isHermesCommand,
  hermesLaunchArgs,
  hermesRoot,
  profilesDir,
  DEFAULT_PROFILE,
  PROFILE_ID_RE,
  RESERVED_PROFILES,
};
