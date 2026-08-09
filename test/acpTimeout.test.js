'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAcpTransport } = require('../src/main/agents/transports/acp.js');

const AGENT = `
const fs = require('node:fs');
const cfg = JSON.parse(process.argv[2] || '{}');
const firstProcess = cfg.marker ? !fs.existsSync(cfg.marker) : false;
if (cfg.marker && firstProcess) fs.writeFileSync(cfg.marker, String(process.pid));
let buf = '';
let promptId = null;
let cancelled = false;
process.stdin.setEncoding('utf8');
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (cfg.mode === 'late-after-kill') {
  process.on('SIGTERM', () => {
    if (!firstProcess) process.exit(0);
    setTimeout(() => {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 's1',
          update: { sessionUpdate: 'agent_message_chunk', content: { text: 'stale child' } },
        },
      });
      send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
    }, 250);
    setTimeout(() => process.exit(0), 1200);
  });
} else if (cfg.mode === 'no-ack-recycle') {
  // Exercise the force-termination path rather than letting SIGTERM make the
  // test look successful on its own.
  process.on('SIGTERM', () => {});
}
process.stdin.on('data', (c) => {
  buf += c;
  const lines = buf.split('\\n');
  buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (!msg.method && (msg.id === 99 || msg.id === 100) && cfg.approvalMarker) {
      fs.appendFileSync(cfg.approvalMarker, JSON.stringify(msg) + '\\n');
    } else if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
    } else if (msg.method === 'session/new') {
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
    } else if (msg.method === 'session/prompt') {
      if (cfg.mode === 'activity') {
        for (const delay of [500, 1000, 1500, 2000]) {
          setTimeout(() => send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 's1',
              update: { sessionUpdate: 'tool_call', title: 'still working' },
            },
          }), delay);
        }
        setTimeout(() => {
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 's1',
              update: { sessionUpdate: 'agent_message_chunk', content: { text: 'finished' } },
            },
          });
          send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        }, 2500);
      } else if (cfg.mode === 'inactivity-ack') {
        if (!promptId) promptId = msg.id;
        else if (cancelled) {
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 's1',
              update: { sessionUpdate: 'agent_message_chunk', content: { text: 'after cancel' } },
            },
          });
          send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        }
      } else if (cfg.mode === 'endless-activity') {
        promptId = msg.id;
        const activity = setInterval(() => send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 's1',
            update: { sessionUpdate: 'tool_call', title: 'still working' },
          },
        }), 400);
        setTimeout(() => {
          clearInterval(activity);
          send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        }, 6000);
      } else if (cfg.mode === 'non-progress-updates') {
        promptId = msg.id;
        const noise = setInterval(() =>
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 's1',
              update: { sessionUpdate: 'usage_update', used: 1 },
            },
          }), 400);
        setTimeout(() => {
          clearInterval(noise);
          send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        }, 4000);
      } else if (cfg.mode === 'approval-race') {
        promptId = msg.id;
        send({
          jsonrpc: '2.0',
          id: 99,
          method: 'session/request_permission',
          params: {
            sessionId: 's1',
            toolCall: { title: 'dangerous action' },
            options: [
              { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'deny', name: 'Reject once', kind: 'reject_once' },
            ],
          },
        });
      } else if (cfg.mode === 'no-ack-recycle' && !firstProcess) {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 's1',
            update: { sessionUpdate: 'agent_message_chunk', content: { text: 'fresh child' } },
          },
        });
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      } else if (cfg.mode === 'late-after-kill') {
        promptId = msg.id;
        if (!firstProcess) {
          setTimeout(() => {
            send({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 's1',
                update: { sessionUpdate: 'agent_message_chunk', content: { text: 'fresh child' } },
              },
            });
            send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
          }, 1600);
        }
      }
    } else if (
      msg.method === 'session/cancel' &&
      (cfg.mode === 'inactivity-ack' ||
        cfg.mode === 'endless-activity' ||
        cfg.mode === 'non-progress-updates' ||
        cfg.mode === 'approval-race')
    ) {
      cancelled = true;
      if (cfg.mode === 'inactivity-ack') {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 's1',
            update: { sessionUpdate: 'agent_message_chunk', content: { text: 'late after timeout' } },
          },
        });
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: 's1', update: { sessionUpdate: 'tool_call', title: 'too late' } },
        });
      }
      if (cfg.mode === 'approval-race') {
        if (cfg.cancelMarker) fs.writeFileSync(cfg.cancelMarker, 'cancelled');
        setTimeout(() =>
          send({
            jsonrpc: '2.0',
            id: 100,
            method: 'session/request_permission',
            params: {
              sessionId: 's1',
              toolCall: { title: 'late dangerous action' },
              options: [
                { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'deny', name: 'Reject once', kind: 'reject_once' },
              ],
            },
          }), 50);
      }
      setTimeout(() => {
        send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } });
      }, cfg.mode === 'approval-race' ? 500 : 250);
    }
  }
});
`;

