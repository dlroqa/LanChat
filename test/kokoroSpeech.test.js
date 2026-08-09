'use strict';

// The offline voice, through the same speak() every other engine goes through.
//
// The point of these tests is that adding a local engine did not carve a second
// path through speech.js. The cache, the atomic write, the error model, the
// fallback to the window's own voice and the shape of the answer are the same
// code for Kokoro as for Gemini — so they are asserted here against the same
// entry point, with a stub engine standing in for the model.
//
// The stub is deliberate. Loading 86 MB of weights and running an inference is a
// separate, slower proof that lives in scripts/kokoro-harness.js; what belongs in
// `npm test` is everything around it, which is where the bugs that reach users
// actually are.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');

const { createSpeech, DEFAULT_RATE } = require('../src/main/speech');
const manifest = require('../src/main/tts/manifest');

const dirs = [];
const servers = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-kokoro-'));
  dirs.push(dir);
  return dir;
}

function fakeConfig(seed = {}) {
  const data = { agentSpeechEngine: 'local', agentSpeechKeys: {}, ...seed };
  return {
    get: (key) => data[key],
    set: (patch) => Object.assign(data, patch),
    all: () => data,
  };
}

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`sealed:${s}`),
  decryptString: (b) => b.toString('utf8').replace(/^sealed:/, ''),
};

// A stand-in for tts/kokoro.js: the same four methods speech.js reaches for.
// `pcm` is silence of a plausible length, because what is being tested is the
// plumbing around the bytes rather than the bytes.
function fakeEngine({ ready = true, fail = null, samples = 2400, backend = 'native' } = {}) {
  const calls = [];
  return {
    calls,
    // Both halves, exactly as tts/kokoro.js defines it: weights on disk *and* a
    // runtime able to load them. A stub that forgot the second half would let a
    // machine with no runtime look ready.
    ready: () => ready && Boolean(backend),
    supported: () => Boolean(backend),
    backend: () => backend,
    bytesOnDisk: () => (ready ? manifest.TOTAL_BYTES : 0),
    voices: () => [...manifest.RING],
    synthesize: async (request) => {
      calls.push(request);
      if (fail) throw new Error(fail);
      return { pcm: Buffer.alloc(samples * 2), ms: 10, seconds: samples / DEFAULT_RATE };
    },
  };
}

