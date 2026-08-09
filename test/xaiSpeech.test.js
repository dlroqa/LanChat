'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');

const { createSpeech, XAI_FALLBACK_VOICES } = require('../src/main/speech');

// Reading a session aloud through xAI's Grok TTS, over the real HTTP path.
//
// A real listening socket, real requests, real timeouts, against a stub standing
// in for api.x.ai — the same shape as speech.test.js does for Gemini, and for
// the same reason: everything that can go wrong lives below the module boundary.
//
// Two of these tests exist because xAI's API differs from Gemini's in ways that
// would have been silently wrong if assumed rather than read:
//
//   * **the response is raw binary audio**, not JSON carrying base64. Its
//     documentation says so in as many words — "the response body contains raw
//     audio bytes" — and the curl example writes it straight to a file with
//     --output. Reading that through the utf8 path the Gemini provider uses
//     would replace every byte outside ASCII with U+FFFD and produce a file of
//     roughly the right size and entirely of noise. The byte-for-byte assertion
//     below is the one that catches it.
//   * **the voice roster is fetched**, because xAI's own published lists
//     disagree — one page names twenty-six voices, the launch announcement five.

const servers = [];
const dirs = [];

async function stub(routes) {
  const state = { hits: 0, bodies: [], paths: [], auth: [] };
  const server = http.createServer((req, res) => {
    state.hits += 1;
    state.paths.push(`${req.method} ${req.url}`);
    state.auth.push(req.headers.authorization || null);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      state.bodies.push(Buffer.concat(chunks).toString('utf8'));
      const route = routes[`${req.method} ${req.url}`] || routes.default;
      if (!route) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not found"}');
        return;
      }
      route(req, res, state);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  state.endpoint = `http://127.0.0.1:${server.address().port}`;
  return state;
}

async function forbidden(t) {
  return stub({
    default: (_req, res) => {
      t.diagnostic('the stub was contacted, and must not have been');
      res.writeHead(500);
      res.end('{}');
    },
  });
}

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-xai-'));
  dirs.push(dir);
  return dir;
}

