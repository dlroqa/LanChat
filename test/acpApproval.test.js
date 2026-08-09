'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAcpTransport } = require('../src/main/agents/transports/acp.js');

// The bug this file exists for:
//
// A `session/request_permission` was parked until a human answered, but the
// clock on the outstanding `session/prompt` kept running. Three minutes later
// the run failed with "ACP call 'session/prompt' timed out." — a transport
// failure that had not happened; nobody had clicked yet. The parked JSON-RPC id
// was then never answered at all, so the agent waited forever.
//
// Both halves are asserted here against a real child process speaking real
// NDJSON, because the interleaving of two timers and a parked request is exactly
// the thing a stub transport would define away.

// A minimal ACP agent. It answers `initialize` and `session/new`, and on a
// prompt it asks permission and then reports what it was told — so the test can
// see what actually reached the agent rather than what the client thought.
const AGENT = `
let buf = '';
process.stdin.setEncoding('utf8');
const write = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let promptId = null;
process.stdin.on('data', (c) => {
  buf += c;
  const lines = buf.split('\\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
    else if (msg.method === 'session/new')
      write({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
    else if (msg.method === 'session/prompt') {
      promptId = msg.id;
      write({
        jsonrpc: '2.0',
        id: 99,
        method: 'session/request_permission',
        params: {
          toolCall: { title: 'rm -rf /' },
          options: [
            { optionId: 'once', name: 'Allow once' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
          ],
        },
      });
    } else if (msg.id === 99 && msg.result) {
      // The answer to our permission request. Report it as the reply text, so a
      // test can assert on what the agent was actually told.
      const outcome = msg.result.outcome || {};
      write({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { text: 'outcome=' + outcome.outcome + ':' + (outcome.optionId || '') },
          },
        },
      });
      write({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
    }
  }
});
`;

function agentScript() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-acp-'));
  const file = path.join(dir, 'agent.js');
  fs.writeFileSync(file, AGENT, 'utf8');
  return file;
}

// process.execPath rather than 'node' — the transport's PATH resolution is not
// what is under test, and a runner without node on PATH should not fail here.
function transportFor(config) {
  return createAcpTransport({
    id: 'agent:test',
    name: 'Stub',
    config: {
      command: process.execPath,
      args: [agentScript()],
      ...config,
      promptInactivityMs: config.timeoutMs,
    },
    // Keep cold child startup independent from the deliberately tiny prompt
    // clocks used to exercise approval behavior.
    timeoutMs: 60000,
  });
}

function run(transport, handlers = {}) {
  return new Promise((resolve) => {
    const seen = { approvals: [], closed: [], done: null, error: null };
    transport.send(
      { text: 'do the thing' },
      {
        onApproval: (req) => {
          seen.approvals.push(req);
          handlers.onApproval?.(req);
        },
        onApprovalClosed: (c) => seen.closed.push(c),
        onDone: (d) => {
          seen.done = d;
          resolve(seen);
        },
        onError: (err) => {
          seen.error = err;
          resolve(seen);
        },
      }
    );
  });
}

test('a prompt waiting on a human does not time out', async () => {
  // The budget is far shorter than the wait. Before the fix this produced
  // "ACP call 'session/prompt' timed out." every time.
  const transport = transportFor({ timeoutMs: 250, approvalTimeoutMs: 60000 });
  const seen = await run(transport, {
    onApproval: (req) => {
      setTimeout(() => transport.answerApproval(req.runId, 'once'), 600);
    },
  });
  await transport.stop();

  assert.equal(seen.error, null, 'no timeout while somebody was being asked');
  assert.equal(seen.approvals.length, 1);
  assert.equal(seen.done.text, 'outcome=selected:once', 'and the agent got the answer');
});

test('an unanswered request is refused, and says so instead of failing', async () => {
  const transport = transportFor({ timeoutMs: 5000, approvalTimeoutMs: 150 });
  const seen = await run(transport); // nobody answers
  await transport.stop();

  assert.equal(seen.error, null, 'not reported as a transport failure');
  // The agent is unblocked rather than left waiting on an answer that can no
  // longer arrive — this is what it was actually told.
  assert.equal(seen.done.text, 'outcome=cancelled:');
  // And whoever was showing the card is told to take it down.
  assert.equal(seen.closed.length, 1);
  assert.equal(seen.closed[0].reason, 'expired');
  assert.equal(seen.closed[0].runId, seen.approvals[0].runId);
});

test('a late answer to a dead request decides nothing', async () => {
  const transport = transportFor({ timeoutMs: 5000, approvalTimeoutMs: 120 });
  const seen = await run(transport);
  // The run is over; the id names nothing now. Answering must be refused rather
  // than writing a JSON-RPC result against a request that has already been
  // cancelled — which would be a second reply to one id.
  assert.equal(await transport.answerApproval(seen.approvals[0].runId, 'once'), false);
  await transport.stop();
});

test('a run ending takes its open requests with it', async () => {
  const transport = transportFor({ timeoutMs: 5000, approvalTimeoutMs: 60000 });
  const closed = [];
  // Not driven through run(): stopping mid-question deliberately leaves the
  // outstanding prompt unsettled — that is what stop() has always done, and the
  // hub sets its own state rather than waiting on it. What matters here is the
  // request, which must not be left parked in a session being torn down.
  const asked = new Promise((resolve) => {
    transport.send(
      { text: 'do the thing' },
      {
        onApproval: resolve,
        onApprovalClosed: (c) => closed.push(c),
      }
    );
  });

  const req = await asked;
  await transport.stop();

  assert.equal(closed.length, 1, 'the question is closed rather than abandoned');
  assert.equal(closed[0].reason, 'stopped');
  assert.equal(closed[0].runId, req.runId);
  // And the id is dead: an answer arriving after the teardown decides nothing.
  assert.equal(await transport.answerApproval(req.runId, 'once'), false);
});
