'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Reading a session aloud, turn by turn.
//
// The list and its cursor are the feature. Two agents in one round answer
// whenever their transports happen to finish, which is to say at the same
// moment, so the reading has to line them up rather than let them talk over each
// other — and a person listening has to be able to go back one, stop, and carry
// on. All of that is one list and one index, which is what these tests drive.
//
// The rule that matters most is the one an earlier draft got wrong: there is
// **one** list, not a live queue beside a play-it-all list. With two, a turn
// read live left the transport with nothing to go forward into. So several tests
// below check that a live reading and the transport are moving the same thing.
//
// ESM for the renderer, and it imports React for its hooks. Drop the imports and
// the `export` keywords and evaluate it, exactly as agentMusic.test.js does;
// nothing runs at module scope, so React and the AudioContext never have to
// exist. clampVolume is read out of the real agentMusic.js rather than
// reimplemented, so the two cannot drift.
const LIB = path.join(__dirname, '..', 'src', 'renderer', 'lib');
const strip = (src) => src.replace(/^import[^;]+;$/gm, '').replace(/^export\s+/gm, '');

const { clampVolume } = new Function(
  `${strip(fs.readFileSync(path.join(LIB, 'agentMusic.js'), 'utf8'))}
   return { clampVolume };`
)();

const {
  AgentSpeech,
  MAX_LIST,
  MAX_UTTERANCE_MS,
  PREVIEW_LINE,
  previewVoice,
  chunkText,
  LOCAL_CHUNK_CHARS,
  SYNTH_POLL_MS,
  SYNTH_GRACE_MS,
  IDLE,
  PLAYING,
  PAUSED,
  GEMINI,
  XAI,
  LOCAL,
} = new Function(
  'clampVolume',
  'audioContext',
  `${strip(fs.readFileSync(path.join(LIB, 'agentSpeech.js'), 'utf8'))}
   return { AgentSpeech, MAX_LIST, MAX_UTTERANCE_MS, PREVIEW_LINE, previewVoice, chunkText,
            LOCAL_CHUNK_CHARS, SYNTH_POLL_MS, SYNTH_GRACE_MS, IDLE, PLAYING, PAUSED, GEMINI, XAI, LOCAL };`
)(clampVolume, () => null);

// ------------------------------------------------------------------- the stage