// A stub that fails the test if it is ever contacted. Every case in this file
// uses one: an engine that runs on this machine must never open a socket, and
// that is the whole reason somebody would choose it.
async function forbidden(t) {
  const server = http.createServer((_req, res) => {
    t.diagnostic('the offline engine contacted the network');
    t.fail('the offline engine must not open a socket');
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

test.after(() => {
  for (const server of servers) server.close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

// --------------------------------------------------------------------- the gate

test('choosing Kokoro without its weights reads locally instead', async (t) => {
  const endpoint = await forbidden(t);
  const kokoro = fakeEngine({ ready: false });
  const speech = createSpeech({
    config: fakeConfig({ agentSpeechEngine: 'kokoro' }),
    userDataDir: tempDir(),
    safeStorage: fakeSafeStorage,
    kokoro,
    endpoint,
  });

  const result = await speech.speak({ text: 'Anybody there?', voice: 'af_bella' });

  // The same answer a missing API key gives, and the same fallback: a worse
  // voice rather than silence.
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'local');
  assert.equal(result.fallback, true);
  assert.equal(kokoro.calls.length, 0, 'the model is not asked for anything it cannot do');
  assert.equal(speech.status().active, 'local');
});

test('the engine is never reached for while it is not chosen', async (t) => {
  const endpoint = await forbidden(t);
  const kokoro = fakeEngine();
  const speech = createSpeech({
    config: fakeConfig(), // left on 'local'
    userDataDir: tempDir(),
    safeStorage: fakeSafeStorage,
    kokoro,
    endpoint,
  });

  const result = await speech.speak({ text: 'Anybody there?', voice: 'af_bella' });
  assert.equal(result.reason, 'local');
  // Not merely unused: never even asked whether it was ready to be used.
  assert.equal(kokoro.calls.length, 0);
});

test('Kokoro takes no API key and refuses to be given one', () => {
  const speech = createSpeech({
    config: fakeConfig({ agentSpeechEngine: 'kokoro' }),
    userDataDir: tempDir(),
    safeStorage: fakeSafeStorage,
    kokoro: fakeEngine(),
  });

  const saved = speech.setKey('kokoro', 'a-real-key');
  assert.equal(saved.ok, false);
  assert.match(saved.error, /does not use an API key/);

  // And it is absent from the key map rather than present and false, so Settings
  // can tell "needs no key" from "needs a key you have not given".
  assert.ok(!('kokoro' in speech.status().keys));
});

// ------------------------------------------------------------------- speaking

test('a turn is synthesised, cached, and served back the same way as any other', async (t) => {
  const endpoint = await forbidden(t);
  const kokoro = fakeEngine();
  const dir = tempDir();
  const speech = createSpeech({
    config: fakeConfig({ agentSpeechEngine: 'kokoro', agentSpeechSpeed: 1.25 }),
    userDataDir: dir,
    safeStorage: fakeSafeStorage,
    kokoro,
    endpoint,
  });

  const first = await speech.speak({ text: 'The beacon never left the subnet.', voice: 'bf_emma' });
  assert.equal(first.ok, true);
  assert.equal(first.cached, false);
  // The engine that spoke travels back with the path, so the Transport can name
  // it rather than assume.
  assert.equal(first.engine, 'kokoro');

  // A real WAV, at the rate the model actually produces.
  const bytes = fs.readFileSync(first.path);
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(bytes.readUInt32LE(24), DEFAULT_RATE);

  // The voice and the speed reached the model; the text was passed through.
  assert.equal(kokoro.calls[0].voice, 'bf_emma');
  assert.equal(kokoro.calls[0].speed, 1.25);
  assert.equal(kokoro.calls[0].text, 'The beacon never left the subnet.');

  // Said twice is synthesised once. The same cache, keyed the same way.
  const again = await speech.speak({ text: 'The beacon never left the subnet.', voice: 'bf_emma' });
  assert.equal(again.cached, true);
  assert.equal(again.path, first.path);
  assert.equal(kokoro.calls.length, 1, 'the model was not asked twice');

  // Nothing half-written left behind.
  const leftovers = fs.readdirSync(path.join(dir, 'speech')).filter((n) => n.includes('.part'));
  assert.deepEqual(leftovers, []);
});

test('two voices saying the same words are two recordings', async (t) => {
  const endpoint = await forbidden(t);
  const kokoro = fakeEngine();
  const speech = createSpeech({
    config: fakeConfig({ agentSpeechEngine: 'kokoro' }),
    userDataDir: tempDir(),
    safeStorage: fakeSafeStorage,
    kokoro,
    endpoint,
  });

  const bella = await speech.speak({ text: 'Agreed.', voice: 'af_bella' });
  const george = await speech.speak({ text: 'Agreed.', voice: 'bm_george' });
  assert.notEqual(bella.path, george.path);
  assert.equal(kokoro.calls.length, 2);
});

test('the speed preference is bounded rather than trusted', async (t) => {
  const endpoint = await forbidden(t);

  const at = async (agentSpeechSpeed) => {
    const kokoro = fakeEngine();
    const speech = createSpeech({
      config: fakeConfig({ agentSpeechEngine: 'kokoro', agentSpeechSpeed }),
      userDataDir: tempDir(),
      safeStorage: fakeSafeStorage,
      kokoro,
      endpoint,
    });
    await speech.speak({ text: 'Go on.', voice: 'af_bella' });
    return kokoro.calls[0].speed;
  };

  // A zero would ask the model for audio of infinite length; a hand-edited
  // config must not be able to.
  assert.equal(await at(0), 0.5);
  assert.equal(await at(-4), 0.5);
  assert.equal(await at(99), 2);
  assert.equal(await at('nonsense'), 1);
  assert.equal(await at(undefined), 1);
});

test('a model that fails degrades to the local voice rather than to silence', async (t) => {
  const endpoint = await forbidden(t);
  const kokoro = fakeEngine({ fail: 'the speech engine stopped unexpectedly' });
  const speech = createSpeech({
    config: fakeConfig({ agentSpeechEngine: 'kokoro' }),
    userDataDir: tempDir(),
    safeStorage: fakeSafeStorage,
    kokoro,
    endpoint,
  });

  const result = await speech.speak({ text: 'Anybody there?', voice: 'af_bella' });
  assert.equal(result.ok, false);
  assert.equal(result.fallback, true, 'every failure the local voice can cover says so');
  assert.match(result.error, /Kokoro/);
  assert.match(result.detail, /stopped unexpectedly/);
});

test('a model that answers with no audio is a failure, not an empty file', async (t) => {
  const endpoint = await forbidden(t);
  const kokoro = fakeEngine({ samples: 0 });
  const dir = tempDir();
  const speech = createSpeech({
    config: fakeConfig({ agentSpeechEngine: 'kokoro' }),
    userDataDir: dir,
    safeStorage: fakeSafeStorage,
    kokoro,
    endpoint,
  });

  const result = await speech.speak({ text: 'Anybody there?', voice: 'af_bella' });
  assert.equal(result.ok, false);
  assert.equal(result.fallback, true);
  // The failure that would otherwise write a headerless empty file and play
  // silence — the same trap the online engines have a guard for.
  assert.ok(!fs.existsSync(path.join(dir, 'speech')) || !fs.readdirSync(path.join(dir, 'speech')).length);
});

// --------------------------------------------------------------- the podcast

test('the voice roster is published, which is what makes a session sound like several people', async (t) => {
  const endpoint = await forbidden(t);
  const speech = createSpeech({
    config: fakeConfig({ agentSpeechEngine: 'kokoro' }),
    userDataDir: tempDir(),
    safeStorage: fakeSafeStorage,
    kokoro: fakeEngine(),
    endpoint,
  });

  const roster = await speech.voices();
  assert.equal(roster.ok, true);
  assert.equal(roster.provider, 'kokoro');

  // Thirteen: twelve dealt to agents and one held back for the user's own turns
  // by ringVoices() in the renderer, which needs no branch for this engine
  // precisely because the roster arrives the same way xAI's does.
  assert.equal(roster.voices.length, 13);
  assert.deepEqual(roster.voices, manifest.RING);
  assert.equal(new Set(roster.voices).size, 13, 'no voice is dealt twice');

  // Asked for without the weights, there is no roster to publish and the window
  // falls back to the platform's own voices.
  const cold = createSpeech({
    config: fakeConfig({ agentSpeechEngine: 'kokoro' }),
    userDataDir: tempDir(),
    safeStorage: fakeSafeStorage,
    kokoro: fakeEngine({ ready: false }),
    endpoint,
  });
  assert.deepEqual((await cold.voices()).voices, []);
});

test('adjacent voices in the ring are never the same gender', () => {
  // The property the ring exists for, and the reason it is ordered rather than
  // alphabetical: when two agents collide, ringFor steps to the next slot, and
  // the result has to be audibly a different person. Kokoro encodes gender in
  // the voice id — `af_`/`bf_` female, `am_`/`bm_` male.
  const genderOf = (id) => id[1];
  const agents = manifest.RING.slice(0, -1);
  for (let i = 1; i < agents.length; i++) {
    assert.notEqual(
      genderOf(agents[i]),
      genderOf(agents[i - 1]),
      `${agents[i - 1]} and ${agents[i]} sit next to each other`
    );
  }

  // The ring is the same length as the colour ring, which is what keeps an
  // agent's voice slot and its colour slot the same slot.
  assert.equal(agents.length, 12);

  // The narrator is held back rather than dealt: an agent must never be given
  // the voice that reads the user's own words.
  assert.ok(!agents.includes(manifest.RING.at(-1)));
});

// ------------------------------------------------------------- the backend
//
// Which ONNX Runtime speaks is not a preference and not a platform check at the
// call site: `backendFor()` in tts/kokoro.js answers it once, and everything
// else reads the answer. These cases pin what each answer means, because the one
// that matters — 'wasm' — is the state no machine we develop on is ever in.

test('a machine with no native runtime still speaks, through WebAssembly', async (t) => {
  const endpoint = await forbidden(t);
  const kokoro = fakeEngine({ backend: 'wasm' });
  const speech = createSpeech({
    config: fakeConfig({ agentSpeechEngine: 'kokoro' }),
    userDataDir: tempDir(),
    safeStorage: fakeSafeStorage,
    kokoro,
    endpoint,
  });

  const result = await speech.speak({ text: 'Still here.', voice: 'af_bella' });
  assert.equal(result.ok, true, 'wasm is a working engine, not a degraded one');
  assert.equal(result.engine, 'kokoro', 'and it is still Kokoro that spoke');

  // Settings is told which, so a slower machine has an explanation rather than a
  // mystery.
  const status = speech.status();
  assert.equal(status.kokoro.backend, 'wasm');
  assert.equal(status.kokoro.ready, true);
  assert.equal(status.active, 'kokoro');
});

test('a machine with neither runtime reads locally, as it always did', async (t) => {
  const endpoint = await forbidden(t);
  const kokoro = fakeEngine({ backend: null });
  const speech = createSpeech({
    config: fakeConfig({ agentSpeechEngine: 'kokoro' }),
    userDataDir: tempDir(),
    safeStorage: fakeSafeStorage,
    kokoro,
    endpoint,
  });

  const result = await speech.speak({ text: 'Anybody?', voice: 'af_bella' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'local');
  assert.equal(result.fallback, true);
  assert.equal(speech.status().kokoro.backend, null);
  assert.equal(speech.status().kokoro.supported, false);
});

test('the backend is reported but never changes what is cached', async (t) => {
  const endpoint = await forbidden(t);
  const settings = {
    config: fakeConfig({ agentSpeechEngine: 'kokoro' }),
    safeStorage: fakeSafeStorage,
    endpoint,
  };
  const dir = tempDir();

  const native = createSpeech({ ...settings, userDataDir: dir, kokoro: fakeEngine({ backend: 'native' }) });
  const first = await native.speak({ text: 'Same words.', voice: 'af_bella' });

  const wasm = createSpeech({ ...settings, userDataDir: dir, kokoro: fakeEngine({ backend: 'wasm' }) });
  const second = await wasm.speak({ text: 'Same words.', voice: 'af_bella' });

  // The cache key is provider|model|voice|text and deliberately not the backend:
  // the two runtimes produce the same speech, so a recording made by one is a
  // valid answer for the other. Someone switching machines or upgrading past the
  // native pin does not invalidate everything they have already heard.
  assert.equal(second.path, first.path);
  assert.equal(second.cached, true);
});
