'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');

const {
  createSpeech,
  DEFAULT_MODEL,
  DEFAULT_VOICE,
  DEFAULT_RATE,
  MAX_TEXT_CHARS,
  boundText,
  rateOf,
  audioOf,
  wavOf,
} = require('../src/main/speech');

// Reading a session's discussion aloud, over the real HTTP path.
//
// A real listening socket, real requests, real timeouts, against a stub standing
// in for Gemini — the same shape as dictationApi.test.js, and for the same
// reason: everything that can go wrong here lives below the module boundary. A
// faked `request` would assert only that we call ourselves correctly.
//
// The test this file exists for is the last one: **with the engine left alone,
// nothing is contacted.** LanChat has no central server, and speaking an agent's
// words through Google is the one thing in the app that reaches out to a company.
// That it cannot happen by default is a property, and a property asserted in a
// comment is not asserted. So the stub counts every request it receives and the
// opt-in tests fail if that count ever moves.

const servers = [];
const dirs = [];

// A stub on an ephemeral port. `handler` answers every request; `hits` counts
// them, which is what the opt-in and cache tests read.
async function stub(handler) {
  const state = { hits: 0, bodies: [] };
  const server = http.createServer((req, res) => {
    state.hits += 1;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      state.bodies.push(Buffer.concat(chunks).toString('utf8'));
      handler(req, res, state);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  state.endpoint = `http://127.0.0.1:${server.address().port}`;
  return state;
}

// A stub that fails the test if it is ever spoken to. Used by the opt-in cases,
// where the whole assertion is that no request happens.
async function forbidden(t) {
  return stub((_req, res) => {
    t.diagnostic('the stub was contacted, and must not have been');
    res.writeHead(500);
    res.end('{}');
  });
}

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-speech-'));
  dirs.push(dir);
  return dir;
}

// The two collaborators speech.js reaches outside itself for, in their smallest
// honest form. safeStorage's real contract is bytes in, bytes out, and this
// keeps that shape rather than pretending encryption is identity.
function fakeConfig(data) {
  const store = { ...data };
  return {
    get: (key) => store[key],
    set: (patch) => Object.assign(store, patch),
    all: () => store,
  };
}

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`sealed:${s}`, 'utf8'),
  decryptString: (buf) => {
    const s = buf.toString('utf8');
    if (!s.startsWith('sealed:')) throw new Error('not sealed by this keychain');
    return s.slice('sealed:'.length);
  },
};

// A response shaped exactly as Google documents it: base64 in
// candidates[0].content.parts[0].inlineData.data.
function audioResponse(pcm, mimeType = 'audio/L16;codec=pcm;rate=24000') {
  return JSON.stringify({
    candidates: [{ content: { parts: [{ inlineData: { mimeType, data: pcm.toString('base64') } }] } }],
  });
}

// Half a second of a quiet tone, as signed 16-bit little-endian mono — the
// format the model returns. Real samples rather than zeroes so a test that
// checks the bytes survived the round trip is checking something.
function tone(frames = 12000, rate = 24000) {
  const buf = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    buf.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  }
  return buf;
}

// What the WAV header actually says, read back rather than assumed.
function readWav(file) {
  const buf = fs.readFileSync(file);
  return {
    riff: buf.toString('ascii', 0, 4),
    wave: buf.toString('ascii', 8, 12),
    format: buf.readUInt16LE(20),
    channels: buf.readUInt16LE(22),
    rate: buf.readUInt32LE(24),
    byteRate: buf.readUInt32LE(28),
    blockAlign: buf.readUInt16LE(32),
    bits: buf.readUInt16LE(34),
    dataSize: buf.readUInt32LE(40),
    data: buf.subarray(44),
    total: buf.length,
  };
}

