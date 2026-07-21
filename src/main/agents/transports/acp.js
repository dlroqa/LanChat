'use strict';

const { spawn } = require('node:child_process');

// ACP (Agent Client Protocol) transport — newline-delimited JSON-RPC 2.0 over the
// agent's stdio. Unlike the `command` transport this keeps one long-lived child
// process holding a session, so conversation context persists across messages.
//
// It is also the second transport with a real approval channel: the agent calls
// `session/request_permission` on us, and we hold that request open until the
// local user answers. Nothing is auto-approved.
//
// Verified against Hermes' ACP adapter (protocol version 1): methods
// `initialize`, `session/new`, `session/prompt`, `session/cancel`; agent-side
// notifications arrive as `session/update`.

const PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 180000;

function createAcpTransport({ id, name, config, timeoutMs }) {
  const file = String(config.command || 'hermes');
  const args = Array.isArray(config.args) && config.args.length ? config.args.map(String) : ['acp'];
  const cwd = config.cwd || process.cwd();
  const budget = timeoutMs || DEFAULT_TIMEOUT_MS;

  let child = null;
  let sessionId = null;
  let nextId = 1;
  let buffer = '';
  const pending = new Map(); // json-rpc id -> {resolve, reject}
  const openApprovals = new Map(); // our approval id -> json-rpc request id
  let liveHandlers = null; // handlers for the in-flight prompt

  function write(obj) {
    if (!child || child.killed) throw new Error('The agent process is not running.');
    child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  function call(method, params) {
    const rpcId = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(rpcId, { resolve, reject });
      const timer = setTimeout(() => {
        if (pending.delete(rpcId)) reject(new Error(`ACP call '${method}' timed out.`));
      }, budget);
      pending.get(rpcId).timer = timer;
      try {
        write({ jsonrpc: '2.0', id: rpcId, method, params: params || {} });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(rpcId);
        reject(err);
      }
    });
  }

  // Agent -> client notifications and requests.
  function handleInbound(msg) {
    if (msg.id !== undefined && msg.method === undefined) {
      // A response to one of our calls.
      const entry = pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message || 'ACP error'));
      else entry.resolve(msg.result);
      return;
    }

    if (msg.method === 'session/update') {
      const update = msg.params?.update || {};
      const text = update.content?.text || '';
      if (update.sessionUpdate === 'agent_message_chunk' && text) liveHandlers?.onDelta?.(text);
      else if (update.sessionUpdate === 'tool_call') liveHandlers?.onStatus?.(`Running ${update.title || 'a tool'}…`);
      else if (update.sessionUpdate === 'tool_call_update' && update.status === 'completed') liveHandlers?.onStatus?.(null);
      return;
    }

    if (msg.method === 'session/request_permission') {
      // Park the JSON-RPC request id; the reply goes back only once a human answers.
      const options = (msg.params?.options || []).map((o) => ({ id: o.optionId, label: o.name, kind: o.kind }));
      const approvalId = `acp-${msg.id}`;
      openApprovals.set(approvalId, msg.id);
      liveHandlers?.onApproval?.({
        runId: approvalId,
        command: msg.params?.toolCall?.title || msg.params?.toolCall?.rawInput || 'a tool call',
        choices: options.length ? options : [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }],
      });
    }
  }

  function onStdout(chunk) {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        handleInbound(JSON.parse(trimmed));
      } catch {
        // Non-JSON noise on stdout (banners, logs) is not fatal — skip it.
      }
    }
  }

  async function start() {
    child = spawn(file, args, { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onStdout);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => {});
    child.on('error', (err) => {
      for (const [, entry] of pending) entry.reject(err);
      pending.clear();
    });
    child.on('exit', () => {
      child = null;
      sessionId = null;
      for (const [, entry] of pending) entry.reject(new Error('The agent process exited.'));
      pending.clear();
    });

    const init = await call('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: 'LanChat', version: '1' },
    });
    const session = await call('session/new', { cwd, mcpServers: [] });
    sessionId = session?.sessionId;
    if (!sessionId) throw new Error('The agent did not return a session id.');
    return { detail: `ACP session with ${init?.agentInfo?.name || file} (protocol v${init?.protocolVersion ?? PROTOCOL_VERSION})` };
  }

  async function send({ text }, handlers = {}) {
    liveHandlers = handlers;
    let collected = '';
    const wrapped = { ...handlers, onDelta: (d) => { collected += d; handlers.onDelta?.(d); } };
    liveHandlers = wrapped;
    try {
      if (!child) await start();
      await call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
      handlers.onDone?.({ text: collected.trim() });
    } catch (err) {
      handlers.onError?.(err);
    } finally {
      liveHandlers = null;
    }
  }

  async function answerApproval(approvalId, choice) {
    const rpcId = openApprovals.get(approvalId);
    if (rpcId === undefined) return false;
    openApprovals.delete(approvalId);
    const outcome =
      choice === 'deny' || choice === 'cancelled'
        ? { outcome: 'cancelled' }
        : { outcome: 'selected', optionId: choice };
    write({ jsonrpc: '2.0', id: rpcId, result: { outcome } });
    return true;
  }

  async function stop() {
    // Deny anything still waiting, so the agent unblocks rather than hanging.
    for (const [approvalId] of openApprovals) {
      try {
        await answerApproval(approvalId, 'deny');
      } catch {}
    }
    if (sessionId && child) {
      try {
        write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
      } catch {}
    }
    if (child) {
      try {
        child.kill('SIGTERM');
      } catch {}
    }
    child = null;
    sessionId = null;
    pending.clear();
  }

  return { id, name, kind: 'acp', start, send, stop, answerApproval };
}

module.exports = { createAcpTransport };
