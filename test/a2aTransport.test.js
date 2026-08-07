'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { createA2aTransport, CARD_PATHS } = require('../src/main/agents/transports/a2a.js');

// The A2A transport, against a server that really speaks A2A.
//
// Everything else in this suite can be proved against a stub that answers
// whatever LanChat happens to ask for. This cannot: the whole value of using a
// published protocol is that something on the other end already understands it,
// and a stub written to match the client would prove only that the client agrees
// with itself.
//
// So the server below is written from the protocol rather than from the
// transport: it serves an Agent Card where the spec says one lives, answers
// JSON-RPC 2.0 at the endpoint its card advertises, and replies with Task
// objects in the 0.3 JSON binding. If the transport stops speaking A2A, this
// stops working — which is the point.

// A minimal A2A server. `script` decides what the task does.
function a2aServer({ script, streaming = false, cardPath = CARD_PATHS[0], name = 'Wren' } = {}) {
  const seen = { cards: [], calls: [], auth: [] };
  const server = http.createServer((req, res) => {
    if (req.headers.authorization) seen.auth.push(req.headers.authorization);

    if (req.method === 'GET') {
      seen.cards.push(req.url);
      if (req.url !== cardPath) {
        res.writeHead(404).end();
        return;
      }
      const card = {
        protocolVersion: '0.3.0',
        name,
        version: '1.4.0',
        url: `http://127.0.0.1:${server.address().port}/`,
        capabilities: { streaming },
        skills: [{ id: 'chat', name: 'Discussion', description: 'Takes part in a discussion' }],
      };
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(card));
      return;
    }

    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const call = JSON.parse(raw);
      seen.calls.push(call);
      script(call, res, seen);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

const rpcOk = (res, id, result) =>
  res
    .writeHead(200, { 'Content-Type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', id, result }));

const rpcErr = (res, id, code, message) =>
  res
    .writeHead(200, { 'Content-Type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));

// A Task in the 0.3 binding, as a server would send one.
const taskResult = (state, text, { id = 'task-1', contextId = 'ctx-1' } = {}) => ({
  kind: 'task',
  id,
  contextId,
  status: {
    state,
    ...(text && { message: { kind: 'message', role: 'agent', parts: [{ kind: 'text', text }] } }),
  },
  artifacts: [],
});

// Server-sent events, framed the way the spec's streaming binding does.
function sse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  return {
    send: (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`),
    end: () => res.end(),
  };
}

function transport(port, { getSecret = () => null } = {}) {
  return createA2aTransport({
    id: 'agent:wren',
    name: 'Wren',
    config: { baseUrl: `http://127.0.0.1:${port}` },
    getSecret,
    timeoutMs: 5000,
  });
}

// Runs one send and collects everything the transport reported.
function run(t, payload) {
  return new Promise((resolve) => {
    const out = { deltas: [], status: [], input: null, done: null, error: null };
    t.send(payload, {
      onDelta: (d) => out.deltas.push(d),
      onStatus: (s) => out.status.push(s),
      onInput: (i) => {
        out.input = i;
      },
      onDone: (d) => {
        out.done = d;
        resolve(out);
      },
      onError: (e) => {
        out.error = e;
        resolve(out);
      },
    });
  });
}

// ---- the card ----

test('the Agent Card is read, and its name and skills are believed', async () => {
  const { server, port } = await a2aServer({ script: () => {} });
  try {
    const t = transport(port);
    const detail = await t.start();
    assert.match(detail.detail, /Wren 1\.4\.0/, 'the card names the agent, not the form');
    assert.match(detail.detail, /A2A/);
    assert.match(detail.detail, /1 skill/);

    const skills = await t.skills();
    assert.deepEqual(
      skills.map((s) => s.id),
      ['chat'],
      'and its skills are what the discover button offers'
    );
  } finally {
    server.close();
  }
});

test('a server still serving the older card path is not refused', async () => {
  // The path was renamed between drafts. A server that predates the rename is
  // still an A2A server, and one extra request at startup is a cheaper answer
  // than declining to speak to it.
  const { server, port, seen } = await a2aServer({ script: () => {}, cardPath: CARD_PATHS[1] });
  try {
    const detail = await transport(port).start();
    assert.match(detail.detail, /Wren/);
    assert.deepEqual(seen.cards, CARD_PATHS, 'the current name was tried first');
  } finally {
    server.close();
  }
});

test('a server with no card at all says so in words somebody can act on', async () => {
  const { server, port } = await a2aServer({ script: () => {}, cardPath: '/nowhere.json' });
  try {
    await assert.rejects(() => transport(port).start(), /No Agent Card/);
  } finally {
    server.close();
  }
});

// ---- asking it something ----

test('a question is put with message/send and the answer comes back', async () => {
  const { server, port, seen } = await a2aServer({
    script: (call, res) => rpcOk(res, call.id, taskResult('completed', 'I would call it Wren.')),
  });
  try {
    const t = transport(port);
    await t.start();
    const out = await run(t, { text: 'what should we call it?' });

    assert.equal(out.error, null);
    assert.equal(out.done.text, 'I would call it Wren.');

    const call = seen.calls[0];
    assert.equal(call.jsonrpc, '2.0', 'JSON-RPC 2.0, as the protocol requires');
    assert.equal(call.method, 'message/send');
    assert.ok(call.id, 'with an id, so the reply can be matched to it');
    assert.equal(call.params.message.kind, 'message');
    assert.equal(call.params.message.role, 'user', 'LanChat is the client here');
    assert.deepEqual(call.params.message.parts, [{ kind: 'text', text: 'what should we call it?' }]);
  } finally {
    server.close();
  }
});

test("a discussion's own A2A message goes on the wire as itself", async () => {
  // The payoff for holding the record in A2A's shape: for this transport alone
  // there is nothing to render into text and nothing to parse back out.
  const { server, port, seen } = await a2aServer({
    script: (call, res) => rpcOk(res, call.id, taskResult('completed', 'noted')),
  });
  try {
    const t = transport(port);
    await t.start();
    await run(t, {
      text: 'the rendered prompt, which should not be used',
      a2aMessage: {
        kind: 'message',
        messageId: 'm-9',
        role: 'user',
        parts: [{ kind: 'text', text: 'the discussion so far' }],
        metadata: { 'lanchat.turn': 4 },
      },
      taskId: 'task-1',
      contextId: 'session:1',
    });

    const sent = seen.calls[0].params.message;
    assert.equal(sent.messageId, 'm-9', 'the round’s own message, not a new one');
    assert.equal(sent.parts[0].text, 'the discussion so far');
    assert.equal(sent.taskId, 'task-1', 'joined to the task it belongs to');
    assert.equal(sent.contextId, 'session:1', 'and to the session it happened in');
    assert.equal(sent.metadata['lanchat.turn'], 4, 'with its metadata intact');
  } finally {
    server.close();
  }
});

test('a bearer token is sent when there is one, and nothing when there is not', async () => {
  const { server, port, seen } = await a2aServer({
    script: (call, res) => rpcOk(res, call.id, taskResult('completed', 'ok')),
  });
  try {
    const t = transport(port, { getSecret: () => 'sekrit' });
    await t.start();
    await run(t, { text: 'q' });
    assert.ok(
      seen.auth.every((a) => a === 'Bearer sekrit'),
      'every request carries it, the card fetch included'
    );
  } finally {
    server.close();
  }

  const bare = await a2aServer({ script: (call, res) => rpcOk(res, call.id, taskResult('completed', 'ok')) });
  try {
    const t = transport(bare.port);
    await t.start();
    await run(t, { text: 'q' });
    assert.deepEqual(bare.seen.auth, [], 'and an agent with no token sends no header');
  } finally {
    bare.server.close();
  }
});

// ---- streaming ----

test('a streaming server’s answer arrives as it is written', async () => {
  const { server, port } = await a2aServer({
    streaming: true,
    script: (call, res) => {
      const s = sse(res);
      s.send({
        jsonrpc: '2.0',
        id: call.id,
        result: {
          kind: 'status-update',
          id: 'task-1',
          status: {
            state: 'working',
            message: { role: 'agent', parts: [{ kind: 'text', text: 'thinking' }] },
          },
        },
      });
      s.send({
        jsonrpc: '2.0',
        id: call.id,
        result: {
          kind: 'artifact-update',
          id: 'task-1',
          artifact: { parts: [{ kind: 'text', text: 'Wren is ' }] },
        },
      });
      s.send({
        jsonrpc: '2.0',
        id: call.id,
        result: {
          kind: 'artifact-update',
          id: 'task-1',
          artifact: { parts: [{ kind: 'text', text: 'a good name.' }] },
        },
      });
      s.send({
        jsonrpc: '2.0',
        id: call.id,
        result: { kind: 'status-update', id: 'task-1', status: { state: 'completed' }, final: true },
      });
      s.end();
    },
  });
  try {
    const t = transport(port);
    await t.start();
    const out = await run(t, { text: 'q' });

    assert.deepEqual(out.deltas, ['Wren is ', 'a good name.'], 'written as it came');
    assert.equal(out.done.text, 'Wren is a good name.', 'and whole at the end');
    assert.deepEqual(out.status, ['thinking'], 'with what it was doing along the way');
  } finally {
    server.close();
  }
});

test('a card that does not declare streaming is not streamed at', async () => {
  const { server, port, seen } = await a2aServer({
    streaming: false,
    script: (call, res) => rpcOk(res, call.id, taskResult('completed', 'ok')),
  });
  try {
    const t = transport(port);
    await t.start();
    await run(t, { text: 'q' });
    assert.equal(seen.calls[0].method, 'message/send', 'the card is believed rather than guessed past');
  } finally {
    server.close();
  }
});

// ---- how a task can end ----

test('a failed task is an error, which drops that agent and leaves the rest talking', async () => {
  const { server, port } = await a2aServer({
    script: (call, res) => rpcOk(res, call.id, taskResult('failed', 'the model is overloaded')),
  });
  try {
    const t = transport(port);
    await t.start();
    const out = await run(t, { text: 'q' });
    assert.equal(out.done, null);
    assert.match(out.error.message, /overloaded/, 'and says why, rather than "it failed"');
  } finally {
    server.close();
  }
});

test('a rejected task is refused rather than reported as broken', async () => {
  const { server, port } = await a2aServer({
    script: (call, res) => rpcOk(res, call.id, taskResult('rejected', 'I will not do that')),
  });
  try {
    const t = transport(port);
    await t.start();
    const out = await run(t, { text: 'q' });
    assert.match(out.error.message, /I will not do that/);
  } finally {
    server.close();
  }
});

test('a task needing credentials names the problem instead of blaming the agent', async () => {
  const { server, port } = await a2aServer({
    script: (call, res) => rpcOk(res, call.id, taskResult('auth-required', '')),
  });
  try {
    const t = transport(port);
    await t.start();
    const out = await run(t, { text: 'q' });
    assert.match(out.error.message, /needs credentials/);
  } finally {
    server.close();
  }
});

test('an agent asking a question is an answer, not a failure', async () => {
  // `input-required` is the agent wanting to be told something. Treating it as a
  // failure would drop it out of a discussion for the crime of asking — and
  // there is a person watching who can answer it.
  const { server, port } = await a2aServer({
    script: (call, res) => rpcOk(res, call.id, taskResult('input-required', 'Which of the two do you mean?')),
  });
  try {
    const t = transport(port);
    await t.start();
    const out = await run(t, { text: 'q' });

    assert.equal(out.error, null, 'not an error');
    assert.equal(out.done.text, 'Which of the two do you mean?', 'the question is the turn it took');
    assert.equal(out.input.question, 'Which of the two do you mean?');
    assert.equal(out.input.taskId, 'task-1', 'and the task to answer on is named');
  } finally {
    server.close();
  }
});

test('a JSON-RPC error is unwrapped rather than read as a good answer', async () => {
  // A transport-level 200 carrying `{ error: … }` is a failure, and one of the
  // two places bad news can arrive from. Missing it would file the absence of an
  // answer as an answer.
  const { server, port } = await a2aServer({
    script: (call, res) => rpcErr(res, call.id, -32601, 'Method not found'),
  });
  try {
    const t = transport(port);
    await t.start();
    const out = await run(t, { text: 'q' });
    assert.equal(out.done, null);
    assert.match(out.error.message, /Method not found/);
  } finally {
    server.close();
  }
});

test('credentials the server rejects are reported as credentials, not as a dead host', async () => {
  const { server, port } = await a2aServer({
    script: (call, res) => res.writeHead(401).end('{}'),
  });
  try {
    const t = transport(port, { getSecret: () => 'wrong' });
    await t.start();
    const out = await run(t, { text: 'q' });
    assert.match(out.error.message, /rejected the credentials/);
  } finally {
    server.close();
  }
});

// ---- calling it off ----

test('stopping a run tells the server to cancel the task', async () => {
  // Dropping the socket stops us listening; only tasks/cancel stops the far end
  // working. A server told nothing carries on spending somebody's tokens on an
  // answer nobody is waiting for.
  let hold = null;
  const { server, port, seen } = await a2aServer({
    streaming: true,
    script: (call, res) => {
      if (call.method === 'tasks/cancel') {
        rpcOk(res, call.id, taskResult('canceled', ''));
        return;
      }
      const s = sse(res);
      s.send({
        jsonrpc: '2.0',
        id: call.id,
        result: { kind: 'status-update', id: 'task-1', status: { state: 'working' } },
      });
      hold = s; // and never finishes, until it is cancelled
    },
  });
  try {
    const t = transport(port);
    await t.start();
    t.send({ text: 'q' }, {});
    await new Promise((r) => setTimeout(r, 150));

    await t.stop();
    assert.ok(
      seen.calls.some((c) => c.method === 'tasks/cancel' && c.params.id === 'task-1'),
      'the task the server gave us is the one we asked it to cancel'
    );
  } finally {
    hold?.end();
    server.close();
  }
});

test('an unreachable server explains itself in the same words the HTTP transport uses', async () => {
  // Nothing is listening on this port. The sentence is worth having rather than
  // "ECONNREFUSED", and it is worth being the *same* sentence — one place to fix
  // the next time it reads badly.
  const t = createA2aTransport({
    id: 'agent:x',
    name: 'Nowhere',
    config: { baseUrl: 'http://127.0.0.1:1' },
    getSecret: () => null,
    timeoutMs: 2000,
  });
  await assert.rejects(() => t.start(), /Nothing is listening|ECONNREFUSED/);
});

// ---- against Hermes' own bytes ----
//
// The server above is written from the spec, which is the right way to prove a
// client speaks a protocol rather than merely agreeing with itself. These two
// go one step further: the payloads are not written here at all. They were
// captured off the wire from a running Hermes A2A server answering
// `message/send` and `message/stream`, and pasted in unedited.
//
// Hermes serves the 1.0 binding and downgrades per request for peers that asked
// in 0.3 — which LanChat does, by sending the 0.3 method names. That downgrade
// is the thing under test here, from this side: if Hermes ever stops speaking
// 0.3 to a 0.3 caller, or LanChat stops reading it, one of these fails.

const HERMES_SEND_RESULT = {
  id: 'task-c8094ef41bb0498f',
  contextId: 'cap-1',
  status: {
    state: 'completed',
    timestamp: '2026-08-06T21:44:00.767Z',
    message: {
      role: 'agent',
      parts: [{ kind: 'text', text: 'ECHO: hello' }],
      messageId: '19c0d78c27ec436981c3c56e0a3eaa59',
      contextId: 'cap-1',
      kind: 'message',
    },
  },
  artifacts: [
    { artifactId: '41458b02b6bb49eabef1dbe9815046b7', parts: [{ kind: 'text', text: 'ECHO: hello' }] },
  ],
  kind: 'task',
};

const HERMES_STREAM_FRAMES = [
  {
    id: 'task-0c3db8e29aa54d84',
    contextId: 'cap-2',
    status: { state: 'submitted', timestamp: '2026-08-06T21:44:00.785Z' },
    kind: 'task',
  },
  {
    taskId: 'task-0c3db8e29aa54d84',
    contextId: 'cap-2',
    status: { state: 'working', timestamp: '2026-08-06T21:44:00.785Z' },
    kind: 'status-update',
    final: false,
  },
  {
    taskId: 'task-0c3db8e29aa54d84',
    contextId: 'cap-2',
    artifact: {
      artifactId: '6d66c1337728439c945ac29b8ecaa502',
      parts: [{ kind: 'text', text: 'ECHO: hello' }],
    },
    kind: 'artifact-update',
  },
  {
    taskId: 'task-0c3db8e29aa54d84',
    contextId: 'cap-2',
    status: { state: 'completed', timestamp: '2026-08-06T21:44:00.787Z' },
    kind: 'status-update',
    final: true,
  },
];

test("Hermes' own reply is read as a finished answer", async () => {
  const { server, port } = await a2aServer({
    script: (call, res) => rpcOk(res, call.id, HERMES_SEND_RESULT),
  });
  try {
    const t = createA2aTransport({
      id: 'agent:hermes',
      name: 'Hermes',
      config: { baseUrl: `http://127.0.0.1:${port}` },
      getSecret: () => null,
      timeoutMs: 5000,
    });
    await t.start();
    const done = await new Promise((resolve, reject) => {
      t.send({ text: 'hello', thread: 'ses-1' }, { onDone: resolve, onError: reject });
    });
    assert.equal(done.text, 'ECHO: hello');
  } finally {
    server.close();
  }
});

test("Hermes' own stream is read as it is written", async () => {
  const { server, port } = await a2aServer({
    streaming: true,
    script: (call, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const frame of HERMES_STREAM_FRAMES) {
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: call.id, result: frame })}\n\n`);
      }
      res.end(': done\n\n');
    },
  });
  try {
    const t = createA2aTransport({
      id: 'agent:hermes',
      name: 'Hermes',
      config: { baseUrl: `http://127.0.0.1:${port}` },
      getSecret: () => null,
      timeoutMs: 5000,
    });
    await t.start();
    const deltas = [];
    const done = await new Promise((resolve, reject) => {
      t.send(
        { text: 'hello', thread: 'ses-2' },
        { onDelta: (d) => deltas.push(d), onDone: resolve, onError: reject }
      );
    });
    // The words arrived as they were written, not only at the end.
    assert.deepEqual(deltas, ['ECHO: hello']);
    assert.equal(done.text, 'ECHO: hello');
  } finally {
    server.close();
  }
});