function fakeConfig(data) {
  const store = { ...data };
  return { get: (k) => store[k], set: (patch) => Object.assign(store, patch) };
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

const sealed = (value) => ({ mode: 'sealed', cipher: Buffer.from(`sealed:${value}`).toString('base64') });

// Bytes that are unmistakably not text: a real mp3 frame header followed by the
// whole byte range, so anything that decodes this as utf8 mangles it visibly.
function mp3Bytes() {
  const head = Buffer.from([0xff, 0xfb, 0x90, 0x64]);
  const body = Buffer.alloc(512);
  for (let i = 0; i < body.length; i += 1) body[i] = i % 256;
  return Buffer.concat([head, body]);
}

function xai(endpoint, dir, extra = {}) {
  return createSpeech({
    config: fakeConfig({
      agentSpeechEngine: 'xai',
      agentSpeechKeys: { xai: sealed('xai-test-key') },
      ...extra,
    }),
    userDataDir: dir,
    safeStorage: fakeSafeStorage,
    endpoints: { xai: endpoint },
  });
}

const audioRoute = (bytes) => (_req, res) => {
  res.writeHead(200, { 'content-type': 'audio/mpeg' });
  res.end(bytes);
};

test.after(() => {
  for (const s of servers) s.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

// -------------------------------------------------------------------- the gate

test('xAI is not contacted unless it is chosen', async (t) => {
  const server = await forbidden(t);
  const speech = createSpeech({
    config: fakeConfig({ agentSpeechEngine: 'local', agentSpeechKeys: { xai: sealed('k') } }),
    userDataDir: tempDir(),
    safeStorage: fakeSafeStorage,
    endpoints: { xai: server.endpoint },
  });

  const res = await speech.speak({ text: 'Say something.', voice: 'Eve' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'local');
  assert.equal(server.hits, 0);
});

test('xAI chosen with no key does not reach the network', async (t) => {
  const server = await forbidden(t);
  const speech = createSpeech({
    config: fakeConfig({ agentSpeechEngine: 'xai', agentSpeechKeys: {} }),
    userDataDir: tempDir(),
    safeStorage: fakeSafeStorage,
    endpoints: { xai: server.endpoint },
  });

  const res = await speech.speak({ text: 'Say something.', voice: 'Eve' });
  assert.equal(res.ok, false);
  assert.equal(res.fallback, true);
  assert.equal(server.hits, 0);
});

test('one provider is never given another provider s key', async (t) => {
  // The reason the keys are held apart rather than in one field: a Gemini key
  // must never be sent to xAI, and it is somebody's paid credential.
  const server = await forbidden(t);
  const speech = createSpeech({
    config: fakeConfig({ agentSpeechEngine: 'xai', agentSpeechKeys: { gemini: sealed('gemini-key') } }),
    userDataDir: tempDir(),
    safeStorage: fakeSafeStorage,
    endpoints: { xai: server.endpoint },
  });

  const res = await speech.speak({ text: 'Say something.', voice: 'Eve' });
  assert.equal(res.ok, false, 'a Gemini key does not make xAI usable');
  assert.equal(server.hits, 0);

  const status = speech.status();
  assert.deepEqual(status.keys, { gemini: true, xai: false });
  assert.equal(status.active, 'local', 'and it says it cannot really speak');
});

// -------------------------------------------------------------- the happy path

test('the audio comes back as bytes and is written unchanged', async () => {
  const bytes = mp3Bytes();
  const server = await stub({ default: audioRoute(bytes) });
  const speech = xai(server.endpoint, tempDir());

  const res = await speech.speak({ text: 'Good morning.', voice: 'Eve', language: 'en-GB' });
  assert.equal(res.ok, true);
  assert.equal(res.engine, 'xai');
  assert.ok(res.path.endsWith('.mp3'), 'mp3 describes itself, so no header is added');

  const written = fs.readFileSync(res.path);
  // The assertion this file exists for. Decoded as utf8 anywhere along the way,
  // this comes back the wrong length and full of replacement characters.
  assert.ok(written.equals(bytes), 'every byte must survive');
});

test('the request is the documented one', async () => {
  const server = await stub({ default: audioRoute(mp3Bytes()) });
  const speech = xai(server.endpoint, tempDir());
  await speech.speak({ text: 'Good morning.', voice: 'Rex', language: 'en-GB' });

  assert.equal(server.paths[0], 'POST /v1/tts');
  assert.equal(server.auth[0], 'Bearer xai-test-key');

  const sent = JSON.parse(server.bodies[0]);
  assert.equal(sent.text, 'Good morning.');
  assert.equal(sent.voice_id, 'Rex');
  assert.equal(sent.language, 'en-GB', 'the window says what this machine reads in');
  assert.equal(sent.output_format.codec, 'mp3');
  // The one flag that would turn the reply into a JSON envelope. Sending it
  // would break the byte-for-byte path above.
  assert.equal(sent.with_timestamps, undefined);
});

test('a missing language falls back rather than being sent empty', async () => {
  const server = await stub({ default: audioRoute(mp3Bytes()) });
  const speech = xai(server.endpoint, tempDir());
  await speech.speak({ text: 'No language given.', voice: 'Eve' });

  assert.equal(JSON.parse(server.bodies[0]).language, 'en');
});

test('the same turn is synthesised once and kept', async () => {
  const server = await stub({ default: audioRoute(mp3Bytes()) });
  const speech = xai(server.endpoint, tempDir());

  const first = await speech.speak({ text: 'Say it again.', voice: 'Eve' });
  const second = await speech.speak({ text: 'Say it again.', voice: 'Eve' });

  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.path, first.path);
  assert.equal(server.hits, 1);
});

test('the same words on two providers are two different files', async () => {
  // They are not even the same format, so one cache entry serving both would
  // hand mp3 bytes to something expecting a wav.
  const server = await stub({ default: audioRoute(mp3Bytes()) });
  const dir = tempDir();
  const asXai = xai(server.endpoint, dir);
  const a = await asXai.speak({ text: 'Same words.', voice: 'Eve' });

  const asGemini = createSpeech({
    config: fakeConfig({ agentSpeechEngine: 'gemini', agentSpeechKeys: { gemini: sealed('g') } }),
    userDataDir: dir,
    safeStorage: fakeSafeStorage,
    endpoints: { gemini: server.endpoint },
  });
  // Gemini's decoder will refuse this body, which is fine — what matters is that
  // it looked for a different file.
  await asGemini.speak({ text: 'Same words.', voice: 'Eve' });

  assert.ok(a.path.endsWith('.mp3'));
  assert.equal(server.hits, 2, 'the second provider did not read the first one s cache');
});

// ----------------------------------------------------------------- the failures

test('a refused key says so, without the key in the message', async () => {
  const server = await stub({
    default: (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid API key' }));
    },
  });
  const speech = xai(server.endpoint, tempDir());

  const res = await speech.speak({ text: 'Denied.', voice: 'Eve' });
  assert.equal(res.ok, false);
  assert.match(res.error, /key was refused/i);
  assert.equal(res.fallback, true);
  assert.ok(!JSON.stringify(res).includes('xai-test-key'));
});

test('a spent quota and an outage each get their own sentence', async () => {
  const quota = await stub({
    default: (_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"error":"rate limited"}');
    },
  });
  assert.match((await xai(quota.endpoint, tempDir()).speak({ text: 'x', voice: 'Eve' })).error, /quota/i);

  const down = await stub({
    default: (_req, res) => {
      res.writeHead(503);
      res.end('upstream unavailable');
    },
  });
  const res = await xai(down.endpoint, tempDir()).speak({ text: 'x', voice: 'Eve' });
  assert.match(res.error, /xAI is unavailable/i, 'and it names the provider that is down');
});

test('an empty body is a failure, not a silent empty file', async () => {
  const server = await stub({
    default: (_req, res) => {
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(Buffer.alloc(0));
    },
  });
  const dir = tempDir();
  const res = await xai(server.endpoint, dir).speak({ text: 'Nothing back.', voice: 'Eve' });

  assert.equal(res.ok, false);
  assert.match(res.error, /no audio/i);
  assert.equal(res.fallback, true);
  assert.equal(fs.existsSync(path.join(dir, 'speech')), false, 'and nothing was written');
});

test('a machine that is offline falls back to the local voice', async () => {
  const speech = createSpeech({
    config: fakeConfig({ agentSpeechEngine: 'xai', agentSpeechKeys: { xai: sealed('k') } }),
    userDataDir: tempDir(),
    safeStorage: fakeSafeStorage,
    endpoints: { xai: 'http://lanchat-xai.invalid' },
  });

  const res = await speech.speak({ text: 'Offline.', voice: 'Eve' });
  assert.equal(res.ok, false);
  assert.equal(res.fallback, true);
  assert.match(res.detail, /offline/i);
});

// ------------------------------------------------------------------ the voices

test('the roster is read from the provider', async () => {
  const server = await stub({
    'GET /v1/tts/voices': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          voices: [
            { voice_id: 'carina', name: 'Carina', language: 'en' },
            { voice_id: 'zagan', name: 'Zagan', language: 'en' },
            { voice_id: 'eve', name: 'Eve', language: 'en' },
          ],
        })
      );
    },
  });
  const speech = xai(server.endpoint, tempDir());

  const res = await speech.voices();
  assert.equal(res.provider, 'xai');
  assert.deepEqual(res.voices, ['carina', 'zagan', 'eve']);
  assert.equal(res.fallback, false, 'this was the real list, not the documented one');

  // Asked once. A roster does not change while somebody is listening, and this
  // sits on the path of the first spoken turn.
  await speech.voices();
  assert.equal(server.hits, 1);
});

