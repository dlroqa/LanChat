'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Finding the agent's executable when the app was not launched from a shell.
//
// A GUI-launched Electron process inherits the desktop session's environment,
// not the one a terminal would give it. On macOS and Linux that routinely means
// no `~/.local/bin`, no Homebrew prefix, no version-manager shims — because
// those are added by `~/.profile` or `~/.zshrc`, which only a login or
// interactive shell ever reads. So a user who installs `hermes` and types
// `hermes` into the form gets ENOENT from an app that is looking at a shorter
// PATH than the one they installed it onto.
//
// Resolution here is strictly a *fallback*: if the normal PATH lookup would
// succeed, this returns the name untouched and spawn does what it always did.
// Nothing below can shadow a binary that PATH already finds.
//
// The order is deliberate. Asking the user's own login shell is the durable
// answer — it tracks wherever their tooling actually installs things (pipx,
// mise, asdf, nix, a Homebrew prefix that moves again) instead of a hardcoded
// list we would have to keep editing. The fixed list underneath it is only the
// last resort for when that probe cannot run at all.

// Consulted only after the login-shell probe comes back empty.
const FALLBACK_DIRS = [
  path.join(os.homedir(), '.local', 'bin'),
  '/usr/local/bin',
  '/opt/homebrew/bin',
  path.join(os.homedir(), 'bin'),
];

// `-i` sources the user's interactive rc files, which is the whole point — and
// also why this is bounded. A heavy zsh setup can take a second or more, and a
// broken one can hang, so it runs at most once, only on a miss, and a failure
// is not an error: we simply learn nothing and fall through.
const SHELL_PATH_TIMEOUT_MS = 2000;

const isWindows = process.platform === 'win32';

let shellPathCache; // undefined = not asked yet, null = asked and got nothing

function isExecutableFile(candidate) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
  } catch {
    return false;
  }
  // The executable bit is meaningless on Windows — being a file is the test.
  if (isWindows) return true;
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// On Windows a bare name is spelled without its extension, so each PATHEXT
// suffix is a separate candidate. Elsewhere the name is the whole story.
function candidateNames(file) {
  if (!isWindows) return [file];
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  return [file, ...exts.map((ext) => `${file}${ext}`)];
}

function findIn(dirs, file) {
  const names = candidateNames(file);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function splitPath(value) {
  return String(value || '')
    .split(path.delimiter)
    .filter(Boolean);
}

// The PATH the user's own shell would have. Cached for the life of the process:
// the answer does not change while the app runs, and the probe is too expensive
// to repeat. Returns [] when it cannot be asked or cannot be trusted.
function shellPath() {
  if (shellPathCache !== undefined) return shellPathCache || [];
  shellPathCache = null;

  // No interactive login shell to ask on Windows, and $SHELL unset means we
  // would be guessing at which shell the user has — better to learn nothing
  // than to run the wrong one.
  if (isWindows || !process.env.SHELL) return [];

  try {
    const out = execFileSync(process.env.SHELL, ['-ilc', 'echo $PATH'], {
      encoding: 'utf8',
      timeout: SHELL_PATH_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // rc files print things — banners, version notices, motd. The PATH is what
    // our own `echo` wrote, so it is the last non-empty line, not the first.
    const lines = out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const last = lines[lines.length - 1];
    if (last && last.includes(path.delimiter)) shellPathCache = splitPath(last);
  } catch {
    // Timed out, exited non-zero, or there is no such shell. Not an error.
  }
  return shellPathCache || [];
}

// Absolute path for `file`, or `file` unchanged when there is nothing better to
// offer — including when it is not found at all, so the failure still names the
// command the user actually typed rather than something they never wrote.
function resolveExecutable(file) {
  const name = String(file || '');
  if (!name) return name;

  // A path is an instruction, not a hint. If the user typed one, honour it
  // exactly — resolving it against anything else would run a different program
  // than the one they named.
  if (name.includes('/') || (isWindows && name.includes('\\'))) return name;

  const envDirs = splitPath(process.env.PATH);
  if (findIn(envDirs, name)) return name; // spawn will find it the usual way

  const known = new Set(envDirs);
  const extra = [...shellPath(), ...FALLBACK_DIRS].filter((dir) => !known.has(dir));
  return findIn(extra, name) || name;
}

// The environment for a spawned agent, with the directories we had to go
// looking in added to its PATH.
//
// Resolving the executable is only half the problem: an agent that shells out
// to its own tools inherits our environment, so one started from a desktop
// session can connect and then fail at tool-call time — a failure that looks
// nothing like a PATH problem and is far harder to diagnose than the ENOENT it
// replaces.
//
// Deliberately additive. The existing PATH keeps its order and its precedence,
// nothing is removed or reordered, and no other variable is touched — an agent
// must resolve the same tools it would have, plus the ones it was missing.
function childEnv(base) {
  const env = { ...(base || process.env) };
  const current = splitPath(env.PATH);
  const known = new Set(current);
  const extra = [...shellPath(), ...FALLBACK_DIRS].filter((dir) => {
    if (known.has(dir)) return false;
    known.add(dir);
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
  if (extra.length) env.PATH = [...current, ...extra].join(path.delimiter);
  return env;
}

// Shared wording for a command that could not be found. The absolute-path
// suggestion is the actual fix when a GUI-launched app cannot see the user's
// PATH, so it belongs in the message rather than in documentation nobody is
// reading at the moment it fails.
//
// This text names a local command, so it is *detail*: see the note on
// `err.detail` below.
function notFoundMessage(file) {
  return (
    `Command not found: ${file}. If it is installed, enter its full path ` +
    `(for example ${path.join(os.homedir(), '.local', 'bin', 'hermes')}).`
  );
}

// Errors from a transport can end up in front of two very different audiences:
// the owner of this machine, and a peer on the LAN who asked the agent a
// question. `err.message` is relayed onward, so it must never carry anything
// local — no filesystem paths, no command names, no captured stderr. Anything
// of that kind goes on `err.detail`, which only ever reaches the local user.
//
// Attach both at the point where the error is built, because that is the only
// place that knows which half of the string is sensitive.
function localError(peerSafeMessage, detail) {
  const err = new Error(peerSafeMessage);
  if (detail) err.detail = detail;
  return err;
}

module.exports = { resolveExecutable, shellPath, childEnv, notFoundMessage, localError, FALLBACK_DIRS };
