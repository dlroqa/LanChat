'use strict';

// Turning an agent's answer into speech, by asking Gemini for it.
//
// The exact inverse of dictation.js, and built to the same rules — a real socket
// through node:http(s) rather than fetch, every failure carrying a sentence
// somebody can act on, and a 200 that is not proof of success. Where that file
// hands a clip to a transcriber the user already runs, this hands text to a
// service the user has opted into, which makes one difference the whole design
// turns on:
//
//   **Nothing here ever reaches the network unless the user asked it to.**
//
// LanChat has no central server. Peers find each other and talk directly, and
// that is the promise the app makes. Speaking an agent's words aloud through
// Google is a departure from it, so it is gated twice — the engine must be set
// to 'gemini', and a key must resolve — and neither is a default. With the
// engine left alone this module opens no socket, resolves no name, and reads no
// key. test/speech.test.js proves that against a stub that fails the run if it
// is ever contacted, because "opt-in" asserted in a comment is not opt-in.
//
// The API. Google now documents two paths to the same models: the Interactions
// API (POST /v1beta/interactions), which is GA and recommended, and
// generateContent, which is marked legacy but carries no shutdown date. This
// uses generateContent, and the reason is narrow: Google documents the
// *response* shape for generateContent down to the field the audio bytes live
// in, and does not for Interactions — its examples read the result through an
// SDK property. Writing a parser against a JSON shape nobody has published would
// be a guess, and a guess in the one place a failure looks exactly like an empty
// answer. The model id is the current one either way; moving to Interactions is
// a change to two functions here and nothing else.

const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// The current TTS model. Both preview 2.5 models still answer on this path; this
// is the one Google's own examples now use.
const DEFAULT_MODEL = 'gemini-3.1-flash-tts-preview';
const DEFAULT_ENDPOINT = 'https://generativelanguage.googleapis.com';

// What the model returns: mono signed 16-bit little-endian PCM at 24 kHz. Google
// states all four. It is used only as the fallback for a response that arrives
// without a mimeType to read the rate out of — see rateOf().
const DEFAULT_RATE = 24000;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;

// A turn long enough to hit this is not something anybody wants read aloud —
// it is something to skim. The cap is on characters because that is what is
// being billed and spoken, and the text is cut at a sentence end rather than
// mid-word so what does get spoken finishes cleanly.
const MAX_TEXT_CHARS = 4000;

// Synthesis is real work on a real model and runs over the open internet, so
// this is a budget for a slow network rather than for a busy machine.
const RUN_TIMEOUT_MS = 60000;

// The cache is speech, which is far larger than the text it came from. Bounded
// so a year of discussions cannot quietly fill a disk.
const MAX_CACHE_BYTES = 256 * 1024 * 1024;

// ------------------------------------------------------------------- helpers

// Kept out of the message the user sees; it can carry a key or a local path.
function detailOf(text) {
  const s = (text || '').trim();
  return s ? s.slice(0, 2000) : null;
}

// Why a socket-level failure happened, said so the user can act on it. The
// common case by far is a machine that is offline, and its fix is not a fix —
// it is "you are still being read to, just locally", which is worth saying
// plainly so silence is never mistaken for a broken feature.
function reasonFor(err) {
  if (!err) return null;
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
    return 'This machine is offline, so the local voice is being used instead.';
  }
  if (err.code === 'ECONNREFUSED') return 'The connection was refused.';
  if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
    return 'The connection closed before the audio arrived.';
  }
  if (err.code === 'CERT_HAS_EXPIRED' || err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return 'The connection could not be verified.';
  }
  return err.message;
}

// What a failing status means, in words. These are the four that happen: a key
// that is wrong, a key that is not allowed to use this model, a quota that is
// spent, and Google having a bad day.
function statusReason(status) {
  if (status === 400) return 'The request was rejected — check the voice and model in Settings.';
  if (status === 401 || status === 403) return 'That API key was refused.';
  if (status === 429) return 'The API key has run out of quota for now.';
  if (status >= 500) return 'Gemini is unavailable right now.';
  return `Gemini answered with status ${status}.`;
}