test.after(() => {
  for (const s of servers) s.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

// ------------------------------------------------------------------- the gate

test('with the engine left at its default, nothing is contacted', async (t) => {
  const server = await forbidden(t);
  const speech = createSpeech({
    // No agentSpeechEngine at all — a fresh install, or a config file written by
    // a version that had never heard of this feature.
    config: fakeConfig({
      agentSpeechKey: { mode: 'sealed', cipher: Buffer.from('sealed:k').toString('base64') },
    }),
    userDataDir: tempDir(),
    safeStorage: fakeSafeStorage,
    endpoint: server.endpoint,
  });

  const res = await speech.speak({ text: 'Say something.', voice: 'Kore' });

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'local');
  // Not an error: the local voice covers it, which is the whole point.
  assert.equal(res.fallback, true);
  assert.equal(server.hits, 0, 'the default must not reach the network');
});

test('a key with the engine off is still never sent anywhere', async (t) => {
  const server = await forbidden(t);
  const speech = createSpeech({
    config: fakeConfig({
      agentSpeechEngine: 'local',
      agentSpeechKey: { mode: 'sealed', cipher: Buffer.from('sealed:real-key').toString('base64') },
    }),
    userDataDir: tempDir(),
    safeStorage: fakeSafeStorage,
    endpoint: server.endpoint,
  });

  await speech.speak({ text: 'Say something.', voice: 'Kore' });
  assert.equal(server.hits, 0);
});

test('the engine on with no key does not reach the network either', async (t) => {
  const server = await forbidden(t);
  const speech = createSpeech({
    config: fakeConfig({ agentSpeechEngine: 'gemini', agentSpeechKey: null }),
    userDataDir: tempDir(),
    safeStorage: fakeSafeStorage,
    endpoint: server.endpoint,
  });

  const res = await speech.speak({ text: 'Say something.', voice: 'Kore' });
  assert.equal(res.ok, false);
  assert.equal(res.fallback, true);
  assert.equal(server.hits, 0);
});

test('a key that will not decrypt is no key at all', async (t) => {
  const server = await forbidden(t);
  const speech = createSpeech({
    config: fakeConfig({
      agentSpeechEngine: 'gemini',
      // Written by a different machine's keychain, which is exactly what a copied
      // config directory looks like.
      agentSpeechKey: { mode: 'sealed', cipher: Buffer.from('garbage').toString('base64') },
    }),
    userDataDir: tempDir(),
    safeStorage: fakeSafeStorage,
    endpoint: server.endpoint,
  });

  const res = await speech.speak({ text: 'Say something.', voice: 'Kore' });
  assert.equal(res.ok, false);
  assert.equal(res.fallback, true);
  assert.equal(server.hits, 0);
});

// --------------------------------------------------------------- the happy path

// Everything below has opted in, which is what this builds.
function online(endpoint, dir, extra = {}) {
  return createSpeech({
    config: fakeConfig({
      agentSpeechEngine: 'gemini',
      agentSpeechKey: { mode: 'sealed', cipher: Buffer.from('sealed:test-key').toString('base64') },
      ...extra,
    }),
    userDataDir: dir,
    safeStorage: fakeSafeStorage,
    endpoint,
  });
}

test('audio comes back as a WAV whose header describes it correctly', async () => {
  const pcm = tone();
  const server = await stub((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(audioResponse(pcm));
  });
  const speech = online(server.endpoint, tempDir());

  const res = await speech.speak({ text: 'Good morning.', voice: 'Kore' });
  assert.equal(res.ok, true);
  assert.equal(res.cached, false);

  const wav = readWav(res.path);
  assert.equal(wav.riff, 'RIFF');
  assert.equal(wav.wave, 'WAVE');
  assert.equal(wav.format, 1, 'uncompressed PCM');
  assert.equal(wav.channels, 1);
  assert.equal(wav.bits, 16);
  assert.equal(wav.rate, 24000);
  assert.equal(wav.byteRate, 24000 * 2);
  assert.equal(wav.blockAlign, 2);
  assert.equal(wav.dataSize, pcm.length);
  assert.equal(wav.total, 44 + pcm.length);
  // The samples are passed through untouched — no float round trip.
  assert.ok(wav.data.equals(pcm), 'the PCM must survive byte for byte');
});

test('the request carries the documented body and the key in a header', async () => {
  const server = await stub((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(audioResponse(tone(64)));
  });
  const speech = online(server.endpoint, tempDir());
  await speech.speak({ text: 'Good morning.', voice: 'Charon' });

  const sent = JSON.parse(server.bodies[0]);
  assert.equal(sent.contents[0].parts[0].text, 'Good morning.');
  assert.deepEqual(sent.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(sent.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Charon');
});

test('the sample rate is taken from the response, not from a constant', async () => {
  const pcm = tone(4000, 16000);
  const server = await stub((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    // A model answering at a different rate. Writing 24000 into the header here
    // would play this back a tone and a half high.
    res.end(audioResponse(pcm, 'audio/L16;codec=pcm;rate=16000'));
  });
  const speech = online(server.endpoint, tempDir());

  const res = await speech.speak({ text: 'Lower.', voice: 'Kore' });
  assert.equal(readWav(res.path).rate, 16000);
});

test('a response with no mimeType falls back to the documented rate', async () => {
  const server = await stub((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { data: tone(64).toString('base64') } }] } }],
      })
    );
  });
  const speech = online(server.endpoint, tempDir());

  const res = await speech.speak({ text: 'No type.', voice: 'Kore' });
  assert.equal(res.ok, true);
  assert.equal(readWav(res.path).rate, DEFAULT_RATE);
});