// An audio graph that records rather than makes noise. Playing is only finished
// when the test says so, which is what lets "one at a time" be asserted at all.
function stage() {
  const played = [];
  const el = {
    src: null,
    preload: null,
    onended: null,
    onerror: null,
    paused: false,
    play() {
      played.push(this.src);
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
  };
  // The real _build() chains `source.connect(gain).connect(destination)`, so
  // both nodes have to return something connectable — a gain node without a
  // connect() would send the whole class down its "audio unavailable" path and
  // every assertion below would pass for the wrong reason.
  const gain = { gain: { value: 0 }, connect: () => ({}), disconnect() {} };
  const source = { connect: () => gain, disconnect() {} };
  const context = () => ({
    createMediaElementSource: () => source,
    createGain: () => gain,
    destination: {},
  });
  return { el, gain, played, context, element: () => el };
}

// The platform voice, recorded the same way.
function localStage() {
  const spoken = [];
  const utterances = [];
  const synth = {
    voices: [],
    paused: 0,
    resumed: 0,
    cancelled: 0,
    getVoices() {
      return this.voices;
    },
    speak(u) {
      spoken.push(u);
    },
    pause() {
      this.paused += 1;
    },
    resume() {
      this.resumed += 1;
    },
    cancel() {
      this.cancelled += 1;
    },
  };
  const utterance = (text) => {
    const u = { text, volume: null, voice: null, onend: null, onerror: null };
    utterances.push(u);
    return u;
  };
  return { synth, utterance, spoken, utterances };
}

// A synthesiser whose resolution the test controls, so "still thinking" is a
// state a test can sit in.
function deferredSynth() {
  const calls = [];
  const synthesize = (text, voice) => {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    calls.push({ text, voice, resolve });
    return promise;
  };
  return { synthesize, calls };
}

const settle = () => new Promise((r) => setImmediate(r));
const turns = (...texts) => texts.map((t, i) => ({ id: String(i + 1), text: t, voice: 'Kore' }));

// A player wired to a stage, with a synthesiser that answers immediately.
function player(s, extra = {}) {
  return new AgentSpeech({
    synthesize: async (text) => `file:///${text}.wav`,
    context: s.context,
    element: s.element,
    synth: null,
    ...extra,
  });
}

// ------------------------------------------------------------------ the list

test('the whole session reads in order, one turn at a time', async () => {
  const s = stage();
  const p = player(s);
  p.sync(turns('one', 'two', 'three'));
  p.playFrom();

  await settle();
  assert.deepEqual(s.played, ['file:///one.wav'], 'only the first has started');

  s.el.onended();
  await settle();
  s.el.onended();
  await settle();
  assert.deepEqual(s.played, ['file:///one.wav', 'file:///two.wav', 'file:///three.wav']);

  // Off the end: finished, and the cursor is one past the last so prev() knows
  // where the last thing said was.
  s.el.onended();
  await settle();
  assert.equal(p.status, IDLE);
  assert.equal(p.index, 3);
});

test('a bubble starts the reading from itself and carries on', async () => {
  const s = stage();
  const p = player(s);
  p.sync(turns('one', 'two', 'three'));
  p.playFrom('2');

  await settle();
  assert.deepEqual(s.played, ['file:///two.wav']);
  s.el.onended();
  await settle();
  assert.deepEqual(s.played, ['file:///two.wav', 'file:///three.wav'], 'it reads on, not just the one');
});

test('an id that is not there starts at the top rather than nowhere', async () => {
  const s = stage();
  const p = player(s);
  p.sync(turns('one', 'two'));
  p.playFrom('gone');
  await settle();
  assert.deepEqual(s.played, ['file:///one.wav']);
});

test('the list has a ceiling', () => {
  const p = new AgentSpeech({ synthesize: null, synth: null });
  p.sync(Array.from({ length: MAX_LIST + 50 }, (_, i) => ({ id: `q-${i}`, text: `turn ${i}` })));
  assert.equal(p.count, MAX_LIST);
});

test('turns with nothing to say are not turns', () => {
  const p = new AgentSpeech({ synthesize: null, synth: null });
  p.sync([{ id: 'a', text: 'real' }, { id: 'b', text: '   ' }, { id: 'c', text: null }, { id: 'd' }, null]);
  assert.equal(p.count, 1);
});

// ------------------------------------------------------- the transport

test('forward and back walk the list', async () => {
  const s = stage();
  const p = player(s);
  p.sync(turns('one', 'two', 'three'));
  p.playFrom();
  await settle();

  p.next();
  await settle();
  assert.equal(p.speakingId, '2');

  p.next();
  await settle();
  assert.equal(p.speakingId, '3');

  p.prev();
  await settle();
  assert.equal(p.speakingId, '2');

  assert.deepEqual(s.played, ['file:///one.wav', 'file:///two.wav', 'file:///three.wav', 'file:///two.wav']);
});

test('walking off either end stops rather than wrapping', async () => {
  const s = stage();
  const p = player(s);
  p.sync(turns('one', 'two'));
  p.playFrom();
  await settle();

  p.prev();
  await settle();
  assert.equal(p.status, IDLE, 'back from the first is the start, not the last');
  assert.equal(p.index, 0);

  p.playFrom('2');
  await settle();
  p.next();
  await settle();
  assert.equal(p.status, IDLE);
  assert.equal(p.index, 2, 'one past the end');

  // And back from there is the last thing said.
  p.prev();
  await settle();
  assert.equal(p.speakingId, '2');
});

test('play, pause and carry on are one button', async () => {
  const s = stage();
  const p = player(s);
  p.sync(turns('one', 'two'));

  assert.equal(p.status, IDLE);
  p.toggle();
  await settle();
  assert.equal(p.status, PLAYING);
  assert.equal(s.el.paused, false);

  p.toggle();
  assert.equal(p.status, PAUSED);
  assert.equal(s.el.paused, true, 'the audio really stops');

  p.toggle();
  await settle();
  assert.equal(p.status, PLAYING);
  assert.equal(s.el.paused, false, 'and really starts again');
  // Resuming continues the same turn rather than restarting the list.
  assert.equal(p.speakingId, '1');
  assert.deepEqual(s.played, ['file:///one.wav', 'file:///one.wav']);
});

test('a finished reading plays again from the top', async () => {
  const s = stage();
  const p = player(s);
  p.sync(turns('one'));
  p.playFrom();
  await settle();
  s.el.onended();
  await settle();
  assert.equal(p.status, IDLE);

  p.toggle();
  await settle();
  assert.equal(p.speakingId, '1');
});

test('the platform voice pauses and resumes too', async () => {
  const l = localStage();
  const p = new AgentSpeech({ synthesize: null, synth: l.synth, utterance: l.utterance });
  p.sync(turns('one'));
  p.playFrom();
  await settle();

  p.toggle();
  assert.equal(l.synth.paused, 1);
  p.toggle();
  assert.equal(l.synth.resumed, 1);
});

test('pausing an empty session does nothing rather than throwing', () => {
  const p = new AgentSpeech({ synthesize: null, synth: null });
  assert.equal(p.toggle(), false);
  assert.equal(p.next(), false);
  assert.equal(p.prev(), false);
  assert.equal(p.status, IDLE);
});

// -------------------------------------------------------------- live and the
// transport are the same list

test('a turn arriving live is read, and is then reachable with back', async () => {
  const s = stage();
  const p = player(s);

  // Two turns already in the transcript, then a third arrives.
  p.sync(turns('one', 'two'));
  p.sync([...turns('one', 'two'), { id: '3', text: 'three', voice: 'Kore' }]);
  p.speakNow('3');
  await settle();
  assert.deepEqual(s.played, ['file:///three.wav'], 'the new turn is what gets read');

  // The whole conversation is still behind it — this is what the old two-list
  // design got wrong, where Back after a live turn found nothing.
  p.prev();
  await settle();
  assert.equal(p.speakingId, '2');
});

test('a turn arriving mid-reading waits its place instead of interrupting', async () => {
  const s = stage();
  const d = deferredSynth();
  const p = player(s, { synthesize: d.synthesize });
  p.sync(turns('one', 'two'));
  p.playFrom();
  await settle();
  d.calls[0].resolve('file:///one.wav');
  await settle();

  p.sync([...turns('one', 'two'), { id: '3', text: 'three', voice: 'Kore' }]);
  assert.equal(p.speakNow('3'), false, 'something is already being read');
  assert.equal(p.speakingId, '1', 'and it is not disturbed');
  assert.equal(p.count, 3);
});

test('the cursor follows the turn it is on, not the index', async () => {
  const s = stage();
  const p = player(s);
  p.sync(turns('one', 'two', 'three'));
  p.playFrom('2');
  await settle();
  assert.equal(p.index, 1);

  // A message arrives above it — an import, or an error swept out further up.
  p.sync([{ id: '0', text: 'earlier', voice: 'Kore' }, ...turns('one', 'two', 'three')]);
  assert.equal(p.speakingId, '2', 'still reading the same sentence');
  assert.equal(p.index, 2, 'at its new position');
});

test('a turn that leaves the transcript stops the reading', async () => {
  const s = stage();
  const p = player(s);
  p.sync(turns('one', 'two', 'three'));
  p.playFrom('2');
  await settle();

  // The error being read is swept out from under it.
  p.sync([turns('one', 'two', 'three')[0], turns('one', 'two', 'three')[2]]);
  assert.equal(p.status, IDLE, 'it stops rather than reading whatever slid into place');
});

// -------------------------------------------------------------------- stopping

test('leaving the session stops the talking and forgets the list', async () => {
  const s = stage();
  const d = deferredSynth();
  const p = player(s, { synthesize: d.synthesize });
  p.sync(turns('one', 'two'));
  p.playFrom();
  await settle();
  d.calls[0].resolve('file:///one.wav');
  await settle();
  assert.equal(s.el.paused, false);

  p.clear();
  assert.equal(s.el.paused, true, 'the voice stops at once');
  assert.equal(p.count, 0);
  assert.equal(p.status, IDLE);
  assert.equal(p.speakingId, null);
});

test('audio that arrives after the session moved on is thrown away', async () => {
  const s = stage();
  const d = deferredSynth();
  const p = player(s, { synthesize: d.synthesize });
  p.sync(turns('late'));
  p.playFrom();
  await settle();

  p.clear();
  d.calls[0].resolve('file:///late.wav');
  await settle();
  assert.deepEqual(s.played, [], 'a sentence from the session you left must never play');
});

test('audio that arrives after the cursor moved is thrown away', async () => {
  const s = stage();
  const d = deferredSynth();
  const p = player(s, { synthesize: d.synthesize });
  p.sync(turns('one', 'two'));
  p.playFrom();
  await settle();

  // Pressing Forward before the first turn's audio came back.
  p.next();
  await settle();
  d.calls[0].resolve('file:///one.wav');
  await settle();
  assert.deepEqual(s.played, [], 'the skipped turn must not speak');

  d.calls[1].resolve('file:///two.wav');
  await settle();
  assert.deepEqual(s.played, ['file:///two.wav']);
});

test('the platform voice is cancelled too', async () => {
  const l = localStage();
  const p = new AgentSpeech({ synthesize: null, synth: l.synth, utterance: l.utterance });
  p.sync(turns('one'));
  p.playFrom();
  await settle();
  assert.equal(l.spoken.length, 1);

  p.clear();
  assert.equal(l.synth.cancelled >= 1, true);
});

// -------------------------------------------------------------------- the duck

test('the music is ducked once and lifted once, not per turn', async () => {
  const s = stage();
  const changes = [];
  const p = player(s, { onSpeaking: (on) => changes.push(on) });
  p.sync(turns('one', 'two', 'three'));
  p.playFrom();

  for (let i = 0; i < 3; i += 1) {
    await settle();
    s.el.onended?.();
  }
  await settle();
  assert.deepEqual(changes, [true, false]);
});

test('pausing lifts the duck, and carrying on puts it back', async () => {
  const s = stage();
  const changes = [];
  const p = player(s, { onSpeaking: (on) => changes.push(on) });
  p.sync(turns('one'));
  p.playFrom();
  await settle();

  p.toggle();
  p.toggle();
  await settle();
  assert.deepEqual(changes, [true, false, true], 'a pause is a request for quiet');
});

// ------------------------------------------------------------------- fallbacks

test('no online voice means the window speaks it instead', async () => {
  const l = localStage();
  const p = new AgentSpeech({
    // What speech.js returns when the engine is left alone: not an error, a
    // signal to use the local voice.
    synthesize: async () => null,
    synth: l.synth,
    utterance: l.utterance,
  });
  p.sync([{ id: 'a', text: 'Spoken locally.', voice: 'Kore' }]);
  p.playFrom();
  await settle();

  assert.equal(l.spoken.length, 1);
  assert.equal(l.utterances[0].text, 'Spoken locally.');
});

test('a synthesiser that throws is a fallback, not a stuck reading', async () => {
  const l = localStage();
  const p = new AgentSpeech({
    synthesize: async () => {
      throw new Error('network on fire');
    },
    synth: l.synth,
    utterance: l.utterance,
  });
  p.sync([{ id: 'a', text: 'Still said.', voice: 'Kore' }]);
  p.playFrom();
  await settle();
  assert.equal(l.spoken.length, 1);
});

test('the local voice is matched by name, and a missing one is not fatal', async () => {
  const l = localStage();
  l.synth.voices = [
    { name: 'Alice', lang: 'en-GB' },
    { name: 'Bob', lang: 'en-GB' },
  ];
  const p = new AgentSpeech({ synthesize: null, synth: l.synth, utterance: l.utterance });
  p.sync([
    { id: 'a', text: 'One.', localVoice: 'Bob' },
    { id: 'b', text: 'Two.', localVoice: 'Nobody' },
  ]);
  p.playFrom();
  await settle();
  assert.equal(l.utterances[0].voice.name, 'Bob');

  l.utterances[0].onend();
  await settle();
  // A voice that has gone is the default voice, not a failure.
  assert.equal(l.utterances[1].voice, null);
  assert.equal(l.spoken.length, 2);
});

test('a file that will not decode skips the turn rather than stopping the reading', async () => {
  const s = stage();
  const p = player(s);
  p.sync(turns('one', 'two'));
  p.playFrom();
  await settle();
  s.el.onerror();
  await settle();
  assert.deepEqual(s.played, ['file:///one.wav', 'file:///two.wav']);
});

test('a window with no audio at all does not wedge the reading', async () => {
  const p = new AgentSpeech({
    synthesize: async () => 'file:///a.wav',
    // No AudioContext to be had — a headless window, or audio in use elsewhere.
    context: () => null,
    synth: null,
  });
  p.sync(turns('one', 'two'));
  p.playFrom();
  await settle();
  await settle();
  assert.equal(p.status, IDLE, 'the list must drain rather than jam');
});

// -------------------------------------------------------------------- the clock

test('a turn that never reports finishing does not gag the rest', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = stage();
  const p = player(s);
  p.sync(turns('one', 'two'));
  p.playFrom();
  await settle();
  assert.deepEqual(s.played, ['file:///one.wav']);

  t.mock.timers.tick(MAX_UTTERANCE_MS + 1);
  await settle();
  assert.deepEqual(s.played, ['file:///one.wav', 'file:///two.wav']);
});

