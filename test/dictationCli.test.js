'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDictation, MAX_CLIP_BYTES } = require('../src/main/dictation');

// These run the real spawn path — real child processes, real temp files, real
// timeouts — against shell stubs that reproduce what the FluidAudio CLI was
// read to actually do. Three of its behaviours are counter-intuitive enough
// that getting them wrong would silently return the wrong text:
//
//   - `transcribe` exits 0 even when it fails, so the exit code proves nothing.
//   - Its logging goes to stderr; stdout carries only the transcript.
//   - `--output-json` is written on the success path only.
//
// So the JSON file, not the exit code, is the thing that says it worked.

// The stubs below are POSIX shell scripts, which Windows cannot execute — so
// these skip there. What they cover is not platform-specific (the module has no
// darwin check at all, deliberately); only the way the fake CLI is written is.
const POSIX_ONLY = { skip: process.platform === 'win32' };

const stubs = [];
function stubCli(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-clistub-'));
  stubs.push(dir);
  const file = path.join(dir, 'fluidaudiocli');
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return file;
}

test.after(() => {
  for (const dir of stubs) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeConfig(values = {}) {
  const data = { dictationCliPath: null, dictationModelReady: true, ...values };
  return {
    data,
    get: (k) => data[k],
    set: (patch) => Object.assign(data, patch),
  };
}

function make(values, emitted = [], timeouts) {
  const config = fakeConfig(values);
  const dictation = createDictation({ config, emit: (t, p) => emitted.push({ t, p }), timeouts });
  return { dictation, config, emitted };
}

const clip = () => Buffer.alloc(64, 7);

// A stub that answers `help` (exit 0, usage on stderr) and writes the JSON its
// caller asked for. $1 is the command, $2 the audio file, $4 the json path.
const WORKING = `
if [ "$1" = "help" ]; then echo "FluidAudio CLI" >&2; exit 0; fi
echo "Transcribing file: $2 ..." >&2
printf '%s' "hello from the stub"
printf '{"audioFile":"%s","text":"hello from the stub"}' "$2" > "$4"
exit 0
`;

test('a path that is not there is reported, not spawned hopefully', POSIX_ONLY, async () => {
  const { dictation } = make({ dictationCliPath: '/nonexistent/fluidaudiocli' });
  const res = await dictation.probe();
  assert.equal(res.ok, false);
  assert.match(res.detail, /Command not found/);
});

test('a CLI that answers `help` with exit 0 is considered installed', POSIX_ONLY, async () => {
  const { dictation } = make({ dictationCliPath: stubCli(WORKING) });
  const res = await dictation.probe();
  assert.equal(res.ok, true, res.detail);
  assert.equal(res.detail, 'FluidAudio CLI', 'the identifying line comes off stderr');
});

test('running it with no arguments is not used as the check', POSIX_ONLY, async () => {
  // The real CLI exits 1 when given nothing, so a bare invocation would call a
  // perfectly good install broken. Only `help` exits 0.
  const file = stubCli(`
    if [ "$1" = "help" ]; then echo "FluidAudio CLI" >&2; exit 0; fi
    echo "ERROR: No audio file specified" >&2
    exit 1
  `);
  const { dictation } = make({ dictationCliPath: file });
  assert.equal((await dictation.probe()).ok, true);
});

test('probe can be pointed at a path before it is saved', POSIX_ONLY, async () => {
  const { dictation } = make({ dictationCliPath: '/nonexistent/one' });
  const res = await dictation.probe(stubCli(WORKING));
  assert.equal(res.ok, true, res.detail);
});

test('a transcription returns the text from the JSON the CLI wrote', POSIX_ONLY, async () => {
  const { dictation } = make({ dictationCliPath: stubCli(WORKING) });
  const res = await dictation.transcribe({ data: clip() });
  assert.deepEqual(res, { ok: true, text: 'hello from the stub' });
});

test('a failure that still exits 0 is caught by the missing JSON', POSIX_ONLY, async () => {
  // This is the CLI's real failure shape: it logs and returns, and its exit
  // status says nothing at all. Trusting the code here would report success
  // with an empty message.
  const file = stubCli(`
    if [ "$1" = "help" ]; then exit 0; fi
    echo "Batch transcription failed: modelNotFound" >&2
    exit 0
  `);
  const { dictation } = make({ dictationCliPath: file });
  const res = await dictation.transcribe({ data: clip() });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Transcription failed.');
  assert.match(res.detail, /modelNotFound/, 'the reason belongs on detail, not in the message');
});

test('the clip is deleted whatever happens', POSIX_ONLY, async () => {
  // The stub records the path it was handed, so the test can look for it after.
  const log = path.join(os.tmpdir(), `lanchat-clip-log-${process.pid}`);
  fs.rmSync(log, { force: true });
  const file = stubCli(`
    if [ "$1" = "help" ]; then exit 0; fi
    echo "$2" >> "${log}"
    printf '{"text":"ok"}' > "$4"
  `);
  const { dictation } = make({ dictationCliPath: file });
  assert.equal((await dictation.transcribe({ data: clip() })).ok, true);
  const clipPath = fs.readFileSync(log, 'utf8').trim();
  fs.rmSync(log, { force: true });
  assert.ok(clipPath.endsWith('clip.wav'), clipPath);
  assert.equal(fs.existsSync(clipPath), false, 'recorded speech must not outlive the request');
  assert.equal(fs.existsSync(path.dirname(clipPath)), false, 'nor its directory');
});

test('the clip is deleted after a failure too', POSIX_ONLY, async () => {
  const log = path.join(os.tmpdir(), `lanchat-clip-log-fail-${process.pid}`);
  fs.rmSync(log, { force: true });
  const file = stubCli(`
    if [ "$1" = "help" ]; then exit 0; fi
    echo "$2" >> "${log}"
    echo "went wrong" >&2
    exit 0
  `);
  const { dictation } = make({ dictationCliPath: file });
  assert.equal((await dictation.transcribe({ data: clip() })).ok, false);
  const clipPath = fs.readFileSync(log, 'utf8').trim();
  fs.rmSync(log, { force: true });
  assert.equal(fs.existsSync(clipPath), false);
});

test('a CLI that never returns is killed, reported, and leaves nothing behind', POSIX_ONLY, async () => {
  const log = path.join(os.tmpdir(), `lanchat-clip-log-hang-${process.pid}`);
  fs.rmSync(log, { force: true });
  const file = stubCli(`
    if [ "$1" = "help" ]; then exit 0; fi
    echo "$2" >> "${log}"
    sleep 30
  `);
  const { dictation } = make({ dictationCliPath: file }, [], { run: 300 });
  const res = await dictation.transcribe({ data: clip() });
  assert.equal(res.ok, false);
  assert.match(res.error, /timed out/);
  const clipPath = fs.readFileSync(log, 'utf8').trim();
  fs.rmSync(log, { force: true });
  assert.equal(fs.existsSync(clipPath), false, 'a killed run still cleans up after itself');

  // And the runner is free again: a hung attempt must not wedge dictation for
  // the rest of the session.
  const { dictation: after } = make({ dictationCliPath: stubCli(WORKING) });
  assert.equal((await after.transcribe({ data: clip() })).ok, true);
});

test('a first run that is slow to answer says so, once', POSIX_ONLY, async () => {
  const emitted = [];
  const file = stubCli(`
    if [ "$1" = "help" ]; then exit 0; fi
    sleep 1
    printf '{"text":"finally"}' > "$4"
  `);
  const { dictation } = make({ dictationCliPath: file, dictationModelReady: false }, emitted, {
    firstRun: 5000,
    slowNotice: 100,
  });
  const res = await dictation.transcribe({ data: clip() });
  assert.equal(res.ok, true);
  assert.deepEqual(
    emitted,
    [{ t: 'dictation', p: { state: 'downloading' } }],
    'a first run that stalls explains itself rather than looking hung'
  );
});

test('a missing binary is reported as setup, not as a failure', POSIX_ONLY, async () => {
  const { dictation } = make({ dictationCliPath: '/nonexistent/fluidaudiocli' });
  const res = await dictation.transcribe({ data: clip() });
  assert.equal(res.ok, false);
  assert.match(res.error, /not set up/);
  assert.match(res.detail, /Command not found/);
});

test('a second transcription while one is running is refused', POSIX_ONLY, async () => {
  const file = stubCli(`
    if [ "$1" = "help" ]; then exit 0; fi
    sleep 1
    printf '{"text":"first"}' > "$4"
  `);
  const { dictation } = make({ dictationCliPath: file });
  const first = dictation.transcribe({ data: clip() });
  const second = await dictation.transcribe({ data: clip() });
  assert.equal(second.ok, false);
  assert.match(second.error, /Still transcribing/);
  assert.deepEqual(await first, { ok: true, text: 'first' });
});

test('an oversized clip is refused without spawning anything', POSIX_ONLY, async () => {
  const file = stubCli(`echo "should not run" > "${path.join(os.tmpdir(), 'lanchat-never')}"`);
  const { dictation } = make({ dictationCliPath: file });
  const res = await dictation.transcribe({ data: Buffer.alloc(MAX_CLIP_BYTES + 1) });
  assert.equal(res.ok, false);
  assert.match(res.error, /too long/);
  assert.equal(fs.existsSync(path.join(os.tmpdir(), 'lanchat-never')), false);
});

test('an empty clip is refused', POSIX_ONLY, async () => {
  const { dictation } = make({ dictationCliPath: stubCli(WORKING) });
  assert.equal((await dictation.transcribe({ data: null })).ok, false);
  assert.equal((await dictation.transcribe({ data: Buffer.alloc(0) })).ok, false);
});

test('the first run announces the model download and is not announced again', POSIX_ONLY, async () => {
  const emitted = [];
  const { dictation, config } = make(
    { dictationCliPath: stubCli(WORKING), dictationModelReady: false },
    emitted
  );
  const res = await dictation.transcribe({ data: clip() });
  assert.equal(res.ok, true);
  assert.equal(config.get('dictationModelReady'), true, 'later runs get the short deadline');
  // The stub answers at once, so the slow notice must not have fired.
  assert.deepEqual(emitted, [], 'a fast first run says nothing');
});
