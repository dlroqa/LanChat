'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Reading a discussion aloud, turn by turn.
//
// The queue is the feature. Two agents in one round answer whenever their
// transports happen to finish, which is to say at the same moment — so the thing
// worth testing is that they are lined up rather than talked over each other,
// that leaving the session stops the talking, and that nothing said once is said
// again. None of that needs a renderer: the player takes its context, its
// element, its synthesiser and its utterance factory as arguments.
//
// ESM for the renderer, and it imports React for its hooks. Drop the imports and
// the `export` keywords and evaluate it, exactly as agentMusic.test.js does;
// nothing runs at module scope, so React and the AudioContext never have to
// exist. The two names the class really uses from other modules are passed in —
// clampVolume read out of the real agentMusic.js rather than reimplemented, so
// the two cannot drift.
const LIB = path.join(__dirname, '..', 'src', 'renderer', 'lib');
const strip = (src) => src.replace(/^import[^;]+;$/gm, '').replace(/^export\s+/gm, '');

const { clampVolume } = new Function(
  `${strip(fs.readFileSync(path.join(LIB, 'agentMusic.js'), 'utf8'))}
   return { clampVolume };`
)();

const { AgentSpeech, MAX_QUEUE, MAX_UTTERANCE_MS, PREVIEW_LINE, previewVoice } = new Function(
  'clampVolume',
  'audioContext',
  `${strip(fs.readFileSync(path.join(LIB, 'agentSpeech.js'), 'utf8'))}
   return { AgentSpeech, MAX_QUEUE, MAX_UTTERANCE_MS, PREVIEW_LINE, previewVoice };`
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
  // The same gain object every time, so the test can read the volume off it.
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
    getVoices() {
      return this.voices;
    },
    speak(u) {
      spoken.push(u);
    },
    cancel() {
      this.cancelled = (this.cancelled || 0) + 1;
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

// ------------------------------------------------------------------ one at a time

test('two agents answering at once are lined up, not talked over each other', async () => {
  const s = stage();
  const d = deferredSynth();
  const player = new AgentSpeech({
    synthesize: d.synthesize,
    context: s.context,
    element: s.element,
    synth: null,
  });

  player.enqueue({ id: 'a', text: 'First agent.', voice: 'Zephyr' });
  player.enqueue({ id: 'b', text: 'Second agent.', voice: 'Kore' });
  await settle();

  // Only the first has even been sent for synthesis.
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].text, 'First agent.');

  d.calls[0].resolve('file:///a.wav');
  await settle();
  assert.deepEqual(s.played, ['file:///a.wav']);
  assert.equal(d.calls.length, 1, 'the second must not start while the first is speaking');

  // The first finishes; the second follows.
  s.el.onended();
  await settle();
  assert.equal(d.calls.length, 2);
  d.calls[1].resolve('file:///b.wav');
  await settle();
  assert.deepEqual(s.played, ['file:///a.wav', 'file:///b.wav']);
});

test('turns are spoken in the order they arrived', async () => {
  const s = stage();
  const player = new AgentSpeech({
    synthesize: async (text) => `file:///${text}.wav`,
    context: s.context,
    element: s.element,
    synth: null,
  });

  for (const id of ['1', '2', '3']) player.enqueue({ id, text: id, voice: 'Kore' });
  for (let i = 0; i < 3; i += 1) {
    await settle();
    s.el.onended?.();
  }
  await settle();
  assert.deepEqual(s.played, ['file:///1.wav', 'file:///2.wav', 'file:///3.wav']);
});

// ---------------------------------------------------------------- saying it once

test('the same turn arriving twice is only spoken once', () => {
  const player = new AgentSpeech({ synthesize: null, synth: null });
  assert.equal(player.enqueue({ id: 'x', text: 'Once.', voice: 'Kore' }), true);
  assert.equal(player.enqueue({ id: 'x', text: 'Once.', voice: 'Kore' }), false);
});

test('an empty turn is not a turn', () => {
  const player = new AgentSpeech({ synthesize: null, synth: null });
  for (const text of ['', '   ', null, undefined]) {
    assert.equal(player.enqueue({ id: `e-${text}`, text, voice: 'Kore' }), false);
  }
});

test('replay says it again, but will not stack', async () => {
  const s = stage();
  const d = deferredSynth();
  const player = new AgentSpeech({
    synthesize: d.synthesize,
    context: s.context,
    element: s.element,
    synth: null,
  });

  player.enqueue({ id: 'x', text: 'Hear this.', voice: 'Kore' });
  await settle();
  d.calls[0].resolve('file:///x.wav');
  await settle();
  s.el.onended();
  await settle();

  // Said once; asking again is allowed.
  assert.equal(player.enqueue({ id: 'x', text: 'Hear this.', voice: 'Kore' }), false);
  assert.equal(player.replay({ id: 'x', text: 'Hear this.', voice: 'Kore' }), true);
  // But pressing the button twice does not queue it twice.
  assert.equal(player.replay({ id: 'x', text: 'Hear this.', voice: 'Kore' }), false);
});