test('a paused turn is not skipped by the clock', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = stage();
  const p = player(s);
  p.sync(turns('one', 'two'));
  p.playFrom();
  await settle();

  p.toggle(); // paused — nothing is being said for the cap to be a cap on
  t.mock.timers.tick(MAX_UTTERANCE_MS * 2);
  await settle();
  assert.equal(p.status, PAUSED);
  assert.equal(p.speakingId, '1', 'still where it was left');
  assert.deepEqual(s.played, ['file:///one.wav']);
});

// -------------------------------------------------------------------- the volume

test('the volume is clamped and reaches the gain', async () => {
  const s = stage();
  const p = player(s);
  p.sync(turns('one'));
  p.playFrom();
  await settle();

  p.setVolume(0.5);
  assert.equal(s.gain.gain.value, 0.5);
  p.setVolume(9);
  assert.equal(s.gain.gain.value, 1);
  p.setVolume(-3);
  assert.equal(s.gain.gain.value, 0);
  p.setVolume('nonsense');
  assert.equal(s.gain.gain.value, 0);
});

test('the local voice takes the volume too', async () => {
  const l = localStage();
  const p = new AgentSpeech({ synthesize: null, synth: l.synth, utterance: l.utterance });
  p.setVolume(0.4);
  p.sync(turns('one'));
  p.playFrom();
  await settle();
  assert.equal(l.utterances[0].volume, 0.4);
});