test('audio is found even when it is not the first part', async () => {
  const pcm = tone(64);
  const server = await stub((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: 'Here you are:' },
                { inlineData: { mimeType: 'audio/L16;rate=24000', data: pcm.toString('base64') } },
              ],
            },
          },
        ],
      })
    );
  });
  const speech = online(server.endpoint, tempDir());

  const res = await speech.speak({ text: 'Anywhere.', voice: 'Kore' });
  assert.equal(res.ok, true);
  assert.ok(readWav(res.path).data.equals(pcm));
});

// ------------------------------------------------------------------ the cache

test('the same turn in the same voice is synthesised once and kept', async () => {
  const server = await stub((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(audioResponse(tone(64)));
  });
  const dir = tempDir();
  const speech = online(server.endpoint, dir);

  const first = await speech.speak({ text: 'Say it again.', voice: 'Kore' });
  const second = await speech.speak({ text: 'Say it again.', voice: 'Kore' });

  assert.equal(first.ok, true);
  assert.equal(first.cached, false);
  assert.equal(second.ok, true);
  assert.equal(second.cached, true, 'the replay button must not pay twice');
  assert.equal(second.path, first.path);
  assert.equal(server.hits, 1, 'the second call must not reach the network');
});

test('a different voice saying the same words is a different file', async () => {
  const server = await stub((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(audioResponse(tone(64)));
  });
  const speech = online(server.endpoint, tempDir());

  const a = await speech.speak({ text: 'Same words.', voice: 'Kore' });
  const b = await speech.speak({ text: 'Same words.', voice: 'Puck' });

  assert.notEqual(a.path, b.path);
  assert.equal(server.hits, 2);
});

test('a run that dies mid-write leaves no half file to be served as whole', async () => {
  const server = await stub((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(audioResponse(tone(64)));
  });
  const dir = tempDir();
  const speech = online(server.endpoint, dir);
  await speech.speak({ text: 'Whole.', voice: 'Kore' });

  // Nothing partial is left behind: the write goes to a .part and is renamed.
  const leftovers = fs.readdirSync(path.join(dir, 'speech')).filter((f) => f.endsWith('.part'));
  assert.deepEqual(leftovers, []);
});

// ----------------------------------------------------------------- the failures

test('a 200 carrying no audio is a failure, not an empty file', async () => {
  const server = await stub((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    // A real and reported behaviour of these models: usage figures, no audio.
    res.end(JSON.stringify({ usageMetadata: { totalTokenCount: 12 }, candidates: [] }));
  });
  const dir = tempDir();
  const speech = online(server.endpoint, dir);

  const res = await speech.speak({ text: 'Nothing back.', voice: 'Kore' });
  assert.equal(res.ok, false);
  assert.match(res.error, /no audio/i);
  assert.equal(res.fallback, true);
  // And nothing was written, so a retry is not served silence from the cache.
  assert.equal(fs.existsSync(path.join(dir, 'speech')), false);
});

test('audio that decodes to nothing is a failure too', async () => {
  const server = await stub((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(audioResponse(Buffer.alloc(0)));
  });
  const speech = online(server.endpoint, tempDir());

  const res = await speech.speak({ text: 'Empty.', voice: 'Kore' });
  assert.equal(res.ok, false);
  assert.equal(res.fallback, true);
});

test('a refused key says so, and says it without the key in it', async () => {
  const server = await stub((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'API key not valid' } }));
  });
  const speech = online(server.endpoint, tempDir());

  const res = await speech.speak({ text: 'Denied.', voice: 'Kore' });
  assert.equal(res.ok, false);
  assert.match(res.error, /key was refused/i);
  assert.equal(res.fallback, true);
  assert.ok(!JSON.stringify(res).includes('test-key'), 'the key must never be in a message');
});

