'use strict';

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { describeSocketError } = require('./http.js');
const { STATE, textOf } = require('../../sessions/a2a.js');

// An agent that speaks Agent2Agent.
//
// The fifth transport, beside `http`, `command`, `acp` and `ssh`, and the only
// one that talks a protocol LanChat did not define. The others reach a program
// this machine knows how to start or an API shaped like Hermes'; this one
// reaches anything that publishes an Agent Card and answers JSON-RPC, which is
// the point of using a published protocol at all.
//
// What it does *not* do is make LanChat an A2A server. Agents added this way are
// clients of somebody else's; they take their turns in a discussion exactly as a
// local agent does, and everything about rounds, budgets and turn-taking stays
// where it is. This file is a way in, not a second architecture.
//
// ---- which A2A ----
//
// The 0.3 JSON binding, pinned by sessions/a2a.js and imported from it rather
// than spelled again here. That file is the one place a version bump happens —
// see its header for why the 1.0 draft is a different document rather than a
// newer one.
//
// ---- what is deliberately missing ----
//
// `answerApproval`. A2A has no tool-approval protocol, so an agent reached this
// way cannot put a command in front of the user for authorisation — the same
// position `http`, `command` and `ssh` are in, and the reason ACP is the
// recommended transport in the agent form. `input-required` is *not* an approval
// and is not treated as one: it is the agent asking a question, which is what
// pausing a round and letting the person answer is for.

const DEFAULT_TIMEOUT_MS = 180000;

// Where an Agent Card lives. The current name first, then the one the earlier
// drafts used — a server that predates the rename is still an A2A server, and
// one extra request on startup is a cheaper answer than refusing to talk to it.
const CARD_PATHS = ['/.well-known/agent-card.json', '/.well-known/agent.json'];

// JSON-RPC methods. Named here rather than inline so a typo is a missing
// constant instead of a 404 at the far end.
const METHOD = Object.freeze({
  send: 'message/send',
  stream: 'message/stream',
  get: 'tasks/get',
  cancel: 'tasks/cancel',
});

// States that mean the far end has stopped working and is not coming back.
const TERMINAL = new Set([STATE.completed, STATE.failed, STATE.canceled, STATE.rejected]);