// ------------------------------------------------------------------ the window

test('the window is told whenever the position moves, not only the status', async () => {
  const s = stage();
  let draws = 0;
  const p = player(s, { onChange: () => (draws += 1) });
  p.sync(turns('one', 'two'));
  p.playFrom();
  await settle();
  const atFirst = draws;

  s.el.onended();
  await settle();
  // The status is still 'playing' — only the turn changed. Announcing only on a
  // status change would freeze the position line and the lit bubble on turn one.
  assert.ok(draws > atFirst, 'moving to the next turn must redraw');
});

// ------------------------------------------- the local voice, made reliable
//
// Two documented Chromium faults sat behind "it reads the first bubble and
// stops" and "switching session leaves the old one playing". Both are pinned
// here, because both are invisible until somebody listens to a long discussion.

// A synth that reports its state honestly and — like the real one when an
// utterance has been collected — never fires onend.
function wedgedSynth() {
  const spoken = [];
  const synth = {
    speaking: false,
    pending: false,
    cancelled: 0,
    voices: [],
    getVoices() {
      return this.voices;
    },
    speak(u) {
      spoken.push(u);
      this.speaking = true;
    },
    // What Chromium does when the utterance has been garbage-collected: the
    // speech ends, `speaking` goes false, and no event is ever delivered.
    finishSilently() {
      this.speaking = false;
      this.pending = false;
    },
    pause() {},
    resume() {},
    cancel() {
      this.cancelled += 1;
      this.speaking = false;
      this.pending = false;
    },
  };
  const utterances = [];
  const utterance = (text) => {
    const u = { text, volume: null, voice: null, onend: null, onerror: null };
    utterances.push(u);
    return u;
  };
  return { synth, utterance, spoken, utterances };
}

