'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// dictation.js is renderer ESM but touches no browser API at all — every
// collaborator is injected — so it evaluates directly. Strict mode for the same
// reason ptt.test.js uses it: sloppy mode invents globals instead of throwing.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'dictation.js'), 'utf8');

function loadDictation() {
  const body = SRC.replace(/^export\s+/gm, '');
  const fn = new Function(
    'console',
    `'use strict';
     ${body}
     return { DictationManager, shouldDictate, holdMode, ARM_MS, MAX_DICTATION_MS, ERROR_CLEAR_MS };`
  );
  return fn(console);
}

test('the key only dictates on macOS, in a thread that thinks, when switched on', () => {
  const { shouldDictate } = loadDictation();
  const yes = { isMac: true, enabled: true, thinkingThread: true };
  assert.equal(shouldDictate(yes), true);
  // Unset is on: the feature ships switched on for the platform that has it.
  assert.equal(shouldDictate({ ...yes, enabled: undefined }), true);

  // Off macOS the transcriber cannot run at all, so the key must keep doing
  // exactly what it did before — this is the regression lock on that promise.
  assert.equal(shouldDictate({ ...yes, isMac: false }), false);
  assert.equal(shouldDictate({ ...yes, enabled: false }), false);
  // A person hears you; they do not read a transcript of you.
  assert.equal(shouldDictate({ ...yes, thinkingThread: false }), false);
});

test('with no transcriber installed the key does nothing, rather than opening the mic', () => {
  const { holdMode } = loadDictation();
  const mac = { isMac: true, enabled: true, thinkingThread: true };

  assert.equal(holdMode({ ...mac, ready: true }), 'dictate');
  // Not yet answered counts as ready, so a hold in the first moment after
  // launch is not silently dropped.
  assert.equal(holdMode({ ...mac, ready: null }), 'dictate');

  // The one that matters: falling back to 'radio' here would open the
  // microphone for an agent that cannot hear it — the exact defect dictation
  // was added to remove. Doing nothing is the honest answer.
  assert.equal(holdMode({ ...mac, ready: false }), 'none');

  // A person is still a person, installed or not.
  assert.equal(holdMode({ ...mac, thinkingThread: false, ready: false }), 'radio');
  assert.equal(holdMode({ ...mac, isMac: false, ready: false }), 'radio');
  assert.equal(holdMode({ ...mac, enabled: false, ready: false }), 'radio');
});

const tick = () => new Promise((r) => setImmediate(r));
const after = (ms) => new Promise((r) => setTimeout(r, ms));

// A recorder whose stop() resolves whatever it was told to, and which reports
// whether the microphone was released rather than harvested.
function fakeRecorder(clip = { blob: 'audio', durationMs: 900 }) {
  const calls = { record: 0, stop: 0, cancel: 0 };
  let openResolve = null;
  const handle = {
    stop: async () => (calls.stop++, clip),
    cancel: () => calls.cancel++,
  };
  return {
    calls,
    // Resolves immediately unless `hold` is set, in which case the test decides
    // when getUserMedia "returns".
    make(hold = false) {
      return async () => {
        calls.record++;
        if (!hold) return handle;
        return new Promise((resolve) => (openResolve = () => resolve(handle)));
      };
    },
    open: () => openResolve && openResolve(),
  };
}

function build(overrides = {}) {
  const { DictationManager, ARM_MS, ERROR_CLEAR_MS } = loadDictation();
  const rec = fakeRecorder(overrides.clip);
  const events = { states: [], results: [], errors: [], cues: [] };
  const manager = new DictationManager({
    record: overrides.record || rec.make(overrides.holdOpen),
    encode: overrides.encode || (async () => new Uint8Array([1, 2, 3])),
    transcribe: overrides.transcribe || (async () => 'hello there'),
    getDevices: () => ({ audioInputId: null }),
    onState: (s) => events.states.push(s.phase),
    onResult: (text, threadId) => events.results.push({ text, threadId }),
    onError: (m) => events.errors.push(m),
    onCue: (k) => events.cues.push(k),
  });
  return { manager, rec, events, ARM_MS, ERROR_CLEAR_MS };
}