test('a roster that cannot be read falls back to the documented names', async () => {
  const server = await stub({
    default: (_req, res) => {
      res.writeHead(500);
      res.end('nope');
    },
  });
  const speech = xai(server.endpoint, tempDir());

  const res = await speech.voices();
  assert.deepEqual(res.voices, [...XAI_FALLBACK_VOICES]);
  assert.equal(res.fallback, true);
  assert.ok(res.voices.length >= 4, 'enough to tell four agents apart');
});

test('saving or forgetting a key drops the roster it fetched', async () => {
  const server = await stub({
    'GET /v1/tts/voices': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ voices: [{ voice_id: 'eve' }] }));
    },
  });
  const speech = xai(server.endpoint, tempDir());

  await speech.voices();
  assert.equal(server.hits, 1);

  // A different key may be a different account with different voices.
  speech.setKey('xai', 'another-key');
  await speech.voices();
  assert.equal(server.hits, 2);
});

test('only xAI publishes a roster to ask for', async (t) => {
  const server = await forbidden(t);
  const speech = createSpeech({
    config: fakeConfig({ agentSpeechEngine: 'gemini', agentSpeechKeys: { gemini: sealed('g') } }),
    userDataDir: tempDir(),
    safeStorage: fakeSafeStorage,
    endpoints: { gemini: server.endpoint, xai: server.endpoint },
  });

  const res = await speech.voices();
  assert.equal(res.provider, 'gemini');
  assert.deepEqual(res.voices, [], 'the window already holds Gemini s ring');
  assert.equal(server.hits, 0);
});

// ------------------------------------------------------------------- the keys

test('each provider s key is stored and forgotten on its own', () => {
  const config = fakeConfig({ agentSpeechEngine: 'xai', agentSpeechKeys: {} });
  const speech = createSpeech({ config, userDataDir: tempDir(), safeStorage: fakeSafeStorage });

  speech.setKey('gemini', 'g-key');
  speech.setKey('xai', 'x-key');
  assert.deepEqual(speech.status().keys, { gemini: true, xai: true });

  speech.setKey('xai', '');
  assert.deepEqual(speech.status().keys, { gemini: true, xai: false }, 'forgetting one keeps the other');
  assert.equal(config.get('agentSpeechKeys').gemini.mode, 'sealed');
  assert.equal(config.get('agentSpeechKeys').xai, undefined);
});

test('an unknown provider cannot be given a key', () => {
  const config = fakeConfig({ agentSpeechKeys: {} });
  const speech = createSpeech({ config, userDataDir: tempDir(), safeStorage: fakeSafeStorage });

  const res = speech.setKey('openai', 'a-key');
  assert.equal(res.ok, false);
  assert.deepEqual(config.get('agentSpeechKeys'), {}, 'and nothing is written');
});
