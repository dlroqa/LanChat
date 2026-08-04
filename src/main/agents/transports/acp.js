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

// How long a permission request may sit unanswered before it is refused for us.
//
// There was no clock on one at all. The only timer was the one below, on the
// outstanding `session/prompt` — which kept running while the request sat
// parked, so a prompt waiting on a human reliably "timed out" after three
// minutes and told the asker the transport had failed. It had not: nobody had
// answered yet. Worse, the parked JSON-RPC id was never replied to, so the agent
// went on waiting forever for an answer that could no longer arrive.
//
// So the two clocks are separated. The prompt's budget is paused for as long as
// a question is on somebody's screen, and the question gets a budget of its own,
// generous enough to cover somebody being away from their desk. When it runs
// out the agent is told `cancelled` — which unblocks it — and the run ends
// saying what actually happened.
const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

// What an unanswered request leaves behind, when the run produced nothing else.
// Deliberately not phrased as a fault: nothing failed, a question went
// unanswered and the safe reading of silence is no.
const UNANSWERED = 'Nobody answered the permission request in time, so it was refused.';

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
  const approvalBudget =
    Number(config.approvalTimeoutMs) > 0 ? Number(config.approvalTimeoutMs) : DEFAULT_APPROVAL_TIMEOUT_MS;

  let child = null;
  let sessionId = null;
  let nextId = 1;
  let buffer = '';
  let stderrTail = '';
  let authMethods = [];
  const pending = new Map(); // json-rpc id -> {resolve, reject, timer, method}
  const openApprovals = new Map(); // our approval id -> {rpcId, timer}
  let liveHandlers = null; // handlers for the in-flight prompt
  // Requests that went unanswered during the current run. Counted rather than
  // flagged: one prompt can raise several.
  let unanswered = 0;

  function write(obj) {
    if (!child || child.killed) throw new Error('The agent process is not running.');
    child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  // Every call is on the clock, except while a human is being asked something.
  //
  // Held and released together rather than per call: what is being waited on is
  // a person, and every outstanding call is waiting on them equally. Releasing
  // restarts the budget from full, which is the point — a call that spent ten
  // minutes parked has had none of its own time.
  function holdBudgets() {
    for (const entry of pending.values()) {
      if (!entry.timer) continue;
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  function releaseBudgets() {
    if (openApprovals.size) return; // somebody is still being asked
    for (const [rpcId, entry] of pending) {
      if (entry.timer) continue;
      entry.timer = setTimeout(() => {
        if (pending.delete(rpcId)) entry.reject(new Error(`ACP call '${entry.method}' timed out.`));
      }, budget);
    }
  }

  // Empty the call table, cancelling each entry's clock as it goes. The timers
  // used to be dropped rather than cleared, which left a three-minute handle
  // alive per abandoned call for no purpose; now that a paused call can hold one
  // for far longer, clearing them is the difference between tidy and a leak.
  // `failure` is null when nothing is waiting to be told (stop()).
  function failPending(failure) {
    for (const [, entry] of pending) {
      if (entry.timer) clearTimeout(entry.timer);
      if (failure) entry.reject(failure);
    }
    pending.clear();
  }

  function call(method, params) {
    const rpcId = nextId++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, method, timer: null };
      pending.set(rpcId, entry);
      // Started only if nothing is currently waiting on a human. A call made
      // while a question is open starts paused, exactly as one paused mid-flight
      // does, rather than being the one call the hold does not cover.
      if (!openApprovals.size) {
        entry.timer = setTimeout(() => {
          if (pending.delete(rpcId)) reject(new Error(`ACP call '${method}' timed out.`));
        }, budget);
      }
      try {
        write({ jsonrpc: '2.0', id: rpcId, method, params: params || {} });
      } catch (err) {
        if (entry.timer) clearTimeout(entry.timer);
        pending.delete(rpcId);
        reject(err);
      }
    });
  }

  // Reply to a parked permission request and take it off the books, whatever
  // the reason. Every path out of an open approval goes through here: answered,
  // expired, or the run it belonged to ending underneath it.
  //
  // Writing may fail — the agent may already be gone — and that is not a
  // failure worth propagating: the request dies with the process either way.
  function closeApproval(approvalId, choice, reason) {
    const held = openApprovals.get(approvalId);
    if (!held) return false;
    openApprovals.delete(approvalId);
    if (held.timer) clearTimeout(held.timer);
    const outcome =
      choice === 'deny' || choice === 'cancelled'
        ? { outcome: 'cancelled' }
        : { outcome: 'selected', optionId: choice };
    try {
      write({ jsonrpc: '2.0', id: held.rpcId, result: { outcome } });
    } catch {}
    // Whoever is showing this question needs to know it is over — the local
    // card, and any peer the owner delegated it to.
    if (reason) liveHandlers?.onApprovalClosed?.({ runId: approvalId, reason });
    releaseBudgets();
    return true;
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
      else if (update.sessionUpdate === 'tool_call')
        liveHandlers?.onStatus?.(`Running ${update.title || 'a tool'}…`);
      else if (update.sessionUpdate === 'tool_call_update' && update.status === 'completed')
        liveHandlers?.onStatus?.(null);
      return;
    }

    if (msg.method === 'session/request_permission') {
      // Park the JSON-RPC request id; the reply goes back only once a human answers.
      const options = (msg.params?.options || []).map((o) => ({
        id: o.optionId,
        label: o.name,
        kind: o.kind,
      }));
      const approvalId = `acp-${msg.id}`;
      // The question is now the thing being waited on, so the run stops being
      // charged for the wait.
      holdBudgets();
      const timer = setTimeout(() => {
        unanswered += 1;
        closeApproval(approvalId, 'deny', 'expired');
      }, approvalBudget);
      // Never let an unanswered question hold the process open on its own.
      if (typeof timer.unref === 'function') timer.unref();
      openApprovals.set(approvalId, { rpcId: msg.id, timer });
      liveHandlers?.onApproval?.({
        runId: approvalId,
        command: msg.params?.toolCall?.title || msg.params?.toolCall?.rawInput || 'a tool call',
        choices: options.length
          ? options
          : [
              { id: 'allow', label: 'Allow' },
              { id: 'deny', label: 'Deny' },
            ],
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
        err.code === 'ENOENT' ? localError('The agent could not be started.', notFoundMessage(file)) : err;
      failPending(failure);
    });
    child.on('exit', () => {
      child = null;
      sessionId = null;
      // Any question still on a screen died with the process. Taken off the
      // books here so nothing can be answered into a session that is gone, and
      // so the cards showing it come down rather than waiting out a ten-minute
      // clock for an agent that no longer exists.
      for (const [approvalId] of [...openApprovals]) {
        closeApproval(approvalId, 'deny', 'ended');
      }
      const failure = localError('The agent stopped unexpectedly.', stderrTail.trim() || null);
      failPending(failure);
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
      throw localError(
        'The agent did not start a session.',
        [err.message, authHint()].filter(Boolean).join(' ')
      );
    }
    sessionId = session?.sessionId;
    if (!sessionId) throw localError('The agent did not start a session.', authHint());
    return {
      detail: `ACP session with ${init?.agentInfo?.name || file} (protocol v${init?.protocolVersion ?? PROTOCOL_VERSION})`,
    };
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
    unanswered = 0;
    liveHandlers = {
      ...handlers,
      onDelta: (d) => {
        collected += d;
        handlers.onDelta?.(d);
      },
    };
    try {
      if (!child) await start();
      const result = await call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
      const answer = collected.trim();
      // A run can end without producing anything — refused, cut off at a token
      // limit, cancelled. Saying which is far better than an empty bubble, but
      // only when there is genuinely nothing to show: a reply that did arrive
      // is never second-guessed by the reason it stopped.
      //
      // A question nobody answered outranks the stop reason. The agent will
      // report `cancelled`, which is true and useless — it says the run was
      // called off without saying that what called it off was a prompt sitting
      // on a screen with nobody in front of it.
      handlers.onDone?.({
        text: answer || (unanswered ? UNANSWERED : describeStop(result?.stopReason)),
      });
    } catch (err) {
      handlers.onError?.(err);
    } finally {
      // Whatever ended the run ends its open questions with it. Without this a
      // request outlives the thing it was asked for, and an answer arriving late
      // would write a JSON-RPC result against a run that is already over.
      for (const [approvalId] of [...openApprovals]) {
        closeApproval(approvalId, 'deny', 'ended');
      }
      liveHandlers = null;
    }
  }

  // Somebody answered. Returning false rather than throwing is how this says the
  // question is no longer open — expired, already answered, or belonging to a run
  // that has since ended — which is what stops a late click from writing a
  // JSON-RPC result for an id that means nothing any more.
  async function answerApproval(approvalId, choice) {
    return closeApproval(approvalId, choice, null);
  }

  async function stop() {
    // Deny anything still waiting, so the agent unblocks rather than hanging.
    for (const [approvalId] of [...openApprovals]) {
      closeApproval(approvalId, 'deny', 'stopped');
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
    failPending(null);
  }

  return { id, name, kind: 'acp', start, send, stop, answerApproval };
}

module.exports = { createAcpTransport };