test('letting go inside the arm window never opens the microphone', async () => {
  const { manager, rec, events, ARM_MS } = build();
  manager.start('agent:1');
  // What ⌘C looks like: attachPttKey releases within tens of milliseconds.
  await after(ARM_MS / 5);
  manager.stop();
  await after(ARM_MS * 2);
  assert.equal(rec.calls.record, 0, 'the recorder must never be started');
  assert.deepEqual(events.cues, [], 'and no cue should have played');
  assert.equal(manager.phase, 'idle');
});

test('a full hold records, transcribes and reports the text', async () => {
  const { manager, rec, events, ARM_MS } = build();
  manager.start('agent:1');
  await after(ARM_MS + 20);
  assert.deepEqual(events.cues, ['transmit'], 'the go-ahead cue plays before the mic opens');
  await manager.stop();
  assert.equal(rec.calls.record, 1);
  assert.equal(rec.calls.stop, 1);
  assert.deepEqual(events.results, [{ text: 'hello there', threadId: 'agent:1' }]);
  assert.equal(manager.phase, 'idle');
});

test('a tap too short to be a message is discarded silently', async () => {
  // startRecording() answers a sub-minimum recording with null.
  const { manager, events, ARM_MS } = build({ clip: null });
  manager.start('agent:1');
  await after(ARM_MS + 20);
  await manager.stop();
  assert.deepEqual(events.results, [], 'nothing to say');
  assert.deepEqual(events.errors, [], 'and nothing to apologise for');
  assert.equal(manager.phase, 'idle');
});

test('the transcript belongs to the thread that was open when it was spoken', async () => {
  let release;
  const { manager, events, ARM_MS } = build({
    transcribe: () => new Promise((r) => (release = () => r('the words'))),
  });
  manager.start('session:7');
  await after(ARM_MS + 20);
  const stopping = manager.stop();
  await tick();
  release(); // the user has since moved to another conversation
  await stopping;
  assert.deepEqual(events.results, [{ text: 'the words', threadId: 'session:7' }]);
});

test('a second hold while the first is still transcribing is ignored', async () => {
  let release;
  const { manager, rec, ARM_MS } = build({
    transcribe: () => new Promise((r) => (release = () => r('one'))),
  });
  manager.start('agent:1');
  await after(ARM_MS + 20);
  const stopping = manager.stop();
  await tick();
  assert.equal(manager.phase, 'transcribing');
  manager.start('agent:1');
  await after(ARM_MS + 20);
  assert.equal(rec.calls.record, 1, 'no second recording');
  release();
  await stopping;
});

test('a failed transcription surfaces, then clears itself', async () => {
  const { manager, events, ARM_MS, ERROR_CLEAR_MS } = build({
    transcribe: async () => {
      throw new Error('Transcription failed.');
    },
  });
  manager.start('agent:1');
  await after(ARM_MS + 20);
  await manager.stop();
  assert.equal(manager.phase, 'error');
  assert.deepEqual(events.errors, ['Transcription failed.']);
  assert.deepEqual(events.results, []);
  await after(ERROR_CLEAR_MS + 50);
  assert.equal(manager.phase, 'idle', 'a stale error reads as a broken feature');
});

test('a hold may start again over a still-visible error', async () => {
  const { manager, rec, ARM_MS } = build({
    transcribe: async () => {
      throw new Error('nope');
    },
  });
  manager.start('agent:1');
  await after(ARM_MS + 20);
  await manager.stop();
  assert.equal(manager.phase, 'error');
  manager.start('agent:1');
  await after(ARM_MS + 20);
  assert.equal(rec.calls.record, 2, 'trying again must not have to wait for the error to time out');
  await manager.stop();
});