function transportFor(t, agentConfig, timing = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-acp-timeout-'));
  const file = path.join(dir, 'agent.js');
  fs.writeFileSync(file, AGENT, 'utf8');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createAcpTransport({
    id: 'agent:timeout-test',
    name: 'Timeout test',
    config: {
      command: process.execPath,
      args: [file, JSON.stringify(agentConfig)],
      promptInactivityMs: timing.promptInactivityMs,
      maxRunMs: timing.maxRunMs,
      cancelGraceMs: timing.cancelGraceMs,
      processKillGraceMs: timing.processKillGraceMs,
    },
    // Process startup can be slow on loaded CI hosts. Prompt inactivity has its
    // own deliberately tiny clock above; generic ACP setup calls do not need to
    // share it.
    timeoutMs: timing.callTimeoutMs || 60000,
  });
}

function run(transport, handlers = {}) {
  return new Promise((resolve) => {
    const seen = { text: '', statuses: 0, approvals: [], done: null, error: null };
    transport.send(
      { text: 'work' },
      {
        onDelta: (text) => {
          seen.text += text;
        },
        onStatus: () => {
          seen.statuses += 1;
        },
        onApproval: (approval) => {
          seen.approvals.push(approval);
          handlers.onApproval?.(approval);
        },
        onDone: (done) => {
          seen.done = done;
          resolve(seen);
        },
        onError: (error) => {
          seen.error = error;
          resolve(seen);
        },
      }
    );
  });
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for test condition');
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

test('ACP prompt activity refreshes the inactivity deadline', async (t) => {
  const transport = transportFor(t, { mode: 'activity' }, { promptInactivityMs: 1500, maxRunMs: 10000 });
  const seen = await run(transport);
  await transport.stop();

  assert.equal(seen.error, null);
  assert.equal(seen.done.text, 'finished');
  assert.equal(seen.statuses, 4, 'every progress update arrived before completion');
});

test('ACP prompt inactivity is cancelled before the transport accepts another prompt', async (t) => {
  const transport = transportFor(
    t,
    { mode: 'inactivity-ack' },
    { promptInactivityMs: 1000, maxRunMs: 10000, cancelGraceMs: 2000 }
  );

  const timedOut = await run(transport);
  assert.match(timedOut.error?.message || '', /session\/prompt.*timed out/);
  assert.equal(timedOut.text, '', 'post-timeout text was suppressed during cancellation grace');
  assert.equal(timedOut.statuses, 0, 'post-timeout tool status was suppressed during cancellation grace');

  const next = await run(transport);
  await transport.stop();
  assert.equal(next.error, null, 'the acknowledged cancellation left a usable session');
  assert.equal(next.done.text, 'after cancel', 'the agent observed cancellation before the next prompt');
});

test('ACP prompt activity cannot extend a run beyond its hard maximum', async (t) => {
  const transport = transportFor(
    t,
    { mode: 'endless-activity' },
    { promptInactivityMs: 1200, maxRunMs: 2500, cancelGraceMs: 1000 }
  );
  const seen = await run(transport);
  await transport.stop();

  assert.match(seen.error?.message || '', /maximum run time/);
  assert.ok(seen.statuses >= 4, 'the agent was active rather than idle');
  assert.equal(seen.done, null);
});

test('non-progress ACP updates do not extend the prompt inactivity deadline', async (t) => {
  const transport = transportFor(
    t,
    { mode: 'non-progress-updates' },
    { promptInactivityMs: 1200, maxRunMs: 10000, cancelGraceMs: 1000 }
  );
  const seen = await run(transport);
  await transport.stop();

  assert.match(seen.error?.message || '', /session\/prompt.*timed out/);
  assert.equal(seen.done, null);
  assert.equal(seen.text, '');
  assert.equal(seen.statuses, 0);
});

test('a hard timeout denies open and late approval requests before cancellation settles', async (t) => {
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-acp-approval-race-'));
  const approvalMarker = path.join(markerDir, 'approval-responses');
  const cancelMarker = path.join(markerDir, 'cancel-observed');
  t.after(() => fs.rmSync(markerDir, { recursive: true, force: true }));
  const transport = transportFor(
    t,
    { mode: 'approval-race', approvalMarker, cancelMarker },
    { promptInactivityMs: 10000, maxRunMs: 1000, cancelGraceMs: 2000 }
  );
  t.after(() => transport.stop());
  let approval;
  const completion = run(transport, {
    onApproval: (request) => {
      approval = request;
    },
  });

  await waitFor(() => approval && fs.existsSync(cancelMarker));
  assert.equal(
    await transport.answerApproval(approval.runId, 'allow'),
    false,
    'an approval cannot be granted after the prompt deadline'
  );
  const seen = await completion;
  await waitFor(
    () =>
      fs.existsSync(approvalMarker) && fs.readFileSync(approvalMarker, 'utf8').trim().split('\n').length === 2
  );
  await transport.stop();

  assert.match(seen.error?.message || '', /maximum run time/);
  assert.equal(seen.approvals.length, 1, 'a permission request arriving after timeout was not surfaced');
  const responses = fs
    .readFileSync(approvalMarker, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    responses.map((response) => response.result?.outcome?.outcome),
    ['cancelled', 'cancelled']
  );
});

test('an ACP child that ignores cancellation is replaced before the next prompt', async (t) => {
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-acp-generation-'));
  const marker = path.join(markerDir, 'first-child');
  t.after(() => {
    if (fs.existsSync(marker)) {
      const pid = Number(fs.readFileSync(marker, 'utf8'));
      if (processExists(pid)) process.kill(pid, 'SIGKILL');
    }
    fs.rmSync(markerDir, { recursive: true, force: true });
  });
  const transport = transportFor(
    t,
    { mode: 'no-ack-recycle', marker },
    {
      promptInactivityMs: 1000,
      maxRunMs: 10000,
      cancelGraceMs: 500,
      processKillGraceMs: 300,
    }
  );

  const timedOut = await run(transport);
  assert.match(timedOut.error?.message || '', /session\/prompt.*timed out/);

  const next = await run(transport);
  await transport.stop();
  assert.equal(next.error, null, 'the unresponsive process was not reused');
  assert.equal(next.done.text, 'fresh child');
  const firstPid = Number(fs.readFileSync(marker, 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(processExists(firstPid), false, 'the retired process was force-terminated');
});

test('late output and exit from a retired ACP child cannot affect its replacement', async (t) => {
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-acp-late-'));
  const marker = path.join(markerDir, 'first-child');
  t.after(() => fs.rmSync(markerDir, { recursive: true, force: true }));
  const transport = transportFor(
    t,
    { mode: 'late-after-kill', marker },
    { promptInactivityMs: 3000, maxRunMs: 15000, cancelGraceMs: 500 }
  );

  const timedOut = await run(transport);
  assert.match(timedOut.error?.message || '', /session\/prompt.*timed out/);

  const next = await run(transport);
  await transport.stop();
  assert.equal(next.error, null, 'the retired process exit did not tear down the replacement');
  assert.equal(next.done.text, 'fresh child', 'late output from the retired process was discarded');
});
