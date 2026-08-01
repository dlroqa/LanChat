'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { createDictation, DEFAULT_PORT, MAX_CLIP_BYTES } = require('../src/main/dictation');

// These run the real HTTP path — a real listening socket, real requests, real
// timeouts — against a stub server standing in for FluidVoice's local API.
//
// Nothing here is mocked at the module boundary, because the things that can go
// wrong all live below it: a refused connection, a 200 whose body is not the
// shape we expect, a server that accepts and never answers. A fake `request`
// would assert only that we call ourselves correctly.
//
// The one behaviour worth stating up front: a 200 is not success. FluidVoice
// answers `POST /v1/transcribe` with `{text, confidence, sampleCount, provider}`
// and we treat the run as failed unless `text` is actually a string, so an
// unrelated server that happens to return 200 cannot be mistaken for a
// transcript.

const servers = [];

// Starts a stub on an ephemeral port and returns it. `routes` maps a method and
// path to a handler; anything unrouted answers 404, which is what a real server
// with different routes would do.
async function stub(routes) {
  const server = http.createServer((req, res) => {
    const route = routes[`${req.method} ${req.url}`];
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"message":"Not Found"}');
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => route(req, res, Buffer.concat(chunks)));
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

// A port nothing is listening on. Bound and released, so the number is real and
// free rather than guessed — guessing risks hitting something that answers.
async function deadPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test.after(async () => {
  for (const s of servers) {
    // Two of the stubs below deliberately never answer, so their sockets are
    // still open here. close() alone waits for those to end and would hang until
    // --test-force-exit killed the process, taking the run's own summary with
    // it. Destroying them first is what makes the teardown finish.
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
});

function fakeConfig(values = {}) {
  const data = { dictationPort: DEFAULT_PORT, ...values };
  return { data, get: (k) => data[k], set: (patch) => Object.assign(data, patch) };
}

function make(values, timeouts) {
  return createDictation({ config: fakeConfig(values), timeouts });
}

const clip = () => Buffer.alloc(64, 7);

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const HEALTHY = { 'GET /v1/health': (_q, res) => json(res, 200, { status: 'ok', version: '1.6.6' }) };

// ------------------------------------------------------------------ probe

test('probe reports the version when FluidVoice answers', async () => {
  const { port } = await stub(HEALTHY);
  const res = await make({ dictationPort: port }).probe();

  assert.equal(res.ok, true);
  assert.equal(res.port, port);
  assert.equal(res.version, '1.6.6');
});

test('probe explains a refused connection in terms of the fix', async () => {
  const port = await deadPort();
  const res = await make({ dictationPort: port }).probe();

  assert.equal(res.ok, false);
  // The likeliest failure by far: the API ships switched off. The message has to
  // name the thing the user can do about it, not the errno.
  assert.match(res.detail, /turn on its local API/i);
  assert.match(res.detail, new RegExp(`127\\.0\\.0\\.1:${port}`));
});

test('probe refuses a server that is not FluidVoice', async () => {
  // 200 and valid JSON, but not the health payload — something else on the port.
  const { port } = await stub({ 'GET /v1/health': (_q, res) => json(res, 200, { hello: 'world' }) });
  const res = await make({ dictationPort: port }).probe();

  assert.equal(res.ok, false);
  assert.match(res.detail, /Something other than FluidVoice/);
});

test('probe refuses a non-200 and says what it got', async () => {
  const { port } = await stub({ 'GET /v1/health': (_q, res) => json(res, 503, { message: 'no' }) });
  const res = await make({ dictationPort: port }).probe();

  assert.equal(res.ok, false);
  assert.match(res.detail, /status 503/);
});

test('probe refuses a body that is not JSON', async () => {
  const { port } = await stub({
    'GET /v1/health': (_q, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>hello</html>');
    },
  });
  assert.equal((await make({ dictationPort: port }).probe()).ok, false);
});

test('probe times out on a server that accepts and never answers', async () => {
  const { port } = await stub({ 'GET /v1/health': () => {} }); // never responds
  const res = await make({ dictationPort: port }, { probe: 150 }).probe();

  assert.equal(res.ok, false);
  assert.equal(res.detail, 'It did not respond.');
});

test('probe takes an override port, which is what the Settings field checks', async () => {
  const { port } = await stub(HEALTHY);
  // Configured port is dead; the override is the live one.
  const res = await make({ dictationPort: await deadPort() }).probe(port);
  assert.equal(res.ok, true);
  assert.equal(res.port, port);
});

test('an unusable port falls back to the default rather than erroring', async () => {
  for (const bad of ['', 'nonsense', 0, 70000, null]) {
    const res = await make({ dictationPort: bad }).probe();
    assert.equal(res.port, DEFAULT_PORT, `${JSON.stringify(bad)} should fall back`);
  }
});

// ------------------------------------------------------------- transcribe

test('a transcript comes back trimmed, and the clip is sent as the raw body', async () => {
  let seen = null;
  const { port } = await stub({
    'POST /v1/transcribe': (req, res, body) => {
      seen = { headers: req.headers, body };
      json(res, 200, { text: '  hello there  ', provider: 'parakeet' });
    },
  });

  const res = await make({ dictationPort: port }).transcribe({ data: clip() });
  assert.deepEqual(res, { ok: true, text: 'hello there' });

  // Raw bytes, not base64 and not a path: the audio never touches disk.
  assert.deepEqual(seen.body, clip());
  assert.equal(seen.headers['content-type'], 'audio/wav');
  assert.equal(seen.headers['x-filename'], 'clip.wav');
});

test('a 200 without a string `text` is a failure, not an empty transcript', async () => {
  for (const body of [{ confidence: 1 }, { text: null }, { text: 42 }, 'not json', '']) {
    const { port } = await stub({ 'POST /v1/transcribe': (_q, res) => json(res, 200, body) });
    const res = await make({ dictationPort: port }).transcribe({ data: clip() });
    assert.equal(res.ok, false, `${JSON.stringify(body)} must not read as success`);
    assert.equal(res.error, 'Transcription failed.');
  }
});

test('an empty transcript is a success carrying empty text', async () => {
  // Distinct from the case above: FluidVoice did transcribe, and heard silence.
  const { port } = await stub({ 'POST /v1/transcribe': (_q, res) => json(res, 200, { text: '' }) });
  assert.deepEqual(await make({ dictationPort: port }).transcribe({ data: clip() }), {
    ok: true,
    text: '',
  });
});

test('a refused connection points at Settings and keeps the reason out of the message', async () => {
  const port = await deadPort();
  const res = await make({ dictationPort: port }).transcribe({ data: clip() });

  assert.equal(res.ok, false);
  assert.match(res.error, /Settings → Push to talk/);
  assert.match(res.detail, /turn on its local API/i);
});

test("a server error is reported with FluidVoice's own message as detail", async () => {
  const { port } = await stub({
    'POST /v1/transcribe': (_q, res) => json(res, 500, { message: 'model not loaded' }),
  });
  const res = await make({ dictationPort: port }).transcribe({ data: clip() });

  assert.equal(res.ok, false);
  assert.equal(res.error, 'Transcription failed.');
  assert.equal(res.detail, 'model not loaded');
});

test('a non-JSON error body is kept rather than discarded', async () => {
  const { port } = await stub({
    'POST /v1/transcribe': (_q, res) => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('upstream died');
    },
  });
  assert.equal((await make({ dictationPort: port }).transcribe({ data: clip() })).detail, 'upstream died');
});

test('transcription times out rather than hanging the card forever', async () => {
  const { port } = await stub({ 'POST /v1/transcribe': () => {} });
  const res = await make({ dictationPort: port }, { run: 150 }).transcribe({ data: clip() });

  assert.equal(res.ok, false);
  assert.equal(res.error, 'Transcription timed out.');
});

test('an empty clip is refused before a socket is opened', async () => {
  // Port is dead: reaching the network at all would fail differently.
  const dictation = make({ dictationPort: await deadPort() });
  for (const data of [null, Buffer.alloc(0)]) {
    assert.deepEqual(await dictation.transcribe({ data }), {
      ok: false,
      error: 'There was nothing to transcribe.',
    });
  }
});

test('an oversize clip is refused here rather than arriving as a 413', async () => {
  const dictation = make({ dictationPort: await deadPort() });
  const res = await dictation.transcribe({ data: Buffer.alloc(MAX_CLIP_BYTES + 1) });

  assert.equal(res.ok, false);
  assert.equal(res.error, 'That recording is too long to transcribe.');
});

test('MAX_CLIP_BYTES matches what FluidVoice will accept', () => {
  // LocalAPI.maxRequestBytes is 25 MB. Refusing at exactly its ceiling is what
  // makes the local check equivalent to the remote one.
  assert.equal(MAX_CLIP_BYTES, 25 * 1024 * 1024);
});

test('a second transcription while one is in flight is refused, and does not wedge', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { port } = await stub({
    'POST /v1/transcribe': async (_q, res) => {
      await gate;
      json(res, 200, { text: 'first' });
    },
  });

  const dictation = make({ dictationPort: port });
  const first = dictation.transcribe({ data: clip() });
  const second = await dictation.transcribe({ data: clip() });
  assert.deepEqual(second, { ok: false, error: 'Still transcribing the last recording.' });

  release();
  assert.equal((await first).text, 'first');

  // The flag is cleared in a finally, so the next one is allowed through.
  assert.equal((await dictation.transcribe({ data: clip() })).ok, true);
});