// A clock the test winds by hand, so the watchdog can be driven without waiting.
function clock() {
  let at = 0;
  const timers = new Map();
  let next = 1;
  return {
    now: () => at,
    setInterval: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, ms, last: at });
      return id;
    },
    clearInterval: (id) => timers.delete(id),
    // Advance time and fire every interval that came due.
    tick(ms) {
      at += ms;
      for (const t of [...timers.values()]) {
        while (at - t.last >= t.ms) {
          t.last += t.ms;
          t.fn();
        }
      }
    },
  };
}

test('a local turn whose onend never fires still moves the reading on', async () => {
  // The bug exactly: Chromium collects the utterance, no event arrives, and the
  // reading used to sit on the first bubble forever.
  const l = wedgedSynth();
  const c = clock();
  const p = new AgentSpeech({
    synthesize: null,
    synth: l.synth,
    utterance: l.utterance,
    setInterval: c.setInterval,
    clearInterval: c.clearInterval,
    now: c.now,
  });
  p.sync([
    { id: 'a', text: 'First turn.' },
    { id: 'b', text: 'Second turn.' },
  ]);
  p.playFrom();
  await settle();
  assert.equal(p.speakingId, 'a');

  // The speech really ends; the event simply never comes.
  l.synth.finishSilently();
  c.tick(SYNTH_GRACE_MS + SYNTH_POLL_MS * 2);
  await settle();

  assert.equal(p.speakingId, 'b', 'the watchdog must carry the reading on');
});

test('a turn that has not started yet is not mistaken for one that has ended', async () => {
  const l = wedgedSynth();
  const c = clock();
  const p = new AgentSpeech({
    synthesize: null,
    synth: l.synth,
    utterance: l.utterance,
    setInterval: c.setInterval,
    clearInterval: c.clearInterval,
    now: c.now,
  });
  // `speaking` stays false, as it does in the moment between speak() and the
  // voice actually starting.
  l.synth.speak = function (u) {
    l.spoken.push(u);
  };
  p.sync([
    { id: 'a', text: 'First.' },
    { id: 'b', text: 'Second.' },
  ]);
  p.playFrom();
  await settle();

  // Inside the grace period nothing may be concluded.
  c.tick(SYNTH_GRACE_MS - 1);
  await settle();
  assert.equal(p.speakingId, 'a');
});