test('the queue has a ceiling', () => {
  const s = stage();
  // Held on the first turn: a synthesis that never resolves is what stops the
  // queue draining as fast as it is filled, which is the only state in which a
  // backlog can exist to be bounded.
  const d = deferredSynth();
  const player = new AgentSpeech({
    synthesize: d.synthesize,
    context: s.context,
    element: s.element,
    synth: null,
  });

  let taken = 0;
  for (let i = 0; i < MAX_QUEUE + 10; i += 1) {
    if (player.enqueue({ id: `q-${i}`, text: `turn ${i}`, voice: 'Kore' })) taken += 1;
  }

  assert.equal(player.queue.length, MAX_QUEUE, 'the backlog stops at the ceiling');
  // One is being worked on; the rest of what was accepted is the queue itself.
  assert.equal(taken, MAX_QUEUE + 1);
});

// -------------------------------------------------------------------- stopping

test('leaving the session stops the talking and forgets the queue', async () => {
  const s = stage();
  const d = deferredSynth();
  const player = new AgentSpeech({
    synthesize: d.synthesize,
    context: s.context,
    element: s.element,
    synth: null,
  });

  player.enqueue({ id: 'a', text: 'One.', voice: 'Kore' });
  player.enqueue({ id: 'b', text: 'Two.', voice: 'Puck' });
  await settle();
  d.calls[0].resolve('file:///a.wav');
  await settle();
  assert.equal(s.el.paused, false);

  player.clear();
  assert.equal(s.el.paused, true, 'the voice stops at once');
  assert.equal(player.queue.length, 0);
  assert.equal(player.current, null);

  // And the one that was waiting never starts.
  await settle();
  assert.equal(d.calls.length, 1);
  assert.deepEqual(s.played, ['file:///a.wav']);
});

test('audio that arrives after the session moved on is thrown away', async () => {
  const s = stage();
  const d = deferredSynth();
  const player = new AgentSpeech({
    synthesize: d.synthesize,
    context: s.context,
    element: s.element,
    synth: null,
  });

  player.enqueue({ id: 'a', text: 'Late.', voice: 'Kore' });
  await settle();

  // The person switches session while Gemini is still thinking.
  player.clear();
  d.calls[0].resolve('file:///late.wav');
  await settle();

  assert.deepEqual(s.played, [], 'a sentence from the session you left must never play');
});

test('the platform voice is cancelled too', async () => {
  const l = localStage();
  const player = new AgentSpeech({ synthesize: null, synth: l.synth, utterance: l.utterance });

  player.enqueue({ id: 'a', text: 'Local.', voice: null });
  await settle();
  assert.equal(l.spoken.length, 1);

  player.clear();
  assert.equal(l.synth.cancelled, 1);
});

// -------------------------------------------------------------------- the duck

test('the music is ducked once and lifted once, not per turn', async () => {
  const s = stage();
  const changes = [];
  const player = new AgentSpeech({
    synthesize: async (text) => `file:///${text}.wav`,
    context: s.context,
    element: s.element,
    synth: null,
    onSpeaking: (on) => changes.push(on),
  });

  player.enqueue({ id: '1', text: '1', voice: 'Kore' });
  player.enqueue({ id: '2', text: '2', voice: 'Puck' });
  player.enqueue({ id: '3', text: '3', voice: 'Leda' });
  for (let i = 0; i < 3; i += 1) {
    await settle();
    s.el.onended?.();
  }
  await settle();

  // Down at the start of the run, up at the end of it — a discussion of three
  // turns must not flap the bed three times.
  assert.deepEqual(changes, [true, false]);
});

test('clearing lifts the duck', async () => {
  const s = stage();
  const changes = [];
  const d = deferredSynth();
  const player = new AgentSpeech({
    synthesize: d.synthesize,
    context: s.context,
    element: s.element,
    synth: null,
    onSpeaking: (on) => changes.push(on),
  });

  player.enqueue({ id: 'a', text: 'One.', voice: 'Kore' });
  await settle();
  assert.deepEqual(changes, [true]);

  player.clear();
  assert.deepEqual(changes, [true, false], 'the bed must not stay ducked forever');
});

// ------------------------------------------------------------------- fallbacks

test('no online voice means the window speaks it instead', async () => {
  const l = localStage();
  const player = new AgentSpeech({
    // What speech.js returns when the engine is left alone: not an error, a
    // signal to use the local voice.
    synthesize: async () => null,
    synth: l.synth,
    utterance: l.utterance,
  });

  player.enqueue({ id: 'a', text: 'Spoken locally.', voice: 'Kore', localVoice: null });
  await settle();

  assert.equal(l.spoken.length, 1);
  assert.equal(l.utterances[0].text, 'Spoken locally.');
});