function createA2aTransport({ id, name, config, getSecret, timeoutMs }) {
  const baseUrl = String(config.baseUrl || 'http://127.0.0.1:9999').replace(/\/+$/, '');
  const budget = timeoutMs || DEFAULT_TIMEOUT_MS;

  // The card, once start() has read it. `endpoint` is where requests go, which
  // is the card's own url when it names one — a server is entitled to serve its
  // card and its API from different places, and believing the card is the whole
  // reason for fetching it.
  let card = null;
  let endpoint = baseUrl;
  let streaming = false;

  // The task in flight: `{ taskId, contextId, req, settle }`.
  let active = null;

  function request(method, urlPath, { body, stream, signalTimeout } = {}) {
    const url = new URL(urlPath.startsWith('http') ? urlPath : endpoint + urlPath);
    const mod = url.protocol === 'https:' ? https : http;
    const secret = getSecret();
    const headers = { Accept: stream ? 'text/event-stream' : 'application/json' };
    if (secret) headers.Authorization = `Bearer ${secret}`;
    let payload = null;
    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body), 'utf8');
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    return new Promise((resolve, reject) => {
      const req = mod.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method,
          headers,
        },
        (res) => resolve({ res, req })
      );
      req.setTimeout(signalTimeout || budget, () => req.destroy(new Error('Request timed out.')));
      // The same well-worked sentences the HTTP transport produces. A refused
      // connection is a refused connection whatever protocol was going to be
      // spoken over it, and a second set of prose saying so would be two places
      // to fix the next time one of them reads badly.
      req.on('error', (err) => reject(describeSocketError(err, url)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  function readJson(res) {
    return new Promise((resolve, reject) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        raw += c;
      });
      res.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          reject(new Error(`Unexpected response from ${endpoint}: ${raw.slice(0, 200)}`));
        }
      });
      res.on('error', reject);
    });
  }

  // One JSON-RPC call, with the envelope checked.
  //
  // A transport-level 200 carrying `{ error: … }` is a failure, and unwrapping
  // it here means every caller below reads a result or throws, rather than each
  // remembering to look in two places for the same bad news.
  async function rpc(method, params, { signalTimeout } = {}) {
    const { res } = await request('POST', '/', {
      body: { jsonrpc: '2.0', id: crypto.randomUUID(), method, params },
      signalTimeout,
    });
    const body = await readJson(res);
    if (res.statusCode === 401 || res.statusCode === 403) {
      throw new Error('The A2A server rejected the credentials. Check the token and try again.');
    }
    if (res.statusCode >= 400 && !body.error) {
      throw new Error(`The A2A server returned HTTP ${res.statusCode}.`);
    }
    if (body.error) {
      throw new Error(body.error.message || `The A2A server refused the call (${body.error.code}).`);
    }
    return body.result;
  }

  async function fetchCard() {
    let last = null;
    for (const cardPath of CARD_PATHS) {
      try {
        const { res } = await request('GET', `${baseUrl}${cardPath}`, { signalTimeout: 10000 });
        if (res.statusCode === 404) {
          res.resume();
          last = new Error(`No Agent Card at ${baseUrl}${cardPath}.`);
          continue;
        }
        const body = await readJson(res);
        if (res.statusCode >= 400) {
          last = new Error(`The Agent Card could not be read (HTTP ${res.statusCode}).`);
          continue;
        }
        if (!body || typeof body !== 'object' || !body.name) {
          last = new Error(`${baseUrl}${cardPath} did not look like an Agent Card.`);
          continue;
        }
        return body;
      } catch (err) {
        last = err;
      }
    }
    throw last || new Error(`No Agent Card under ${baseUrl}.`);
  }

  async function start() {
    card = await fetchCard();
    // A card that names its own service endpoint is believed; one that does not
    // is served from where it was found.
    endpoint = String(card.url || baseUrl).replace(/\/+$/, '');
    streaming = Boolean(card.capabilities && card.capabilities.streaming);
    const skills = Array.isArray(card.skills) ? card.skills.length : 0;
    return {
      detail:
        `Connected to ${card.name}${card.version ? ` ${card.version}` : ''} at ${endpoint}` +
        ` (A2A${streaming ? ', streaming' : ''}${skills ? `, ${skills} skill${skills > 1 ? 's' : ''}` : ''})`,
    };
  }

  // What came back, whatever shape it came back in.
  //
  // A server may answer `message/send` with a Task or, for something it finished
  // without tracking, with a bare Message. Both are valid and both mean "here is
  // your answer", so both are read.
  function readResult(result) {
    if (!result) return { state: STATE.failed, text: '', message: 'The A2A server sent nothing back.' };
    if (result.kind === 'message' || (result.parts && !result.status)) {
      return { state: STATE.completed, text: textOf(result), taskId: result.taskId || null };
    }
    const status = result.status || {};
    return {
      state: status.state || STATE.completed,
      // The answer is the last thing the agent said. `status.message` is where a
      // server puts the words that go with a state — the question it is asking
      // for `input-required`, the reason for `failed` — and the artifacts are
      // where a finished answer lives when it produced one.
      text: artifactText(result) || textOf(status.message),
      message: textOf(status.message),
      taskId: result.id || null,
      contextId: result.contextId || null,
    };
  }

  function artifactText(taskResult) {
    const parts = (taskResult.artifacts || []).flatMap((a) => (a && a.parts) || []);
    return parts.length ? textOf({ parts }) : '';
  }

  // A finished task, turned into the one outcome the round upstream understands.
  //
  // The mapping is the point of this function existing: `input-required` is the
  // agent asking rather than answering, and it is reported as an answer carrying
  // the question — a round that treated it as a failure would drop the agent out
  // of the discussion for the crime of wanting to be told something.
  function settle(outcome, handlers) {
    const { onDone, onError, onInput } = handlers;
    switch (outcome.state) {
      case STATE.completed:
        onDone?.({ text: outcome.text });
        return;
      case STATE.inputRequired:
        onInput?.({ question: outcome.message || outcome.text, taskId: outcome.taskId });
        onDone?.({ text: outcome.text || outcome.message });
        return;
      case STATE.authRequired:
        onError?.(new Error(`${name} needs credentials that have not been given to it.`));
        return;
      case STATE.canceled:
        onDone?.({ text: outcome.text || '(stopped)' });
        return;
      case STATE.rejected:
        onError?.(new Error(outcome.message || `${name} declined the request.`));
        return;
      case STATE.failed:
      default:
        onError?.(new Error(outcome.message || `${name} could not answer.`));
    }
  }

  // The message to put on the wire.
  //
  // `a2aMessage` is the round's own A2A object, handed down untouched: the
  // discussion record is already in this shape, so for this transport alone
  // there is nothing to render and nothing to parse back. `text` is the rendered
  // prompt every other transport gets, and is the fallback for anything asking
  // outside a discussion — a task, a one-off question in the agent's own thread.
  function outgoing({ text, a2aMessage }, taskId, contextId) {
    if (a2aMessage) {
      return {
        ...a2aMessage,
        ...(taskId && { taskId }),
        ...(contextId && { contextId }),
      };
    }
    return {
      kind: 'message',
      messageId: crypto.randomUUID(),
      role: 'user',
      parts: [{ kind: 'text', text: String(text == null ? '' : text) }],
      ...(taskId && { taskId }),
      ...(contextId && { contextId }),
    };
  }

  async function send(payload, handlers = {}) {
    const { onDelta, onStatus, onError } = handlers;
    const { thread, taskId, contextId } = payload;
    try {
      const message = outgoing(payload, taskId, contextId || thread);
      const params = { message };

      if (!streaming) {
        const result = await rpc(METHOD.send, params);
        const outcome = readResult(result);
        active = null;
        settle(outcome, handlers);
        return;
      }

      // Streaming. The events are the same objects as the non-streaming result,
      // arriving as they happen: status updates while it works, artifact updates
      // as the answer is written, and a final event with the terminal state.
      const { res, req } = await request('POST', '/', {
        body: { jsonrpc: '2.0', id: crypto.randomUUID(), method: METHOD.stream, params },
        stream: true,
      });
      if (res.statusCode >= 400) {
        res.resume();
        throw new Error(`The A2A server refused to stream (HTTP ${res.statusCode}).`);
      }

      let buffer = '';
      let text = '';
      let settled = false;
      let last = null;
      active = { req, taskId: null, contextId: contextId || thread };

      const finish = (err, outcome) => {
        if (settled) return;
        settled = true;
        active = null;
        try {
          req.destroy();
        } catch {}
        if (err) onError?.(err);
        else settle(outcome, handlers);
      };

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        const frames = buffer.split('\n\n');
        buffer = frames.pop() || '';
        for (const frame of frames) {
          const line = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          let evt;
          try {
            evt = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          const result = evt.result || evt;
          if (result.id && active) active.taskId = result.id;

          // An artifact arriving in pieces is the answer being written.
          if (result.kind === 'artifact-update' || result.artifact) {
            const piece = textOf({ parts: (result.artifact && result.artifact.parts) || [] });
            if (piece) {
              text += piece;
              onDelta?.(piece);
            }
            continue;
          }

          const status = result.status || (result.kind === 'status-update' ? result : null);
          if (status && status.state) {
            last = status.state;
            const said = textOf(status.message);
            if (last === STATE.working && said) onStatus?.(said);
            if (TERMINAL.has(last) || last === STATE.inputRequired) {
              finish(null, {
                state: last,
                text: text || artifactText(result) || said,
                message: said,
                taskId: result.id || (active && active.taskId) || null,
              });
              return;
            }
          }
        }
      });
      // A stream that ends without a terminal state has still ended. Whatever
      // arrived is the answer, because there is nothing else coming.
      res.on('end', () => finish(null, { state: last || STATE.completed, text }));
      res.on('error', (err) => finish(err));
    } catch (err) {
      active = null;
      onError?.(err);
    }
  }

  // Calling off whatever is out.
  //
  // Both halves matter: dropping the socket stops us listening, and `tasks/cancel`
  // is what stops the far end working. A server told nothing would carry on
  // spending somebody's tokens on an answer no one is waiting for.
  async function stop() {
    const current = active;
    active = null;
    if (!current) return;
    try {
      current.req?.destroy();
    } catch {}
    if (!current.taskId) return;
    try {
      await rpc(METHOD.cancel, { id: current.taskId }, { signalTimeout: 10000 });
    } catch {
      // Already finished, or gone. Either way there is nothing left to cancel.
    }
  }

  // What this agent says it can do, for the form's "discover" button. An A2A
  // server's skills are the nearest thing it has to Hermes' profiles.
  async function skills() {
    if (!card) card = await fetchCard();
    return (card.skills || []).map((s) => ({ id: s.id, name: s.name || s.id, description: s.description }));
  }

  return { id, name, kind: 'a2a', start, send, stop, skills };
}

module.exports = { createA2aTransport, CARD_PATHS, METHOD };