test('the utterance is held where the collector cannot reach it', async () => {
  // The one-line fix for the one-line bug: an utterance referenced only by its
  // own handlers can be collected before it speaks.
  const l = wedgedSynth();
  const p = new AgentSpeech({ synthesize: null, synth: l.synth, utterance: l.utterance });
  p.sync([{ id: 'a', text: 'Held.' }]);
  p.playFrom();
  await settle();

  assert.ok(p.utterance, 'the in-flight utterance must be reachable from the player');
  assert.equal(p.utterance, l.utterances[0]);

  p.clear();
  assert.equal(p.utterance, null, 'and released when there is nothing being said');
});

test('a long turn is spoken in pieces, and only the last one ends it', async () => {
  // Long text fails silently and wedges the whole API, so no single utterance is
  // ever allowed to be long.
  const l = wedgedSynth();
  const long = 'This is a sentence of a perfectly ordinary length. '.repeat(12);
  assert.ok(long.length > LOCAL_CHUNK_CHARS * 2);

  const p = new AgentSpeech({ synthesize: null, synth: l.synth, utterance: l.utterance });
  p.sync([
    { id: 'a', text: long },
    { id: 'b', text: 'After.' },
  ]);
  p.playFrom();
  await settle();

  assert.equal(l.spoken.length, 1, 'one piece at a time');
  for (const u of l.utterances) assert.ok(u.text.length <= LOCAL_CHUNK_CHARS);

  // Work through the pieces; the turn must not end until the last of them does.
  let guard = 0;
  while (p.speakingId === 'a' && guard < 50) {
    guard += 1;
    const u = l.utterances[l.utterances.length - 1];
    u.onend();
    await settle();
  }
  assert.ok(l.utterances.length > 2, 'a long turn really was split');
  assert.equal(p.speakingId, 'b', 'and it moved on exactly once, at the end');
});

test('every piece of a turn is spoken in that turn s voice', async () => {
  const l = wedgedSynth();
  l.synth.voices = [
    { name: 'Alice', lang: 'en' },
    { name: 'Bob', lang: 'en' },
  ];
  const p = new AgentSpeech({ synthesize: null, synth: l.synth, utterance: l.utterance });
  p.sync([{ id: 'a', text: 'One sentence. '.repeat(30), localVoice: 'Bob' }]);
  p.playFrom();
  await settle();

  for (let i = 0; i < 3; i += 1) {
    assert.equal(l.utterances[i].voice.name, 'Bob');
    l.utterances[i].onend();
    await settle();
  }
});

test('the window s shared synth queue is emptied before anything new is said', async () => {
  // One queue for the whole window: a stale utterance left in it is what bled
  // across a session change.
  const l = wedgedSynth();
  const p = new AgentSpeech({ synthesize: null, synth: l.synth, utterance: l.utterance });
  p.sync([{ id: 'a', text: 'One.' }]);
  p.playFrom();
  await settle();
  assert.ok(l.synth.cancelled >= 1, 'cancel() before speak()');
});

test('chunkText breaks at sentence ends, and never mid-word', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('Short.'), ['Short.']);

  const pieces = chunkText('This is one. This is two. This is three. '.repeat(20));
  for (const piece of pieces) {
    assert.ok(piece.length <= LOCAL_CHUNK_CHARS, 'no piece may exceed the budget');
    assert.ok(piece.trim() === piece);
  }
  // Nothing is lost or invented on the way through.
  const source = 'This is one. This is two. This is three. '.repeat(20).trim();
  assert.equal(pieces.join(' ').replace(/\s+/g, ' '), source.replace(/\s+/g, ' '));

  // A single unbroken run still has to be cut somewhere.
  const wall = 'x'.repeat(LOCAL_CHUNK_CHARS * 3);
  for (const piece of chunkText(wall)) assert.ok(piece.length <= LOCAL_CHUNK_CHARS);
});

// -------------------------------------------------- switching session

