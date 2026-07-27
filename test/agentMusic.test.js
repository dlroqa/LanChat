'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The music bed's two edges are the whole feature, and both of them are timing:
// a fade that keeps its slope when it is interrupted, and a fade-out that can be
// turned around before it has paused anything. Neither needs a renderer to be
// checked — the maths is plain functions and the state machine takes its context
// and its element as arguments — so both are tested here.
//
// ESM for the renderer, and it imports React for its hook. Drop the imports and
// the `export` keywords and evaluate it; nothing runs at module scope, so React
// and the AudioContext never have to exist.
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'lib', 'agentMusic.js'), 'utf8');
const { fadeMs, clampVolume, AgentMusic, FADE_IN_MS, FADE_OUT_MS, MIN_FADE_MS } = new Function(
  `${SRC.replace(/^import[^;]+;$/gm, '').replace(/^export\s+/gm, '')}
   return { fadeMs, clampVolume, AgentMusic, FADE_IN_MS, FADE_OUT_MS, MIN_FADE_MS };`
)();

// The track list is built by a Vite glob, which plain Node cannot parse — so the
// one `import.meta` expression is swapped for a fixture and everything built on
// top of it is the real code. That is the part worth testing: what a dropped-in
// file ends up called, and which URL a saved setting resolves to.
function loadTracks(fixture) {
  const src = fs
    .readFileSync(path.join(ROOT, 'src', 'renderer', 'lib', 'agentMusicTrack.js'), 'utf8')
    .replace(/const found = import\.meta\.glob\([\s\S]*?\n\}\);/, 'const found = FIXTURE;')
    .replace(/^export\s+/gm, '');
  return new Function(
    'FIXTURE',
    `${src}
     return { TRACKS, TRACK_KEYS, HAS_TRACK, DEFAULT_TRACK, trackUrl, trackKey, trackLabel };`
  )(fixture);
}

const SAMPLE = {
  '../assets/music/sleepy-island.opus': '/assets/sleepy-island-h4sh.opus',
  '../assets/music/agent-loop.opus': '/assets/agent-loop-DWlj.opus',
};

test('a dropped-in file is named after itself, in sentence case', () => {
  const { trackKey, trackLabel } = loadTracks({});
  assert.strictEqual(trackKey('../assets/music/sleepy-island.opus'), 'sleepy-island');
  assert.strictEqual(trackLabel('sleepy-island'), 'Sleepy island');
  assert.strictEqual(trackLabel('agent_loop'), 'Agent loop');
  assert.strictEqual(trackLabel('lofi  beats'), 'Lofi beats');
});

test('the track list is sorted, so the dropdown does not reshuffle between builds', () => {
  const { TRACK_KEYS, TRACKS, DEFAULT_TRACK, HAS_TRACK } = loadTracks(SAMPLE);
  assert.deepStrictEqual(TRACK_KEYS, ['agent-loop', 'sleepy-island']);
  assert.strictEqual(TRACKS['sleepy-island'].label, 'Sleepy island');
  assert.strictEqual(DEFAULT_TRACK, 'agent-loop');
  assert.strictEqual(HAS_TRACK, true);
});

test('a build with no music has no tracks and nothing to default to', () => {
  const { TRACK_KEYS, HAS_TRACK, DEFAULT_TRACK, trackUrl } = loadTracks({});
  assert.deepStrictEqual(TRACK_KEYS, []);
  assert.strictEqual(HAS_TRACK, false);
  assert.strictEqual(DEFAULT_TRACK, null);
  assert.strictEqual(trackUrl(null, null), null, 'nothing to play is silence, not a throw');
});

test('a saved setting resolves to the right url, and an unknown one falls back', () => {
  const { trackUrl } = loadTracks(SAMPLE);
  assert.strictEqual(trackUrl('sleepy-island', null), '/assets/sleepy-island-h4sh.opus');
  assert.strictEqual(trackUrl('custom', 'http://localhost:47100/x'), 'http://localhost:47100/x');
  // Custom chosen but no file picked yet — silence, and the toggle stays usable.
  assert.strictEqual(trackUrl('custom', null), null);
  // A track that was removed from the build since the setting was saved.
  assert.strictEqual(trackUrl('deleted-track', null), '/assets/agent-loop-DWlj.opus');
  // Never chosen at all.
  assert.strictEqual(trackUrl(null, null), '/assets/agent-loop-DWlj.opus');
});