// A body is only useful if it parses and is an object; anything else means what
// answered is not the API.
function parse(body) {
  try {
    const value = JSON.parse(body);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

// Cutting a long answer down to something worth listening to.
//
// Trimmed back to the last sentence end inside the budget so speech does not
// stop mid-clause. If there is no sentence end in the whole budget — one
// enormous unpunctuated block — the hard cut is used, because a paragraph that
// never ends is still better spoken in part than not at all.
function boundText(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (text.length <= MAX_TEXT_CHARS) return text;
  const head = text.slice(0, MAX_TEXT_CHARS);
  const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  return stop > 0 ? head.slice(0, stop + 1) : head;
}

// The sample rate the response says it is, not the one we expect it to be.
//
// Google returns a mimeType of the form `audio/L16;codec=pcm;rate=24000`. The
// rate is stated there for a reason, and a model that one day answers at 16 kHz
// would otherwise be written into a 24 kHz header and play back a tone and a
// half high — which sounds like a bug in everything except the one line that
// caused it. Absent or unreadable, the documented default stands.
function rateOf(mimeType) {
  const match = /rate=(\d+)/i.exec(String(mimeType || ''));
  if (!match) return DEFAULT_RATE;
  const rate = Number.parseInt(match[1], 10);
  return Number.isInteger(rate) && rate >= 8000 && rate <= 192000 ? rate : DEFAULT_RATE;
}

// The audio out of a generateContent response.
//
// The documented path is candidates[0].content.parts[0].inlineData, but the
// parts array is a list and nothing promises the audio is first in it — a model
// that one day prefaces the audio with a text part would break a hard index
// while leaving this working. So it is searched for, and identified by carrying
// inline data that is actually audio.
function audioOf(body) {
  const parts = body?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    const inline = part && part.inlineData;
    const data = inline && inline.data;
    if (typeof data !== 'string' || !data) continue;
    // A text part has no inlineData at all, so anything reaching here is binary;
    // the check is against a future part that is binary and *not* audio.
    if (inline.mimeType && !/^audio\//i.test(inline.mimeType)) continue;
    return { data, mimeType: inline.mimeType || null };
  }
  return null;
}

// The 44 bytes that make raw PCM a file every audio stack will open.
//
// The renderer has an encodeWav in lib/wav.js and it is deliberately not reused:
// that one takes normalised floats for the dictation path, and its positive
// branch multiplies by 0x7fff, so feeding it bytes that are already int16 would
// be a lossy round-trip of samples that need no conversion at all. These bytes
// are passed through untouched.
function wavOf(pcm, rate) {
  const header = Buffer.alloc(44);
  const byteRate = (rate * CHANNELS * BITS_PER_SAMPLE) / 8;
  const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4); // everything after this field
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk length
  header.writeUInt16LE(1, 20); // format: uncompressed PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Minimal request helper, shaped like dictation.js's: the status, the body and
// any transport error resolve together, on success as well as failure, because
// a status alone is not enough to know whether audio came back.
function request({ url, headers, body, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const target = new URL(url);
    const mod = target.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        method: 'POST',
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => finish({ status: res.statusCode, body: text }));
        res.on('error', (err) => finish({ status: res.statusCode, body: text, error: err }));
      }
    );

    req.on('error', (err) => finish({ status: null, body: '', error: err }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish({ status: null, body: '', timedOut: true });
    });

    if (body) req.write(body);
    req.end();
  });
}

// --------------------------------------------------------------------- module