test('being handed a different session resets everything, with no clear() first', async () => {
  // The refresh used to depend on two React effects firing in the right order.
  // It is now a property of the player, so this deliberately never calls
  // clear() — that is the whole point of the test.
  const s = stage();
  const l = wedgedSynth();
  const p = player(s, { synth: l.synth, utterance: l.utterance });

  p.sync(turns('one', 'two', 'three'), { sessionId: 'session:A' });
  p.playFrom();
  await settle();
  assert.equal(p.count, 3);
  assert.equal(p.status, PLAYING);

  p.sync([{ id: 'b1', text: 'A different conversation.' }], { sessionId: 'session:B' });

  assert.equal(p.count, 1, 'the new session, not the old one');
  assert.equal(p.speakingId, null);
  assert.equal(p.status, IDLE, 'and it is not still reading');
  assert.equal(p.index, 0, 'the cursor starts again');
  assert.equal(s.el.paused, true, 'whatever was playing has stopped');
  assert.ok(l.synth.cancelled >= 1, 'including anything left in the shared queue');

  // Play now reads the session you are looking at.
  p.playFrom();
  await settle();
  assert.equal(p.speakingId, 'b1');
});

test('the same session is not a reset, so a reading survives new messages', async () => {
  const s = stage();
  const p = player(s);
  p.sync(turns('one', 'two'), { sessionId: 'session:A' });
  p.playFrom('2');
  await settle();

  p.sync([...turns('one', 'two'), { id: '3', text: 'three', voice: 'Kore' }], {
    sessionId: 'session:A',
  });
  assert.equal(p.speakingId, '2', 'still reading');
  assert.equal(p.count, 3);
});

test('sync without a session says nothing about the session', async () => {
  // The argument is optional, so every existing caller keeps working.
  const s = stage();
  const p = player(s);
  p.sync(turns('one', 'two'), { sessionId: 'session:A' });
  p.playFrom();
  await settle();
  p.sync(turns('one', 'two', 'three'));
  assert.equal(p.speakingId, '1', 'omitting it must not reset anything');
  assert.equal(p.count, 3);
});

// ------------------------------------------------------- which voice spoke

test('the engine reported is the one that actually spoke', async () => {
  const s = stage();
  const l = wedgedSynth();

  // Audio came back with no engine named (a bare url, the shape the audition
  // uses): Gemini, the default for a caller that does not report one.
  const online = player(s, { synth: l.synth, utterance: l.utterance });
  online.sync(turns('one'));
  online.playFrom();
  await settle();
  assert.equal(online.engine, GEMINI);

  // Audio came back naming xAI: the transport must say what actually spoke, not
  // assume Gemini. This is the bug the screenshot showed — "Reading with xAI" in
  // Settings, "· Gemini" in the panel.
  const grok = new AgentSpeech({
    synthesize: async () => ({ url: 'file:///one.wav', engine: 'xai' }),
    context: s.context,
    element: s.element,
    synth: l.synth,
    utterance: l.utterance,
  });
  grok.sync(turns('one'));
  grok.playFrom();
  await settle();
  assert.equal(grok.engine, XAI, 'the engine named by main is the one reported');

  // Nothing came back — the engine is off, or the key failed, or the machine is
  // offline. It is read locally, and it says local even though an online engine
  // is what was asked for.
  const fell = new AgentSpeech({
    synthesize: async () => null,
    context: s.context,
    element: s.element,
    synth: l.synth,
    utterance: l.utterance,
  });
  fell.sync(turns('one'));
  fell.playFrom();
  await settle();
  assert.equal(fell.engine, LOCAL, 'a silent fallback must not claim to be an online engine');
});

// ------------------------------------------------------------ the loading state

test('pending is true while a turn is being fetched and false once it settles', async () => {
  const s = stage();
  const d = deferredSynth();
  const p = player(s, { synthesize: d.synthesize });
  p.sync(turns('one', 'two'));

  p.playFrom();
  await settle();
  assert.equal(p.pending, true, 'the fetch is in flight — the bar should show');

  d.calls[0].resolve('file:///one.wav');
  await settle();
  assert.equal(p.pending, false, 'the audio arrived — the bar goes');
});

test('a fetch abandoned by a cursor move does not leave pending stuck on', async () => {
  const s = stage();
  const d = deferredSynth();
  const p = player(s, { synthesize: d.synthesize });
  p.sync(turns('one', 'two'));

  p.playFrom();
  await settle();
  assert.equal(p.pending, true);

  // The cursor moves before the first turn's audio arrives. The second fetch now
  // owns the loading state; the first, resolving late, must not clear it.
  p.next();
  await settle();
  assert.equal(p.pending, true, 'the second turn is now the one being fetched');

  d.calls[0].resolve('file:///one.wav'); // the abandoned one, arriving late
  await settle();
  assert.equal(p.pending, true, 'a stale result must not blank the current bar');

  d.calls[1].resolve('file:///two.wav');
  await settle();
  assert.equal(p.pending, false);
});