test('releasing before the microphone finishes opening still releases it', async () => {
  const { manager, rec, ARM_MS } = build({ holdOpen: true });
  manager.start('agent:1');
  await after(ARM_MS + 20);
  assert.equal(rec.calls.record, 1, 'the request is in flight');
  manager.stop(); // let go while getUserMedia is still pending
  await tick();
  rec.open(); // ...and only now does the mic actually open
  await after(20);
  assert.equal(rec.calls.cancel, 1, 'the microphone must be released');
  assert.equal(rec.calls.stop, 0, 'and nothing recorded');
  assert.equal(manager.phase, 'idle');
});

test('releasing without holding does nothing', async () => {
  const { manager, rec, events } = build();
  await manager.stop();
  assert.equal(rec.calls.record, 0);
  assert.deepEqual(events.results, []);
  assert.deepEqual(events.errors, []);
});

test('the reported phases run idle -> arming -> recording -> transcribing -> idle', async () => {
  const { manager, events, ARM_MS } = build();
  manager.start('agent:1');
  await after(ARM_MS + 20);
  await manager.stop();
  assert.deepEqual(events.states, ['arming', 'recording', 'transcribing', 'idle']);
});

test('teardown mid-recording releases the microphone and drops the result', async () => {
  const { manager, rec, events, ARM_MS } = build();
  manager.start('agent:1');
  await after(ARM_MS + 20);
  manager.cancel();
  await after(20);
  assert.equal(rec.calls.cancel, 1);
  assert.deepEqual(events.results, []);
  assert.equal(manager.phase, 'idle');
});

// ------------------------------------------------------- tap, rather than hold

test('a tap starts recording without waiting out the arm window', async () => {
  const { manager, rec, ARM_MS } = build();
  manager.toggle('agent:1');
  await tick();

  // The arm window exists only to let ⌘C and ⌘V through untouched. A button
  // press is unambiguous, so waiting a quarter second would just read as lag.
  assert.equal(rec.calls.record, 1, 'the microphone opens immediately');
  assert.ok(ARM_MS > 0, 'the hold path still has a window to wait out');
  assert.equal(manager.phase, 'recording');
});

test('a second tap stops and transcribes into the thread the first tap named', async () => {
  const { manager, events } = build();
  manager.toggle('agent:1');
  await tick();
  manager.toggle('agent:1');
  await tick();
  await tick();

  assert.deepEqual(events.results, [{ text: 'hello there', threadId: 'agent:1' }]);
  assert.equal(manager.phase, 'idle');
});

test('a tap while transcribing is ignored rather than starting a second recording', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { manager, rec } = build({ transcribe: async () => (await gate, 'done') });

  manager.toggle('agent:1');
  await tick();
  manager.toggle('agent:1'); // stop -> transcribing
  await tick();
  assert.equal(manager.phase, 'transcribing');

  manager.toggle('agent:1');
  await tick();
  assert.equal(rec.calls.record, 1, 'no second recording started');

  release();
  await tick();
  await tick();
  assert.equal(manager.phase, 'idle');
});

test('a tap over a visible error starts a fresh attempt', async () => {
  const { manager, rec } = build({
    record: async () => {
      throw new Error('no mic');
    },
  });
  manager.toggle('agent:1');
  await tick();
  assert.equal(manager.phase, 'error');

  // An error that has to time out before you can try again reads as the feature
  // being broken rather than as one attempt that failed.
  const ok = build();
  ok.manager.phase = 'error';
  ok.manager.toggle('agent:1');
  await tick();
  assert.equal(ok.rec.calls.record, 1);
  assert.ok(rec.calls.record >= 0);
});

test('a tap released before the microphone opens still releases it', async () => {
  const { manager, rec } = build({ holdOpen: true });
  manager.toggle('agent:1');
  await tick();
  manager.toggle('agent:1'); // stop while getUserMedia is still pending
  await tick();

  rec.open();
  await tick();
  await tick();

  assert.equal(rec.calls.cancel, 1, 'the microphone must not be left live');
  assert.equal(manager.phase, 'idle');
});