// Enough of the Web Audio graph to watch the ramps go by. The audio thread would
// take until `at` to arrive; the tests only need where it was told to go.
function fakeAudio() {
  const ramps = [];
  const param = {
    value: 0,
    cancelAndHoldAtTime(t) {
      ramps.push({ kind: 'hold', at: t, from: param.value });
    },
    cancelScheduledValues() {},
    setValueAtTime(v) {
      param.value = v;
      ramps.push({ kind: 'set', to: v });
    },
    linearRampToValueAtTime(v, at) {
      param.value = v;
      ramps.push({ kind: 'ramp', to: v, at });
    },
  };
  const node = { connect: (next) => next, disconnect() {} };
  return {
    ramps,
    ctx: {
      currentTime: 0,
      createGain: () => ({ gain: param, connect: node.connect, disconnect: node.disconnect }),
      createMediaElementSource: () => node,
      destination: {},
    },
  };
}

function fakeElement() {
  return {
    loop: false,
    preload: '',
    // Somewhere in the middle of the loop, so a rewind would be visible.
    currentTime: 12.5,
    plays: 0,
    pauses: 0,
    play() {
      this.plays += 1;
      return Promise.resolve();
    },
    pause() {
      this.pauses += 1;
    },
  };
}

function make() {
  const audio = fakeAudio();
  const el = fakeElement();
  const music = new AgentMusic({
    url: 'agent-loop.mp3',
    context: () => audio.ctx,
    element: () => el,
  });
  return { music, el, audio };
}

test('volume is clamped, and anything that is not a number is silence', () => {
  assert.strictEqual(clampVolume(0.5), 0.5);
  assert.strictEqual(clampVolume(-1), 0);
  assert.strictEqual(clampVolume(4), 1);
  assert.strictEqual(clampVolume(undefined), 0);
  assert.strictEqual(clampVolume('loud'), 0);
});

test('a fade across the whole range takes the whole time', () => {
  assert.strictEqual(fadeMs(0, 0.5, FADE_IN_MS, 0.5), FADE_IN_MS);
  assert.strictEqual(fadeMs(0.5, 0, FADE_OUT_MS, 0.5), FADE_OUT_MS);
});

test('a fade interrupted halfway keeps the slope, not the duration', () => {
  assert.strictEqual(fadeMs(0.25, 0.5, FADE_IN_MS, 0.5), FADE_IN_MS / 2);
  assert.strictEqual(fadeMs(0.1, 0, FADE_OUT_MS, 0.5), Math.round(FADE_OUT_MS * 0.2));
});

test('no fade is ever instant, and none is asked for when there is nowhere to go', () => {
  assert.strictEqual(fadeMs(0.5, 0.5, FADE_IN_MS, 0.5), 0);
  assert.ok(fadeMs(0, 0.0001, FADE_IN_MS, 0.5) >= MIN_FADE_MS);
  // The slider at zero must not divide by it.
  assert.strictEqual(fadeMs(0, 0, FADE_OUT_MS, 0), 0);
  assert.strictEqual(fadeMs(0.2, 0, FADE_OUT_MS, 0), MIN_FADE_MS);
});

test('work finishing fades out for longer than work starting fades in', () => {
  assert.ok(FADE_OUT_MS > FADE_IN_MS);
});

test('with no track bundled, starting builds nothing at all', () => {
  const music = new AgentMusic({
    url: null,
    context: () => assert.fail('an absent track must not open an AudioContext'),
    element: () => assert.fail('an absent track must not create an element'),
  });
  assert.strictEqual(music.available, false);
  music.start();
  music.stop();
});

test('starting fades up to the configured volume and plays a looping element', () => {
  const { music, el, audio } = make();
  music.setVolume(0.4);
  music.start();
  assert.strictEqual(el.loop, true);
  assert.strictEqual(el.plays, 1);
  const last = audio.ramps.at(-1);
  assert.strictEqual(last.kind, 'ramp');
  assert.strictEqual(last.to, 0.4);
  assert.strictEqual(last.at, FADE_IN_MS / 1000);
});