// `endpoint` and `timeouts` are injectable so the whole HTTP path can be driven
// against a stub on an ephemeral port; nothing but tests passes them.
function createSpeech({ config, userDataDir, safeStorage, endpoint = DEFAULT_ENDPOINT, timeouts = {} }) {
  const runMs = timeouts.run || RUN_TIMEOUT_MS;
  const dir = path.join(userDataDir, 'speech');

  // The key, or null. Two modes, exactly as agents/registry.js stores an agent's
  // secret: an environment variable named in config, or a string sealed by the
  // OS keychain through safeStorage. Nothing writes a key to disk in the clear.
  function keyOf() {
    const secret = config.get('agentSpeechKey');
    if (!secret || typeof secret !== 'object') return null;
    if (secret.mode === 'env') return process.env[secret.name] || null;
    if (secret.mode !== 'sealed' || !secret.cipher) return null;
    try {
      return safeStorage.decryptString(Buffer.from(secret.cipher, 'base64'));
    } catch (err) {
      console.error('[speech] could not decrypt the API key:', err.message);
      return null;
    }
  }

  // Whether the online engine is both chosen and usable. The order matters: the
  // engine is checked first, so leaving it alone means the key is never even
  // read, let alone sent anywhere.
  function online() {
    if (config.get('agentSpeechEngine') !== 'gemini') return false;
    return Boolean(keyOf());
  }

  function modelOf() {
    const raw = config.get('agentSpeechModel');
    return typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_MODEL;
  }

  // One file per (model, voice, text). Hashed rather than named after the text
  // so a turn of any length is a filename of one length, and so the same answer
  // replayed a week later is free rather than billed again.
  function cachePath(model, voice, text) {
    const key = crypto.createHash('sha256').update(`${model}|${voice}|${text}`).digest('hex');
    return path.join(dir, `${key}.wav`);
  }

  // Keeping the cache under its cap, oldest first.
  //
  // Swept after a write rather than before: the file just synthesised is the one
  // most likely to be played next, and evicting to make room for it could
  // otherwise delete it. Failures here are deliberately silent — a cache that
  // cannot be tidied is not a reason to refuse to speak.
  function sweep() {
    try {
      const files = fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.wav'))
        .map((name) => {
          const full = path.join(dir, name);
          const stat = fs.statSync(full);
          return { full, bytes: stat.size, at: stat.mtimeMs };
        })
        .sort((a, b) => a.at - b.at);
      let total = files.reduce((sum, f) => sum + f.bytes, 0);
      for (const file of files) {
        if (total <= MAX_CACHE_BYTES) break;
        fs.rmSync(file.full, { force: true });
        total -= file.bytes;
      }
    } catch {
      // Nothing to do about it, and nothing worth interrupting speech for.
    }
  }

  // Text to a playable file.
  //
  // Returns { ok: true, path, cached } on success, and on failure { ok: false }
  // with `fallback` saying whether the renderer should speak this locally
  // instead. That flag is the whole error model: every failure that is not the
  // user's text being empty is one the local voice can cover, so the feature
  // degrades to a worse voice rather than to silence.
  async function speak({ text, voice }) {
    const bounded = boundText(text);
    if (!bounded) return { ok: false, error: 'There was nothing to say.', fallback: false };

    const name = typeof voice === 'string' && voice.trim() ? voice.trim() : null;
    if (!name) return { ok: false, error: 'No voice was chosen.', fallback: true };

    // The gate. Checked before anything else so the offline default costs
    // nothing at all — no key read, no directory made, no socket.
    if (!online()) return { ok: false, reason: 'local', fallback: true };

    const model = modelOf();
    const file = cachePath(model, name, bounded);
    if (fs.existsSync(file)) return { ok: true, path: file, cached: true };

    const body = Buffer.from(
      JSON.stringify({
        contents: [{ parts: [{ text: bounded }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: name } } },
        },
      }),
      'utf8'
    );

    const res = await request({
      url: `${endpoint}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      headers: {
        'x-goog-api-key': keyOf(),
        'content-type': 'application/json',
        'content-length': body.length,
      },
      body,
      timeoutMs: runMs,
    });

    if (res.error) {
      return { ok: false, error: 'Could not reach Gemini.', detail: reasonFor(res.error), fallback: true };
    }
    if (res.timedOut) return { ok: false, error: 'Gemini did not answer in time.', fallback: true };
    if (res.status !== 200) {
      const parsed = parse(res.body);
      return {
        ok: false,
        error: statusReason(res.status),
        detail: detailOf(parsed?.error?.message || res.body),
        fallback: true,
      };
    }

    // Success is the payload, not the status line. A 200 carrying usage figures
    // and no audio is a real and reported behaviour of these models, and taking
    // it for success would write a headerless empty file and play silence.
    const audio = audioOf(parse(res.body));
    if (!audio) {
      return { ok: false, error: 'Gemini returned no audio.', detail: detailOf(res.body), fallback: true };
    }

    const pcm = Buffer.from(audio.data, 'base64');
    if (!pcm.length) {
      return { ok: false, error: 'Gemini returned no audio.', fallback: true };
    }

    try {
      fs.mkdirSync(dir, { recursive: true });
      // Written beside the target and renamed, so a run that dies mid-write
      // cannot leave a truncated file that every later replay would serve from
      // cache as if it were whole.
      const temp = `${file}.${process.pid}.part`;
      fs.writeFileSync(temp, wavOf(pcm, rateOf(audio.mimeType)));
      fs.renameSync(temp, file);
    } catch (err) {
      return { ok: false, error: 'Could not save the audio.', detail: err.message, fallback: true };
    }

    sweep();
    return { ok: true, path: file, cached: false };
  }

  // What Settings shows: whether the online engine is on and working, without
  // ever revealing the key itself.
  function status() {
    return {
      engine: config.get('agentSpeechEngine') === 'gemini' ? 'gemini' : 'local',
      hasKey: Boolean(keyOf()),
      model: modelOf(),
    };
  }

  // Storing a key the user pasted. Sealed by the OS keychain where that is
  // available; refused rather than written in the clear where it is not, because
  // a key in a plain JSON file is a worse outcome than a feature that will not
  // turn on.
  function setKey(raw) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
      config.set({ agentSpeechKey: null });
      return { ok: true, hasKey: false };
    }
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'This machine has no secure storage to keep the key in.' };
    }
    const cipher = safeStorage.encryptString(value).toString('base64');
    config.set({ agentSpeechKey: { mode: 'sealed', cipher } });
    return { ok: true, hasKey: true };
  }

  return { speak, status, setKey };
}

module.exports = {
  createSpeech,
  DEFAULT_MODEL,
  DEFAULT_RATE,
  MAX_TEXT_CHARS,
  MAX_CACHE_BYTES,
  boundText,
  rateOf,
  audioOf,
  wavOf,
};
