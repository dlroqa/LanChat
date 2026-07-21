'use strict';

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

// HTTP transport for agents exposing a Hermes-compatible API server.
//
// Deliberately built on POST /v1/runs + GET /v1/runs/{id}/events rather than
// /v1/chat/completions: only the runs path carries the structured approval
// protocol, so a tool call that needs authorisation surfaces as an
// `approval.request` event we can put in front of the user. On the completions
// path there is nobody to answer and the run would simply stall.
//
// Observed event stream (verified against Hermes 0.18.2):
//   message.delta        { delta }        incremental text
//   reasoning.available  { text }
//   tool.started/completed { tool }
//   approval.request     { command, choices }
//   run.completed        { output, usage } — carries the full final text
//   run.failed           { error }

const DEFAULT_TIMEOUT_MS = 180000;

function createHttpTransport({ id, name, config, getSecret, timeoutMs }) {
  const baseUrl = String(config.baseUrl || 'http://127.0.0.1:8642').replace(/\/+$/, '');
  const budget = timeoutMs || DEFAULT_TIMEOUT_MS;
  let active = null; // { runId, req, res, abort }

  function request(method, urlPath, { body, stream, signalTimeout } = {}) {
    const url = new URL(baseUrl + urlPath);
    const mod = url.protocol === 'https:' ? https : http;
    const secret = getSecret();
    const headers = { Accept: stream ? 'text/event-stream' : 'application/json' };
    if (secret) headers.Authorization = `Bearer ${secret}`;
    let payload = null;
    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body), 'utf8');
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
      // Scopes Hermes' long-term memory per agent, so separate agents do not
      // bleed conversational context into one another.
      headers['X-Hermes-Session-Key'] = `lanchat:${id}`;
    }
    return new Promise((resolve, reject) => {
      const req = mod.request(
        { protocol: url.protocol, hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
        (res) => resolve({ res, req })
      );
      req.setTimeout(signalTimeout || budget, () => req.destroy(new Error('Request timed out.')));
      req.on('error', reject);
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
        } catch (err) {
          reject(new Error(`Unexpected response from ${baseUrl}: ${raw.slice(0, 200)}`));
        }
      });
      res.on('error', reject);
    });
  }

  async function start() {
    // /health needs no auth, so a 200 here proves reachability but not the key.
    // /v1/models is the cheapest authenticated call, so it validates both.
    const { res } = await request('GET', '/v1/models', { signalTimeout: 10000 });
    const body = await readJson(res);
    if (res.statusCode === 401 || res.statusCode === 403) {
      throw new Error('The API key was rejected. Check the key and try again.');
    }
    if (res.statusCode >= 400) {
      throw new Error(`Agent API returned HTTP ${res.statusCode}.`);
    }
    const model = (body.data && body.data[0] && body.data[0].id) || 'unknown';
    return { detail: `Connected to ${baseUrl} (${model})` };
  }

  async function send({ text }, handlers = {}) {
    const { onDelta, onStatus, onApproval, onDone, onError } = handlers;
    try {
      const { res: postRes } = await request('POST', '/v1/runs', {
        body: { input: text, model: config.model || undefined },
      });
      const started = await readJson(postRes);
      if (postRes.statusCode >= 400 || !started.run_id) {
        throw new Error(started.error?.message || `Agent refused the request (HTTP ${postRes.statusCode}).`);
      }
      const runId = started.run_id;
      const { res, req } = await request('GET', `/v1/runs/${runId}/events`, { stream: true });
      active = { runId, req, res };

      let buffer = '';
      let finalText = '';
      let settled = false;

      const finish = (err, output) => {
        if (settled) return;
        settled = true;
        active = null;
        try {
          req.destroy();
        } catch {}
        if (err) onError?.(err);
        else onDone?.({ text: output, runId });
      };

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        // SSE frames are separated by a blank line; keep any partial tail.
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
          switch (evt.event) {
            case 'message.delta':
              finalText += evt.delta || '';
              onDelta?.(evt.delta || '');
              break;
            case 'tool.started':
              onStatus?.(`Running ${evt.tool || 'a tool'}…`);
              break;
            case 'tool.completed':
              onStatus?.(null);
              break;
            case 'approval.request':
              // Surfaced to the local user only — never auto-answered.
              onApproval?.({ runId, command: evt.command, choices: evt.choices || ['once', 'session', 'deny'] });
              break;
            case 'run.completed':
              // `output` is authoritative; deltas are only for live typing.
              finish(null, evt.output || finalText);
              break;
            case 'run.failed':
              finish(new Error(evt.error || 'The agent run failed.'));
              break;
            case 'run.cancelled':
              finish(null, finalText || '(stopped)');
              break;
            default:
              break;
          }
        }
      });
      res.on('end', () => finish(null, finalText));
      res.on('error', (err) => finish(err));
    } catch (err) {
      onError?.(err);
    }
  }

  async function answerApproval(runId, choice) {
    const { res } = await request('POST', `/v1/runs/${runId}/approval`, {
      body: { choice },
      signalTimeout: 15000,
    });
    await readJson(res);
    return res.statusCode < 400;
  }

  async function stop() {
    const current = active;
    active = null;
    if (!current) return;
    try {
      current.req.destroy();
    } catch {}
    try {
      const { res } = await request('POST', `/v1/runs/${current.runId}/stop`, { body: {}, signalTimeout: 10000 });
      res.resume();
    } catch {
      // The run may already have finished; nothing to clean up.
    }
  }

  return { id, name, kind: 'http', start, send, stop, answerApproval };
}

module.exports = { createHttpTransport };
