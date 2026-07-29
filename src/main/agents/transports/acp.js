'use strict';

const { spawn } = require('node:child_process');
const { resolveExecutable, childEnv, notFoundMessage, localError } = require('./resolve');

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

// What we ask for, and what we are actually able to speak. An agent answers
// `initialize` with the version it will use, and until now that answer was read
// only to build a status line — so an agent replying with something this code
// was never written against was treated as a success and then misunderstood.
//
// The check is deliberately one-sided: only a version *above* what we implement
// is refused. A missing value means an agent that predates the field, and a
// lower one is an agent being conservative — neither is a reason to refuse a
// setup that works. Raising the ceiling later means adding to SUPPORTED.
const PROTOCOL_VERSION = 1;
const SUPPORTED_PROTOCOL_VERSIONS = [1];
const MAX_PROTOCOL_VERSION = Math.max(...SUPPORTED_PROTOCOL_VERSIONS);

const DEFAULT_TIMEOUT_MS = 180000;

// Enough of the agent's stderr to explain a failure, and no more. Kept for the
// owner only: it is written by a program on this machine and routinely names
// paths, hosts and configuration, so it travels as `detail` and is never
// relayed to a peer. Matches the tail spawn.js keeps for the same reason.
const STDERR_TAIL_CHARS = 2000;

// A run that ended the way runs normally end. Anything else is worth saying out
// loud rather than rendering as an empty reply.
const NORMAL_STOP_REASONS = new Set(['end_turn', 'completed', undefined, null]);

function createAcpTransport({ id, name, config, timeoutMs }) {
  const command = String(config.command || 'hermes');
  const args = Array.isArray(config.args) && config.args.length ? config.args.map(String) : ['acp'];
  const cwd = config.cwd || process.cwd();
  const budget = timeoutMs || DEFAULT_TIMEOUT_MS;

  let child = null;
  let sessionId = null;
  let nextId = 1;
  let buffer = '';
  let stderrTail = '';
  let authMethods = [];
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

  // What a failed session start can usefully tell the owner: whatever the agent
  // wrote to stderr, and the ways it said it can be authenticated. Hermes
  // advertises one of these specifically for a machine where it has not been
  // configured yet, which is the single most likely reason a session will not
  // open — and is invisible without this.
  //
  // Names and ids only. A method's `description` is prose that names configured
  // providers, and none of this is peer-safe in any case: it goes in `detail`.
  function authHint() {
    const parts = [];
    if (stderrTail.trim()) parts.push(stderrTail.trim());
    if (authMethods.length) {
      const offered = authMethods.map((m) => m?.name || m?.id).filter(Boolean);
      if (offered.length) parts.push(`The agent offers: ${offered.join(', ')}.`);
    }
    return parts.join(' ') || null;
  }

  async function start() {
    // Resolved per start, not once when the transport is built, so an agent
    // installed after the record was saved is picked up on the next attempt
    // rather than needing the whole record re-entered.
    const file = resolveExecutable(command);
    stderrTail = '';
    authMethods = [];
    child = spawn(file, args, { cwd, env: childEnv(), shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onStdout);
    child.stderr.setEncoding('utf8');
    // Kept rather than discarded: an agent that dies during startup says why
    // here and nowhere else, and without it the only symptom is a timeout.
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.on('error', (err) => {
      // A missing command is the one failure with a fix the user can act on,
      // and Node's own text ("spawn hermes ENOENT") does not hint at it. The
      // command name is local, so it travels as detail.
      const failure =
        err.code === 'ENOENT'
          ? localError('The agent could not be started.', notFoundMessage(file))
          : err;
      for (const [, entry] of pending) entry.reject(failure);
      pending.clear();
    });
    child.on('exit', () => {
      child = null;
      sessionId = null;
      const failure = localError('The agent stopped unexpectedly.', stderrTail.trim() || null);
      for (const [, entry] of pending) entry.reject(failure);
      pending.clear();
    });

    const init = await call('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: 'LanChat', version: '1' },
    });

    const negotiated = init?.protocolVersion;
    if (typeof negotiated === 'number' && negotiated > MAX_PROTOCOL_VERSION) {
      throw localError(
        'This agent speaks a newer version of ACP than LanChat understands.',
        `The agent negotiated protocol v${negotiated}; this version of LanChat speaks up to v${MAX_PROTOCOL_VERSION}.`
      );
    }

    // Remembered for the failure below rather than acted on. One of Hermes'
    // methods opens an interactive setup in a terminal, which is the user's to
    // run — LanChat naming it is help, LanChat triggering it is not.
    authMethods = Array.isArray(init?.authMethods) ? init.authMethods : [];

    let session;
    try {
      session = await call('session/new', { cwd, mcpServers: [] });
    } catch (err) {
      // The agent's own words are the detail; what reaches a peer is only that
      // the session could not be opened.
      throw localError('The agent did not start a session.', [err.message, authHint()].filter(Boolean).join(' '));
    }
    sessionId = session?.sessionId;
    if (!sessionId) throw localError('The agent did not start a session.', authHint());
    return { detail: `ACP session with ${init?.agentInfo?.name || file} (protocol v${init?.protocolVersion ?? PROTOCOL_VERSION})` };
  }

  // Why an empty answer is empty. Unrecognised reasons are reported rather than
  // swallowed — a stop reason this code has never heard of is exactly the case
  // where the user most needs to be told something happened.
  function describeStop(reason) {
    if (NORMAL_STOP_REASONS.has(reason)) return '';
    if (reason === 'refusal') return 'The agent declined to answer.';
    if (reason === 'max_tokens') return 'The agent ran out of room before it could answer.';
    if (reason === 'cancelled') return 'The run was cancelled.';
    return `The agent stopped early (${reason}).`;
  }

  async function send({ text }, handlers = {}) {
    // session/prompt resolves with only a stop reason, so the reply text has to
    // be accumulated from the session/update chunks as they arrive.
    let collected = '';
    liveHandlers = { ...handlers, onDelta: (d) => { collected += d; handlers.onDelta?.(d); } };
    try {
      if (!child) await start();
      const result = await call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
      const answer = collected.trim();
      // A run can end without producing anything — refused, cut off at a token
      // limit, cancelled. Saying which is far better than an empty bubble, but
      // only when there is genuinely nothing to show: a reply that did arrive
      // is never second-guessed by the reason it stopped.
      handlers.onDone?.({ text: answer || describeStop(result?.stopReason) });
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
