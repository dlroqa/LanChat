'use strict';

// Local speech-to-text, by handing a clip to the FluidVoice app.
//
// FluidVoice is a macOS dictation app the user already runs and has already
// configured — its speech model, its custom dictionary, its downloaded weights.
// Maintaining a second speech stack inside LanChat bought a worse result than
// asking theirs, so this talks to it instead.
//
// Nothing about this file is macOS-specific on purpose. FluidVoice only ships
// for macOS, but the renderer is what decides whether to offer dictation at all
// — keeping this path platform-agnostic is what makes it testable against a stub
// server on any machine, and a `process.platform` check here would buy nothing
// and cost that.
//
// Four facts about the API shape everything below, all of them read out of
// FluidVoice's source rather than assumed, because each one is a way to be wrong
// that the user would be left to debug:
//
//   1. It is off by default and has no settings UI of its own. Turning it on is
//      `defaults write com.FluidApp.app LocalAPIEnabled -bool true` plus a
//      restart. So a refused connection is the overwhelmingly likely failure,
//      and it is the one with a fix — it gets its own sentence.
//   2. It is loopback-only and enforces that itself. We address 127.0.0.1
//      literally rather than 'localhost': no DNS step, nothing to resolve
//      somewhere else.
//   3. Its routes are undocumented. `/v1/health` is the cheapest way to learn
//      whether the thing we are about to POST speech to really is FluidVoice, so
//      Settings asks that rather than trusting an open port.
//   4. There is no authentication. Anything on this machine can call it — worth
//      saying in Settings, but it changes nothing here.
//
// node:http rather than fetch: on a loopback call the global undici dispatcher,
// proxy environment variables and DNS are all things that can only go wrong, and
// none of them are reachable through this API.

const http = require('node:http');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 47733;
// FluidVoice's own LocalAPI.maxRequestBytes. Matched rather than guessed, so an
// oversize clip is refused here with a sentence instead of arriving as a 413.
const MAX_CLIP_BYTES = 25 * 1024 * 1024;
// Loopback: a healthy server answers this in single-digit milliseconds. The
// budget is for a busy machine, not for a network.
const PROBE_TIMEOUT_MS = 5000;
// Transcription is real work on a real model, and a clip can be two minutes.
const RUN_TIMEOUT_MS = 90000;

// Kept out of the message the user sees; it can carry a local path.
function detailOf(text) {
  const s = (text || '').trim();
  return s ? s.slice(0, 2000) : null;
}

// Why a socket-level failure happened, said so the user can act on it.
//
// ECONNREFUSED is the case that matters: "FluidVoice is not running" and "its
// local API was never switched on" both look like this and have the same fix,
// so they get the same sentence rather than a code.
function reasonFor(err, port) {
  if (!err) return null;
  if (err.code === 'ECONNREFUSED') {
    return `Nothing is listening on ${HOST}:${port}. Open FluidVoice and turn on its local API.`;
  }
  if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
    return 'FluidVoice closed the connection.';
  }
  return err.message;
}

// Minimal request helper. Resolves with the status, the body and any transport
// error together — on success as well as failure — because a status alone is not
// enough to know whether a transcription happened (see transcribe()).
function request({ port, method, path: urlPath, headers, body, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = http.request({ host: HOST, port, method, path: urlPath, headers: headers || {} }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => finish({ status: res.statusCode, body: text }));
      res.on('error', (err) => finish({ status: res.statusCode, body: text, error: err }));
    });

    req.on('error', (err) => finish({ status: null, body: '', error: err }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish({ status: null, body: '', timedOut: true });
    });

    if (body) req.write(body);
    req.end();
  });
}

// A body is only useful if it parses and is an object; anything else means the
// thing on that port is not answering as FluidVoice.
function parse(body) {
  try {
    const value = JSON.parse(body);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

// `timeouts` is injectable so the timeout path can be exercised for real rather
// than waited out; nothing but tests passes it.
function createDictation({ config, timeouts = {} }) {
  const probeMs = timeouts.probe || PROBE_TIMEOUT_MS;
  const runMs = timeouts.run || RUN_TIMEOUT_MS;
  let inFlight = false;

  function portOf(override) {
    const raw = override == null || override === '' ? config.get('dictationPort') : override;
    const n = Number.parseInt(raw, 10);
    // Anything unusable — a blank field, a word, a port out of range — means the
    // default rather than an error. The field exists for a non-default FluidVoice
    // setup, not as a way to break dictation by mistyping.
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
  }

  // Is FluidVoice there, and is it FluidVoice? Answered by asking it rather than
  // by finding the port open — something else could be listening on it.
  async function probe(override) {
    const port = portOf(override);
    const res = await request({ port, method: 'GET', path: '/v1/health', timeoutMs: probeMs });

    if (res.error) return { ok: false, port, detail: reasonFor(res.error, port) };
    if (res.timedOut) return { ok: false, port, detail: 'It did not respond.' };
    if (res.status !== 200) {
      return { ok: false, port, detail: `It answered with status ${res.status}.` };
    }

    const data = parse(res.body);
    if (!data || data.status !== 'ok') {
      return { ok: false, port, detail: `Something other than FluidVoice is on port ${port}.` };
    }
    return { ok: true, port, version: typeof data.version === 'string' ? data.version : null };
  }

  async function transcribe({ data }) {
    const bytes = data ? Buffer.from(data) : null;
    if (!bytes || !bytes.length) return { ok: false, error: 'There was nothing to transcribe.' };
    if (bytes.length > MAX_CLIP_BYTES) {
      return { ok: false, error: 'That recording is too long to transcribe.' };
    }
    if (inFlight) return { ok: false, error: 'Still transcribing the last recording.' };
    inFlight = true;

    const port = portOf();
    try {
      // The raw-body form rather than base64 or a file path: the audio is already
      // bytes in hand, and the other two would mean either inflating it by a
      // third or writing speech to disk. This way it never touches disk at all.
      const res = await request({
        port,
        method: 'POST',
        path: '/v1/transcribe',
        headers: {
          'content-type': 'audio/wav',
          'content-length': bytes.length,
          'x-filename': 'clip.wav',
        },
        body: bytes,
        timeoutMs: runMs,
      });

      if (res.error) {
        return {
          ok: false,
          error: 'Dictation is not set up — see Settings → Push to talk.',
          detail: reasonFor(res.error, port),
        };
      }
      if (res.timedOut) return { ok: false, error: 'Transcription timed out.' };
      if (res.status !== 200) {
        return {
          ok: false,
          error: 'Transcription failed.',
          // FluidVoice reports its own errors as JSON carrying a message; fall
          // back to the raw body so a plain-text or HTML error is not discarded.
          detail: detailOf((parse(res.body) || {}).message || res.body),
        };
      }

      // Success is the payload, not the status line: a 200 carrying anything
      // other than a string `text` did not transcribe this clip.
      const body = parse(res.body);
      if (!body || typeof body.text !== 'string') {
        return { ok: false, error: 'Transcription failed.', detail: detailOf(res.body) };
      }
      return { ok: true, text: body.text.trim() };
    } catch (err) {
      return { ok: false, error: 'Transcription failed.', detail: err.message };
    } finally {
      inFlight = false;
    }
  }

  return { probe, transcribe };
}

module.exports = { createDictation, DEFAULT_PORT, MAX_CLIP_BYTES };
