'use strict';

// Local speech-to-text, by handing a clip to the FluidAudio CLI.
//
// Nothing about this file is macOS-specific on purpose. FluidAudio only builds
// for macOS, but the renderer is what decides whether to offer dictation at all
// — keeping the spawn path platform-agnostic is what makes it testable against
// a stub on any machine, and a `process.platform` check here would buy nothing
// and cost that.
//
// Three facts about the CLI shape everything below, all of them read out of its
// source rather than assumed, because each one is a way to silently return the
// wrong thing:
//
//   1. A failed transcription still exits 0. `runBatch` catches and logs, and
//      never calls exit. So the exit code says nothing about success.
//   2. Its logging goes to stderr; the only thing written to stdout is the
//      transcript itself. So stdout is trustworthy, but empty stdout is
//      ambiguous — a failure and a silent clip look identical.
//   3. `--output-json` is written inside the success path only.
//
// Together those give the one reliable test: we succeeded if, and only if, the
// JSON file exists, parses, and carries `text`. That is why the flag is passed
// even though stdout alone would usually do.
//
// This is also why runProcess() from agents/transports is not reused here: it
// discards stderr whenever it does not reject, and a CLI that fails by exiting 0
// would hand us silence with the diagnosis thrown away.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveExecutable, childEnv, notFoundMessage } = require('./agents/transports/resolve');

const CLI_NAME = 'fluidaudiocli';
// 16 kHz mono 16-bit is 32 kB/s, so this is about 16 minutes. Long past the
// point where a held key is a mistake rather than a message.
const MAX_CLIP_BYTES = 32 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 5000;
const RUN_TIMEOUT_MS = 90000;
// The first transcription downloads the speech models, and there is no working
// command to do it ahead of time — `download --dataset parakeet-models` is in
// the CLI's usage text but has no branch behind it. So the first run has to be
// allowed to take as long as a large download takes.
const FIRST_RUN_TIMEOUT_MS = 15 * 60 * 1000;
const SLOW_NOTICE_MS = 8000;

// Kept out of the message the user sees; it names a local path.
function detailOf(stderr) {
  const text = (stderr || '').trim();
  return text ? text.slice(-2000) : null;
}

// Minimal runner: unlike the agent transports we need stdout, stderr and the
// exit code together, on success as well as failure.
function run(file, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        env: childEnv(),
        shell: false, // never: the path is user-supplied
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: null, out: '', err: '', spawnError: err });
      return;
    }
    let out = '';
    let errOut = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish({ code: null, out, err: errOut, timedOut: true });
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => (errOut += chunk));
    child.on('error', (err) => finish({ code: null, out, err: errOut, spawnError: err }));
    child.on('close', (code) => finish({ code, out, err: errOut }));
  });
}

// `timeouts` is injectable so the kill path can be exercised for real rather
// than waited out; nothing but tests passes it.
function createDictation({ config, emit, timeouts = {} }) {
  const probeMs = timeouts.probe || PROBE_TIMEOUT_MS;
  const runMs = timeouts.run || RUN_TIMEOUT_MS;
  const firstRunMs = timeouts.firstRun || FIRST_RUN_TIMEOUT_MS;
  const slowNoticeMs = timeouts.slowNotice || SLOW_NOTICE_MS;
  let inFlight = false;

  function cliPath(override) {
    const named = (override || config.get('dictationCliPath') || CLI_NAME).trim();
    return resolveExecutable(named || CLI_NAME);
  }

  // Is there a usable CLI at this path? Answered by running it, not by trusting
  // the name — a path that exists and is executable can still be the wrong
  // program. `help` is the argument form that exits 0; running it with none at
  // all exits 1, so a plain invocation is not a usable liveness check.
  async function probe(override) {
    const file = cliPath(override);
    if (file.includes(path.sep)) {
      try {
        if (!fs.statSync(file).isFile()) return { ok: false, path: file, detail: 'Not a file.' };
        fs.accessSync(file, fs.constants.X_OK);
      } catch {
        return { ok: false, path: file, detail: notFoundMessage(file) };
      }
    }
    const res = await run(file, ['help'], probeMs);
    if (res.spawnError) {
      return { ok: false, path: file, detail: notFoundMessage(file) };
    }
    if (res.timedOut) return { ok: false, path: file, detail: 'It did not respond.' };
    if (res.code !== 0) {
      return { ok: false, path: file, detail: detailOf(res.err) || `Exited with code ${res.code}.` };
    }
    // Usage goes to stderr, so that is where the identifying line is.
    const line = (res.err || res.out).split('\n').find((l) => l.trim());
    return { ok: true, path: file, detail: (line || '').trim().slice(0, 200) };
  }

  async function transcribe({ data }) {
    const bytes = data ? Buffer.from(data) : null;
    if (!bytes || !bytes.length) return { ok: false, error: 'There was nothing to transcribe.' };
    if (bytes.length > MAX_CLIP_BYTES) {
      return { ok: false, error: 'That recording is too long to transcribe.' };
    }
    if (inFlight) return { ok: false, error: 'Still transcribing the last recording.' };
    inFlight = true;

    const file = cliPath();
    const firstRun = !config.get('dictationModelReady');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-dictate-'));
    const clipPath = path.join(dir, 'clip.wav');
    const outPath = path.join(dir, 'out.json');
    let notice = null;

    try {
      fs.writeFileSync(clipPath, bytes, { mode: 0o600 });
      if (firstRun) {
        notice = setTimeout(() => emit('dictation', { state: 'downloading' }), slowNoticeMs);
      }
      // The audio file must come first; everything after it is parsed as flags.
      // No --model-version: the CLI's own default is a better answer than one
      // pinned here on no evidence.
      const res = await run(
        file,
        ['transcribe', clipPath, '--output-json', outPath],
        firstRun ? firstRunMs : runMs
      );

      if (res.spawnError) {
        return {
          ok: false,
          error: 'Dictation is not set up — see Settings → Push to talk.',
          detail: notFoundMessage(file),
        };
      }
      if (res.timedOut) {
        return {
          ok: false,
          error: firstRun
            ? 'Transcription timed out. The speech models may still be downloading — try again.'
            : 'Transcription timed out.',
          detail: detailOf(res.err),
        };
      }

      let text = null;
      try {
        const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        if (typeof parsed.text === 'string') text = parsed.text;
      } catch {
        // No JSON means the run did not reach the end of its success path,
        // whatever the exit code claims.
        text = null;
      }
      if (text === null) {
        return { ok: false, error: 'Transcription failed.', detail: detailOf(res.err) };
      }

      if (firstRun) config.set({ dictationModelReady: true });
      // stdout carries the same transcript and nothing else, so it is a free
      // cross-check for the case where the JSON is present but empty.
      return { ok: true, text: text.trim() || res.out.trim() };
    } catch (err) {
      return { ok: false, error: 'Transcription failed.', detail: err.message };
    } finally {
      clearTimeout(notice);
      inFlight = false;
      // The clip is speech; it does not outlive the request that produced it.
      // The escape hatch exists because if the CLI ever rejects our audio, the
      // only way to find out why is to play the exact file we handed it.
      if (process.env.LANCHAT_DICTATION_KEEP) console.log('[dictation] kept clip at', clipPath);
      else fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  return { probe, transcribe };
}

module.exports = { createDictation, CLI_NAME, MAX_CLIP_BYTES };