test('a synthesiser that throws is a fallback, not a stuck queue', async () => {
  const l = localStage();
  const player = new AgentSpeech({
    synthesize: async () => {
      throw new Error('network on fire');
    },
    synth: l.synth,
    utterance: l.utterance,
  });

  player.enqueue({ id: 'a', text: 'Still said.', voice: 'Kore' });
  await settle();
  assert.equal(l.spoken.length, 1);
});

test('the local voice is matched by name, and a missing one is not fatal', async () => {
  const l = localStage();
  l.synth.voices = [
    { name: 'Alice', lang: 'en-GB' },
    { name: 'Bob', lang: 'en-GB' },
  ];
  const player = new AgentSpeech({ synthesize: null, synth: l.synth, utterance: l.utterance });

  player.enqueue({ id: 'a', text: 'One.', voice: null, localVoice: 'Bob' });
  await settle();
  assert.equal(l.utterances[0].voice.name, 'Bob');

  l.utterances[0].onend();
  player.enqueue({ id: 'b', text: 'Two.', voice: null, localVoice: 'Nobody' });
  await settle();
  // A voice that has gone is the default voice, not a failure.
  assert.equal(l.utterances[1].voice, null);
  assert.equal(l.spoken.length, 2);
});

test('a file that will not decode skips the turn rather than stopping the queue', async () => {
  const s = stage();
  const player = new AgentSpeech({
    synthesize: async (text) => `file:///${text}.wav`,
    context: s.context,
    element: s.element,
    synth: null,
  });

  player.enqueue({ id: '1', text: '1', voice: 'Kore' });
  player.enqueue({ id: '2', text: '2', voice: 'Puck' });
  await settle();
  // The first one is broken.
  s.el.onerror();
  await settle();
  s.el.onended?.();
  await settle();

  assert.deepEqual(s.played, ['file:///1.wav', 'file:///2.wav']);
});

test('a window with no audio at all does not wedge the queue', async () => {
  const player = new AgentSpeech({
    synthesize: async () => 'file:///a.wav',
    // No AudioContext to be had — a headless window, or audio in use elsewhere.
    context: () => null,
    synth: null,
  });

  player.enqueue({ id: 'a', text: 'One.', voice: 'Kore' });
  player.enqueue({ id: 'b', text: 'Two.', voice: 'Puck' });
  await settle();
  await settle();

  assert.equal(player.current, null, 'the queue must drain rather than jam');
});

// -------------------------------------------------------------------- the clock

test('a turn that never reports finishing does not gag the rest', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = stage();
  const player = new AgentSpeech({
    synthesize: async (text) => `file:///${text}.wav`,
    context: s.context,
    element: s.element,
    synth: null,
  });

  player.enqueue({ id: '1', text: '1', voice: 'Kore' });
  player.enqueue({ id: '2', text: '2', voice: 'Puck' });
  await settle();
  assert.deepEqual(s.played, ['file:///1.wav']);

  // Nothing ever fires onended.
  t.mock.timers.tick(MAX_UTTERANCE_MS + 1);
  await settle();

  assert.deepEqual(s.played, ['file:///1.wav', 'file:///2.wav']);
});

// -------------------------------------------------------------------- the volume

test('the volume is clamped and reaches the gain', async () => {
  const s = stage();
  const player = new AgentSpeech({
    synthesize: async () => 'file:///a.wav',
    context: s.context,
    element: s.element,
    synth: null,
  });

  player.enqueue({ id: 'a', text: 'One.', voice: 'Kore' });
  await settle();
  player.setVolume(0.5);
  assert.equal(s.gain.gain.value, 0.5);

  player.setVolume(9);
  assert.equal(s.gain.gain.value, 1);
  player.setVolume(-3);
  assert.equal(s.gain.gain.value, 0);
  player.setVolume('nonsense');
  assert.equal(s.gain.gain.value, 0);
});

test('the local voice takes the volume too', async () => {
  const l = localStage();
  const player = new AgentSpeech({ synthesize: null, synth: l.synth, utterance: l.utterance });
  player.setVolume(0.4);

  player.enqueue({ id: 'a', text: 'One.', voice: null });
  await settle();
  assert.equal(l.utterances[0].volume, 0.4);
});

// ------------------------------------------------------------------- the preview

test('the audition uses the real player and can be stopped', async () => {
  const stop = previewVoice({ synthesize: async () => null, voice: 'Zephyr', volume: 0.9 });
  assert.equal(typeof stop, 'function');
  assert.ok(PREVIEW_LINE.length > 20, 'long enough to hear the character of a voice');
  stop();
});