test('a spent quota is its own sentence', async () => {
  const server = await stub((_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Resource exhausted' } }));
  });
  const speech = online(server.endpoint, tempDir());

  const res = await speech.speak({ text: 'Too much.', voice: 'Kore' });
  assert.match(res.error, /quota/i);
  assert.equal(res.fallback, true);
});

test('Gemini being down is its own sentence', async () => {
  const server = await stub((_req, res) => {
    res.writeHead(503);
    res.end('upstream unavailable');
  });
  const speech = online(server.endpoint, tempDir());

  const res = await speech.speak({ text: 'Down.', voice: 'Kore' });
  assert.match(res.error, /unavailable/i);
  assert.equal(res.fallback, true);
});

test('a server that never answers times out and falls back', async () => {
  const server = await stub(() => {
    // Deliberately no response.
  });
  const speech = createSpeech({
    config: fakeConfig({
      agentSpeechEngine: 'gemini',
      agentSpeechKey: { mode: 'sealed', cipher: Buffer.from('sealed:test-key').toString('base64') },
    }),
    userDataDir: tempDir(),
    safeStorage: fakeSafeStorage,
    endpoint: server.endpoint,
    timeouts: { run: 150 },
  });

  const res = await speech.speak({ text: 'Silence.', voice: 'Kore' });
  assert.equal(res.ok, false);
  assert.match(res.error, /in time/i);
  assert.equal(res.fallback, true);
});

test('a machine that is offline says so, and says the local voice is covering it', async () => {
  const speech = createSpeech({
    config: fakeConfig({
      agentSpeechEngine: 'gemini',
      agentSpeechKey: { mode: 'sealed', cipher: Buffer.from('sealed:test-key').toString('base64') },
    }),
    userDataDir: tempDir(),
    safeStorage: fakeSafeStorage,
    // A name that cannot resolve, which is what being offline looks like.
    endpoint: 'http://lanchat-speech.invalid',
  });

  const res = await speech.speak({ text: 'Offline.', voice: 'Kore' });
  assert.equal(res.ok, false);
  assert.equal(res.fallback, true);
  assert.match(res.detail, /offline/i);
});

test('nothing to say is refused before anything else, and does not fall back', async (t) => {
  const server = await forbidden(t);
  const speech = online(server.endpoint, tempDir());

  for (const text of ['', '   ', null, undefined]) {
    const res = await speech.speak({ text, voice: 'Kore' });
    assert.equal(res.ok, false);
    // The one failure the local voice cannot cover: there are no words.
    assert.equal(res.fallback, false);
  }
  assert.equal(server.hits, 0);
});

// The regression that shipped in 0.8.8, stated as an assertion.
//
// This used to refuse an unnamed voice and answer `fallback: true` — the same
// answer it gives when the engine is off. So a window fault that left an agent
// without a voice was indistinguishable from having no key, and every affected
// turn was quietly read by the local voice. A paid key looked like it had done
// nothing, which is exactly what was reported.
//
// An unnamed voice must now still reach Gemini, on a default voice. That degrades
// audibly — everyone sounding alike — instead of silently abandoning the engine.
test('an unnamed voice still uses the engine the user asked for', async () => {
  const server = await stub((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(audioResponse(tone(64)));
  });
  const speech = online(server.endpoint, tempDir());

  for (const voice of ['', null, undefined, '   ']) {
    const res = await speech.speak({ text: 'Somebody say this.', voice });
    assert.equal(res.ok, true, 'a missing voice is not a reason to go local');
  }
  assert.ok(server.hits > 0, 'the request must actually be made');

  const sent = JSON.parse(server.bodies[0]);
  assert.equal(sent.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, DEFAULT_VOICE);
});

// ------------------------------------------------------------------- the bounds

test('a long turn is cut at a sentence end, not mid-word', () => {
  const sentence = 'This is a sentence of a reasonable length. ';
  const long = sentence.repeat(200);
  assert.ok(long.length > MAX_TEXT_CHARS);

  const bounded = boundText(long);
  assert.ok(bounded.length <= MAX_TEXT_CHARS);
  assert.ok(bounded.endsWith('.'), 'speech should finish a clause');
  assert.ok(long.startsWith(bounded));
});

test('a wall of text with no sentence end is still spoken in part', () => {
  const wall = 'word '.repeat(2000);
  const bounded = boundText(wall);
  assert.equal(bounded.length, MAX_TEXT_CHARS);
});

test('short text is passed through untouched but trimmed', () => {
  assert.equal(boundText('  Hello there.  '), 'Hello there.');
  assert.equal(boundText(null), '');
});