// --------------------------------------------------- the CLI is really gone

test('no trace of the FluidAudio CLI is left in the source', () => {
  // The CLI was replaced, not wrapped. A half-reverted edit that reintroduced
  // any of it would otherwise pass every other test in the suite: the old path
  // was self-contained, so a second one could sit beside this one working.
  const RETIRED = [
    'fluidaudiocli',
    'FluidAudio',
    'dictationCliPath',
    'dictationModelReady',
    'pickDictationCli',
    'LANCHAT_DICTATION_KEEP',
  ];

  const src = path.join(__dirname, '..', 'src');
  // config.js is the one file that has to name them: its RETIRED_KEYS list is
  // what deletes them from an existing settings file, and it records why. The
  // hole that exemption would open — someone reintroducing one of these as a
  // live default there — is closed from the other side, by the assertion in
  // configRetired.test.js that no retired key appears in DEFAULTS.
  const EXEMPT = path.join(src, 'main', 'config.js');

  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(js|jsx|css|html)$/.test(entry.name) && full !== EXEMPT) {
        const text = fs.readFileSync(full, 'utf8');
        for (const term of RETIRED) {
          if (text.includes(term)) offenders.push(`${path.relative(src, full)}: ${term}`);
        }
      }
    }
  };
  walk(src);

  assert.deepEqual(offenders, [], `FluidAudio CLI leftovers:\n${offenders.join('\n')}`);
});