test('work starting again during the fade-out never pauses and never rewinds', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { music, el } = make();
  music.setVolume(0.5);
  music.start();
  assert.strictEqual(el.plays, 1);

  music.stop();
  t.mock.timers.tick(200); // mid fade-out
  music.start();
  t.mock.timers.tick(5000); // well past where the pause would have been

  assert.strictEqual(el.pauses, 0, 'the pending pause must have been cancelled');
  assert.strictEqual(el.currentTime, 12.5, 'the track must not be rewound');
});

test('a fade-out that is allowed to finish pauses, and still does not rewind', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { music, el } = make();
  music.setVolume(0.5);
  music.start();
  music.stop();
  t.mock.timers.tick(FADE_OUT_MS + 500);
  assert.strictEqual(el.pauses, 1);
  assert.strictEqual(el.currentTime, 12.5);
});

test('stopping something that was never started does nothing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { music, el } = make();
  music.stop();
  music.start();
  music.stop();
  music.stop(); // the second one has nothing left to do
  t.mock.timers.tick(FADE_OUT_MS + 500);
  assert.strictEqual(el.pauses, 1, 'one stop, one pause');
});

test('the volume slider is followed while the bed is playing, and remembered when it is not', () => {
  const { music, audio } = make();
  music.setVolume(0.3);
  // Nothing is playing yet, so there is no ramp to make — just a value to keep.
  assert.strictEqual(audio.ramps.length, 0);
  assert.strictEqual(music.volume, 0.3);

  music.start();
  const beforeDrag = audio.ramps.length;
  music.setVolume(0.9);
  assert.ok(audio.ramps.length > beforeDrag, 'dragging mid-run must be audible immediately');
  assert.strictEqual(audio.ramps.at(-1).to, 0.9);
});

test('disposing pauses, drops the element, and lets a later start build a fresh one', () => {
  const { music, el } = make();
  music.start();
  music.dispose();
  assert.strictEqual(el.pauses, 1);
  assert.strictEqual(music.el, null, 'a MediaElementAudioSourceNode cannot be made twice');
  assert.strictEqual(music.wanted, false);
});

test('switching track tears down the old element and builds a fresh one', () => {
  const els = [];
  const audio = fakeAudio();
  const music = new AgentMusic({
    url: 'one.opus',
    context: () => audio.ctx,
    element: () => {
      const el = fakeElement();
      els.push(el);
      return el;
    },
  });
  music.setVolume(0.5);
  music.start();
  assert.strictEqual(els.length, 1);

  // Same track again is not a reason to restart anything.
  music.setUrl('one.opus');
  assert.strictEqual(els.length, 1, 'setting the same url must be a no-op');

  // A different one keeps playing, on a new element — a source node cannot be
  // made twice for the same element, so reusing it would throw.
  music.setUrl('two.opus');
  assert.strictEqual(els.length, 2, 'a new track needs a new element');
  assert.strictEqual(els[0].pauses, 1, 'the old track is stopped');
  assert.strictEqual(els[1].plays, 1, 'the new one starts');
  assert.strictEqual(music.url, 'two.opus');
});

test('switching track while idle does not start playing', () => {
  const els = [];
  const audio = fakeAudio();
  const music = new AgentMusic({
    url: 'one.opus',
    context: () => audio.ctx,
    element: () => {
      const el = fakeElement();
      els.push(el);
      return el;
    },
  });
  music.setUrl('two.opus');
  assert.strictEqual(els.length, 0, 'nothing was playing, so nothing should start');
  assert.strictEqual(music.wanted, false);
});

test('the music keys are plumbed all three ways, including the return of publicConfig', () => {
  const defaults = fs.readFileSync(path.join(ROOT, 'src', 'main', 'config.js'), 'utf8');
  const ipc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc.js'), 'utf8');
  for (const key of ['agentMusicEnabled', 'agentMusic', 'agentMusicVolume', 'customAgentMusicPath']) {
    assert.match(defaults, new RegExp(`^\\s*${key}:`, 'm'), `${key} is missing from DEFAULTS`);
    assert.match(ipc, new RegExp(`'${key}'`), `${key} is missing from the setConfig allowlist`);
    // Once to take it off config.data and once to put it on the wire. A key that
    // is destructured and not returned saves correctly and reads back undefined,
    // which looks exactly like the setting not working.
    const mentions = ipc.split(new RegExp(`\\b${key}\\b`)).length - 1;
    assert.ok(mentions >= 3, `${key} appears ${mentions}× in ipc.js; publicConfig needs it twice`);
  }
});
