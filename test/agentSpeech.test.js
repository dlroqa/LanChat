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

const { AgentSpeech, MAX_LIST, MAX_UTTERANCE_MS, PREVIEW_LINE, previewVoice, IDLE, PLAYING, PAUSED } =
  new Function(
    'clampVolume',
    'audioContext',
    `${strip(fs.readFileSync(path.join(LIB, 'agentSpeech.js'), 'utf8'))}
   return { AgentSpeech, MAX_LIST, MAX_UTTERANCE_MS, PREVIEW_LINE, previewVoice, IDLE, PLAYING, PAUSED };`
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

// ------------------------------------------------------------------- the preview

test('the audition uses the real player and can be stopped', async () => {
  const stop = previewVoice({ synthesize: async () => null, voice: 'Zephyr', volume: 0.9 });
  assert.equal(typeof stop, 'function');
  assert.ok(PREVIEW_LINE.length > 20, 'long enough to hear the character of a voice');
  stop();
});