test('clear stops a pending fetch from holding the bar on', async () => {
  const s = stage();
  const d = deferredSynth();
  const p = player(s, { synthesize: d.synthesize });
  p.sync(turns('one'));

  p.playFrom();
  await settle();
  assert.equal(p.pending, true);

  p.clear();
  assert.equal(p.pending, false, 'nobody is listening — the bar is gone');

  // The abandoned fetch resolving afterwards must not turn it back on.
  d.calls[0].resolve('file:///one.wav');
  await settle();
  assert.equal(p.pending, false);
});

test('a local-only reading never raises the loading bar', async () => {
  const s = stage();
  const l = wedgedSynth();
  // No synthesize at all: the local path has nothing to fetch, so there is no
  // gap and nothing to show.
  const p = new AgentSpeech({
    synthesize: null,
    context: s.context,
    element: s.element,
    synth: l.synth,
    utterance: l.utterance,
  });
  p.sync(turns('one'));
  p.playFrom();
  await settle();
  assert.equal(p.pending, false);
});

test('nothing has spoken yet is not a claim about either engine', () => {
  const p = new AgentSpeech({ synthesize: null, synth: null });
  assert.equal(p.engine, null);
});

// ------------------------------------------------------------------- the preview

test('the audition uses the real player and can be stopped', async () => {
  const stop = previewVoice({ synthesize: async () => null, voice: 'Zephyr', volume: 0.9 });
  assert.equal(typeof stop, 'function');
  assert.ok(PREVIEW_LINE.length > 20, 'long enough to hear the character of a voice');
  stop();
});

// ------------------------------------------------ preparing the whole session

test('with preload on, the whole session is synthesised before a word plays', async () => {
  const s = stage();
  const d = deferredSynth();
  const p = player(s, { synthesize: d.synthesize });
  p.setPreload(true);
  p.sync(turns('one', 'two', 'three'));

  p.playFrom();
  await settle();
  assert.deepEqual(p.prefetch, { done: 0, total: 3 }, 'preparing, none done yet');
  assert.deepEqual(s.played, [], 'nothing plays while the run is being prepared');

  d.calls[0].resolve('file:///one.wav');
  await settle();
  assert.deepEqual(p.prefetch, { done: 1, total: 3 }, 'the bar moves as each turn is warmed');
  assert.deepEqual(s.played, [], 'still nothing playing');

  d.calls[1].resolve('file:///two.wav');
  await settle();
  d.calls[2].resolve('file:///three.wav');
  await settle();
  assert.equal(p.prefetch, null, 'the run is warm, the prepare phase is over');

  // Playback then reads from the warm cache — one fetch per turn, which in the
  // app is a disk-cache hit. The first turn is the one now in flight.
  assert.deepEqual(s.played, []);
  d.calls[3].resolve('file:///one.wav');
  await settle();
  assert.deepEqual(s.played, ['file:///one.wav'], 'and now it plays, from the top');
});

test('cancelling a preload stops it without discarding the session', async () => {
  const s = stage();
  const d = deferredSynth();
  const p = player(s, { synthesize: d.synthesize });
  p.setPreload(true);
  p.sync(turns('one', 'two', 'three'));

  p.playFrom();
  await settle();
  assert.deepEqual(p.prefetch, { done: 0, total: 3 });

  // The button, pressed mid-prepare, calls it off.
  p.toggle();
  assert.equal(p.prefetch, null, 'the prepare is abandoned');
  assert.equal(p.status, IDLE);
  assert.equal(p.count, 3, 'the session is still there to play');

  // A late fetch from the abandoned prepare must not restart it.
  d.calls[0].resolve('file:///one.wav');
  await settle();
  assert.equal(p.prefetch, null);
  assert.deepEqual(s.played, []);
});

test('a skip during preload falls back to reading that turn straight away', async () => {
  const s = stage();
  const d = deferredSynth();
  const p = player(s, { synthesize: d.synthesize });
  p.setPreload(true);
  p.sync(turns('one', 'two', 'three'));

  p.playFrom();
  await settle();
  assert.deepEqual(p.prefetch, { done: 0, total: 3 });

  p.next(); // skipping cancels the prepare and reads the next turn the plain way
  await settle();
  assert.equal(p.prefetch, null, 'the prepare is abandoned');
  assert.equal(p.status, PLAYING);
  assert.equal(p.index, 1, 'and the cursor has moved on');
  assert.equal(p.pending, true, 'which is now fetched a turn at a time');
});

test('preload off starts the first turn at once, without a prepare phase', async () => {
  const s = stage();
  const d = deferredSynth();
  const p = player(s, { synthesize: d.synthesize });
  // preload defaults off
  p.sync(turns('one', 'two'));

  p.playFrom();
  await settle();
  assert.equal(p.prefetch, null, 'no prepare phase');
  assert.equal(p.pending, true, 'the first turn is fetched straight away');
});