// --------------------------------------------------------------- the small parts

test('rateOf reads the rate it is given and refuses nonsense', () => {
  assert.equal(rateOf('audio/L16;codec=pcm;rate=24000'), 24000);
  assert.equal(rateOf('audio/L16;rate=16000'), 16000);
  assert.equal(rateOf('audio/L16'), DEFAULT_RATE);
  assert.equal(rateOf(null), DEFAULT_RATE);
  // Out of any plausible range: a header built from this would be unplayable.
  assert.equal(rateOf('audio/L16;rate=3'), DEFAULT_RATE);
  assert.equal(rateOf('audio/L16;rate=999999'), DEFAULT_RATE);
});

test('audioOf ignores parts that are not audio', () => {
  assert.equal(audioOf(null), null);
  assert.equal(audioOf({}), null);
  assert.equal(audioOf({ candidates: [{ content: { parts: [{ text: 'hello' }] } }] }), null);
  assert.equal(
    audioOf({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] } }],
    }),
    null
  );
  assert.deepEqual(
    audioOf({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16', data: 'AAAA' } }] } }],
    }),
    { data: 'AAAA', mimeType: 'audio/L16' }
  );
});

test('wavOf writes a header that matches its payload at any rate', () => {
  for (const rate of [8000, 16000, 24000, 48000]) {
    const pcm = tone(100, rate);
    const wav = wavOf(pcm, rate);
    assert.equal(wav.length, 44 + pcm.length);
    assert.equal(wav.readUInt32LE(4), 36 + pcm.length);
    assert.equal(wav.readUInt32LE(24), rate);
    assert.equal(wav.readUInt32LE(28), rate * 2);
    assert.equal(wav.readUInt32LE(40), pcm.length);
  }
});

// ---------------------------------------------------------------- status & keys

test('status reports whether a key exists and never what it is', () => {
  const config = fakeConfig({ agentSpeechEngine: 'gemini' });
  const speech = createSpeech({ config, userDataDir: tempDir(), safeStorage: fakeSafeStorage });

  assert.deepEqual(speech.status(), { engine: 'gemini', hasKey: false, model: DEFAULT_MODEL });

  speech.setKey('a-real-key');
  const after = speech.status();
  assert.equal(after.hasKey, true);
  assert.ok(!JSON.stringify(after).includes('a-real-key'));

  // Stored sealed, never in the clear.
  const stored = config.get('agentSpeechKey');
  assert.equal(stored.mode, 'sealed');
  assert.ok(!Buffer.from(stored.cipher, 'base64').toString('utf8').startsWith('a-real-key'));
});

test('an empty key forgets the stored one', () => {
  const config = fakeConfig({ agentSpeechEngine: 'gemini' });
  const speech = createSpeech({ config, userDataDir: tempDir(), safeStorage: fakeSafeStorage });

  speech.setKey('a-real-key');
  assert.equal(speech.status().hasKey, true);

  const res = speech.setKey('');
  assert.equal(res.ok, true);
  assert.equal(res.hasKey, false);
  assert.equal(config.get('agentSpeechKey'), null);
});

test('a machine with no secure storage is refused rather than written to in the clear', () => {
  const config = fakeConfig({ agentSpeechEngine: 'gemini' });
  const speech = createSpeech({
    config,
    userDataDir: tempDir(),
    safeStorage: { isEncryptionAvailable: () => false },
  });

  const res = speech.setKey('a-real-key');
  assert.equal(res.ok, false);
  assert.match(res.error, /secure storage/i);
  assert.equal(config.get('agentSpeechKey'), undefined);
});

test('a key can live in the environment instead', async () => {
  const server = await stub((req, res) => {
    assert.equal(req.headers['x-goog-api-key'], 'from-the-environment');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(audioResponse(tone(64)));
  });
  process.env.LANCHAT_TEST_SPEECH_KEY = 'from-the-environment';
  const speech = createSpeech({
    config: fakeConfig({
      agentSpeechEngine: 'gemini',
      agentSpeechKey: { mode: 'env', name: 'LANCHAT_TEST_SPEECH_KEY' },
    }),
    userDataDir: tempDir(),
    safeStorage: fakeSafeStorage,
    endpoint: server.endpoint,
  });

  const res = await speech.speak({ text: 'From the env.', voice: 'Kore' });
  assert.equal(res.ok, true);
  delete process.env.LANCHAT_TEST_SPEECH_KEY;
});
