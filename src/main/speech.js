'use strict';

// Turning an agent's answer into speech, by asking somebody to read it.
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
// somebody else's API is a departure from it, so it is gated twice — an engine
// must be chosen, and *that engine's own key* must resolve — and neither is a
// default. With the engine left alone this module opens no socket, resolves no
// name, and reads no key. test/speech.test.js and test/xaiSpeech.test.js prove
// that against stubs that fail the run if they are ever contacted, because
// "opt-in" asserted in a comment is not opt-in.
//
// Two providers, in the table further down, and their APIs are not alike:
//
//   * **Gemini** answers with JSON carrying base64 PCM, which gets a WAV header
//     written round it here. Google documents two paths to the same models — the
//     Interactions API (POST /v1beta/interactions), which is GA and recommended,
//     and generateContent, which is marked legacy but carries no shutdown date.
//     This uses generateContent for one narrow reason: Google documents the
//     *response* shape for it down to the field the audio bytes live in, and
//     does not for Interactions, whose examples read the result through an SDK
//     property. A parser written against a JSON shape nobody has published is a
//     guess, in the one place a failure looks exactly like an empty answer.
//
//   * **xAI** answers with the audio itself — "the response body contains raw
//     audio bytes" — as mp3, which needs no header and goes straight to disk.
//     That difference is why request() below has a binary mode: read through the
//     utf8 path, every byte outside ASCII comes back as U+FFFD and the file is
//     the right size and entirely noise. Its one flag that would change the
//     reply into a JSON envelope, with_timestamps, is deliberately never sent.

const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// The current TTS model. Both preview 2.5 models still answer on this path; this
// is the one Google's own examples now use.
const DEFAULT_MODEL = 'gemini-3.1-flash-tts-preview';

// The voice used when the window names none.
//
// It exists because of a bug worth not repeating. This used to refuse an
// unnamed voice and report `fallback: true`, which is the same answer it gives
// when the online engine is switched off — so a renderer fault that left an
// agent without a voice was indistinguishable from having no API key, and every
// affected turn was quietly spoken by the local voice instead. A paid key
// looked like it had done nothing.
//
// Falling back to a voice rather than to the local engine makes that failure
// audible instead of silent: everybody would sound the same, which is obviously
// wrong and obviously *online*. The renderer names a voice for every agent (see
// agentVoice.js voiceOf), so nothing should reach this.
const DEFAULT_VOICE = 'Zephyr';

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
function statusReason(status, label = 'The speech service') {
  if (status === 400) return 'The request was rejected — check the voice and model in Settings.';
  if (status === 401 || status === 403) return 'That API key was refused.';
  if (status === 429) return 'The API key has run out of quota for now.';
  if (status >= 500) return `${label} is unavailable right now.`;
  return `${label} answered with status ${status}.`;
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
//
// `binary` decides how the reply is read, and it is not a nicety. Gemini answers
// with JSON carrying base64; xAI answers with the audio itself — "the response
// body contains raw audio bytes", in its documentation's words. Reading those
// through the utf8 path below would replace every byte outside ASCII with a
// replacement character and hand back a file that is the right length and
// entirely noise. So a binary reply is collected as Buffers and never decoded.
//
// `method` defaults to POST so every existing caller is unchanged; the voice
// roster is the one GET.
function request({ url, method = 'POST', headers, body, timeoutMs, binary = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const empty = binary ? Buffer.alloc(0) : '';

    const target = new URL(url);
    const mod = target.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        method,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (res) => {
        if (binary) {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => finish({ status: res.statusCode, body: Buffer.concat(chunks) }));
          res.on('error', (err) =>
            finish({ status: res.statusCode, body: Buffer.concat(chunks), error: err })
          );
          return;
        }
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => finish({ status: res.statusCode, body: text }));
        res.on('error', (err) => finish({ status: res.statusCode, body: text, error: err }));
      }
    );

    req.on('error', (err) => finish({ status: null, body: empty, error: err }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish({ status: null, body: empty, timedOut: true });
    });

    if (body) req.write(body);
    req.end();
  });
}

// ------------------------------------------------------------------ providers
//
// One entry per engine that can speak, so adding a third is a table row rather
// than a branch at every call site. Each knows four things and nothing else:
// where it lives, how to ask, how to turn a reply into bytes, and what to call
// the file those bytes go in.
//
// What they have in common is the contract around them — the opt-in gate, the
// cache, the failure sentences and the fallback to the local voice are decided
// once, below, for all of them.

// xAI's roster when its own list cannot be read: the five names every source
// agrees on. Its documentation lists more, and a marketing page lists these; the
// list is fetched at runtime precisely because those two disagree, and this is
// only what to fall back to.
const XAI_FALLBACK_VOICES = Object.freeze(['Ara', 'Eve', 'Leo', 'Rex', 'Sal']);

// xAI requires a language and main does not know the window's. The renderer
// sends one; this is what to use when it has not.
const DEFAULT_LANGUAGE = 'en';

const PROVIDERS = Object.freeze({
  gemini: Object.freeze({
    label: 'Gemini',
    ext: '.wav',
    endpoint: 'https://generativelanguage.googleapis.com',
    // See the note at the top of this file for why generateContent rather than
    // the newer Interactions API.
    build({ endpoint, model, voice, text, key }) {
      const body = Buffer.from(
        JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
          },
        }),
        'utf8'
      );
      return {
        url: `${endpoint}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        headers: {
          'x-goog-api-key': key,
          'content-type': 'application/json',
          'content-length': body.length,
        },
        body,
        binary: false,
      };
    },
    // A 200 is not success: these models really do answer with usage figures and
    // no audio, and taking that for success writes a headerless empty file.
    decode(body) {
      const audio = audioOf(parse(body));
      if (!audio) return null;
      const pcm = Buffer.from(audio.data, 'base64');
      if (!pcm.length) return null;
      return wavOf(pcm, rateOf(audio.mimeType));
    },
  }),

  xai: Object.freeze({
    label: 'xAI',
    ext: '.mp3',
    endpoint: 'https://api.x.ai',
    // POST /v1/tts, documented body. `with_timestamps` is deliberately not sent:
    // it is the one flag that changes the reply from audio into a JSON envelope,
    // and there is nothing here that wants timings.
    build({ endpoint, voice, text, key, language }) {
      const body = Buffer.from(
        JSON.stringify({
          text,
          voice_id: voice,
          language: language || DEFAULT_LANGUAGE,
          output_format: { codec: 'mp3' },
        }),
        'utf8'
      );
      return {
        url: `${endpoint}/v1/tts`,
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          'content-length': body.length,
        },
        body,
        binary: true,
      };
    },
    // The bytes are the answer — mp3, straight to disk. Nothing to unwrap, and
    // nothing to add: unlike Gemini's bare PCM, an mp3 already describes itself.
    decode(body) {
      return Buffer.isBuffer(body) && body.length ? body : null;
    },
  }),
});

// The providers a person may choose, and the one that is not a provider at all.
const ENGINES = Object.freeze(['local', ...Object.keys(PROVIDERS)]);

// Every extension the cache can hold, derived from the table rather than listed
// again — a provider added above is swept without anybody remembering to.
const CACHE_EXTS = Object.freeze([...new Set(Object.values(PROVIDERS).map((p) => p.ext))]);

// Anything that is not a known provider means the window's own voices. The one
// place that decides, so a hand-edited config, an older build's value and a
// malformed IPC call all land in the same safe state.
function engineOf(raw) {
  return ENGINES.includes(raw) ? raw : 'local';
}

// --------------------------------------------------------------------- module

// `endpoint`, `endpoints` and `timeouts` are injectable so the whole HTTP path
// can be driven against a stub on an ephemeral port; nothing but tests passes
// them.
//
// `endpoint` redirects every provider and `endpoints` redirects them one at a
// time. Both, because a test that only cares about one engine should not have to
// name the others — and the singular form is what the Gemini tests were already
// written against.
function createSpeech({
  config,
  userDataDir,
  safeStorage,
  endpoint = null,
  endpoints: endpointsIn = {},
  timeouts = {},
}) {
  const runMs = timeouts.run || RUN_TIMEOUT_MS;
  const dir = path.join(userDataDir, 'speech');
  const endpoints = {};
  for (const [name, spec] of Object.entries(PROVIDERS)) {
    endpoints[name] = endpointsIn[name] || endpoint || spec.endpoint;
  }

  // The key for one provider, or null. Two modes, exactly as agents/registry.js
  // stores an agent's secret: an environment variable named in config, or a
  // string sealed by the OS keychain through safeStorage. Nothing writes a key
  // to disk in the clear.
  //
  // Asked for by name, always. A provider is never handed another's key — which
  // is a thing that a single shared field made easy to do by accident, and which
  // would send a paying customer's credentials to the wrong company.
  function keyOf(provider) {
    const all = config.get('agentSpeechKeys');
    const secret = all && typeof all === 'object' ? all[provider] : null;
    if (!secret || typeof secret !== 'object') return null;
    if (secret.mode === 'env') return process.env[secret.name] || null;
    if (secret.mode !== 'sealed' || !secret.cipher) return null;
    try {
      return safeStorage.decryptString(Buffer.from(secret.cipher, 'base64'));
    } catch (err) {
      console.error(`[speech] could not decrypt the ${provider} API key:`, err.message);
      return null;
    }
  }

  function engine() {
    return engineOf(config.get('agentSpeechEngine'));
  }

  // Which provider is going to speak, or null for the window's own voices.
  //
  // The order matters and is the opt-in: the engine is read first, so leaving it
  // alone means no key is read, no name resolved and no socket opened. A chosen
  // provider with no usable key is not online either — it reads locally, and the
  // window is told so rather than left to wonder.
  function activeProvider() {
    const chosen = engine();
    if (chosen === 'local') return null;
    return keyOf(chosen) ? chosen : null;
  }

  function modelOf() {
    const raw = config.get('agentSpeechModel');
    return typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_MODEL;
  }

  // One file per (provider, model, voice, text). Hashed rather than named after
  // the text so a turn of any length is a filename of one length, and so the
  // same answer replayed a week later is free rather than billed again.
  //
  // The provider is in the key because two engines saying the same words in the
  // same-named voice are two different recordings — and because their files are
  // not even the same format.
  function cachePath(provider, model, voice, text) {
    const key = crypto.createHash('sha256').update(`${provider}|${model}|${voice}|${text}`).digest('hex');
    return path.join(dir, `${key}${PROVIDERS[provider].ext}`);
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
        // Every extension a provider writes, so a cache full of one engine's
        // files is not swept while the other's grows unbounded.
        .filter((name) => CACHE_EXTS.some((ext) => name.endsWith(ext)))
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
  async function speak({ text, voice, language }) {
    const bounded = boundText(text);
    if (!bounded) return { ok: false, error: 'There was nothing to say.', fallback: false };

    // An unnamed voice is a bug in the window, not a reason to abandon the
    // engine the user paid for and asked for. See DEFAULT_VOICE.
    const name = typeof voice === 'string' && voice.trim() ? voice.trim() : DEFAULT_VOICE;

    // The gate. Checked before anything else so the offline default costs
    // nothing at all — no key read, no directory made, no socket.
    const provider = activeProvider();
    if (!provider) return { ok: false, reason: 'local', fallback: true };
    const spec = PROVIDERS[provider];
    const label = spec.label;

    const model = modelOf();
    const file = cachePath(provider, model, name, bounded);
    if (fs.existsSync(file)) return { ok: true, path: file, cached: true, engine: provider };

    const built = spec.build({
      endpoint: endpoints[provider],
      model,
      voice: name,
      text: bounded,
      key: keyOf(provider),
      language,
    });

    const res = await request({
      url: built.url,
      headers: built.headers,
      body: built.body,
      binary: built.binary,
      timeoutMs: runMs,
    });

    if (res.error) {
      return {
        ok: false,
        error: `Could not reach ${label}.`,
        detail: reasonFor(res.error),
        fallback: true,
      };
    }
    if (res.timedOut) return { ok: false, error: `${label} did not answer in time.`, fallback: true };
    if (res.status !== 200) {
      // An error body is JSON on both providers even when a success would not
      // have been, so it is read as text however the reply was collected.
      const asText = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : res.body;
      const parsed = parse(asText);
      return {
        ok: false,
        error: statusReason(res.status, label),
        detail: detailOf(parsed?.error?.message || parsed?.error || asText),
        fallback: true,
      };
    }

    // Success is the payload, not the status line. A 200 carrying usage figures
    // and no audio is a real and reported behaviour of these models, and taking
    // it for success would write a headerless empty file and play silence.
    const bytes = spec.decode(res.body);
    if (!bytes || !bytes.length) {
      const asText = Buffer.isBuffer(res.body) ? '' : res.body;
      return {
        ok: false,
        error: `${label} returned no audio.`,
        detail: detailOf(asText),
        fallback: true,
      };
    }

    try {
      fs.mkdirSync(dir, { recursive: true });
      // Written beside the target and renamed, so a run that dies mid-write
      // cannot leave a truncated file that every later replay would serve from
      // cache as if it were whole.
      const temp = `${file}.${process.pid}.part`;
      fs.writeFileSync(temp, bytes);
      fs.renameSync(temp, file);
    } catch (err) {
      return { ok: false, error: 'Could not save the audio.', detail: err.message, fallback: true };
    }

    sweep();
    return { ok: true, path: file, cached: false, engine: provider };
  }

  // The voices a provider offers, for dealing one to each agent.
  //
  // Asked of the provider rather than written down here, because xAI's own
  // documentation and its announcement disagree about the roster — one lists
  // twenty-six names and the other five. Asking is the only answer that cannot
  // be out of date, and a new voice appears without a release.
  //
  // Cached for the life of the process: a roster does not change while somebody
  // is listening, and this is on the path of the first spoken turn.
  const voiceCache = new Map();

  async function voices() {
    const provider = activeProvider();
    // Gemini's roster is a fixed, documented set the window already holds, and
    // the local voices belong to the platform. Only xAI publishes a list to ask
    // for, so only xAI is asked.
    if (provider !== 'xai') return { ok: true, provider: provider || 'local', voices: [] };
    if (voiceCache.has('xai')) return { ok: true, provider: 'xai', voices: voiceCache.get('xai') };

    const res = await request({
      url: `${endpoints.xai}/v1/tts/voices`,
      method: 'GET',
      headers: { authorization: `Bearer ${keyOf('xai')}`, accept: 'application/json' },
      timeoutMs: runMs,
    });

    // A roster that cannot be read is not a reason to be unable to speak: the
    // five names every source agrees on are enough to tell four agents apart.
    let list = null;
    if (!res.error && !res.timedOut && res.status === 200) {
      const body = parse(res.body);
      const found = Array.isArray(body?.voices) ? body.voices : null;
      const names = (found || [])
        .map((v) => (typeof v === 'string' ? v : v?.voice_id || v?.id || v?.name))
        .filter((n) => typeof n === 'string' && n.trim())
        .map((n) => n.trim());
      if (names.length) list = [...new Set(names)];
    }
    const resolved = list || [...XAI_FALLBACK_VOICES];
    voiceCache.set('xai', resolved);
    return { ok: true, provider: 'xai', voices: resolved, fallback: !list };
  }

  // What Settings shows: which engine is chosen, which providers have a key, and
  // never a key itself.
  function status() {
    const keys = {};
    for (const name of Object.keys(PROVIDERS)) keys[name] = Boolean(keyOf(name));
    return {
      engine: engine(),
      keys,
      // Whether the chosen engine can actually speak. The difference between
      // "Gemini" and "Gemini, but reading locally because there is no key" —
      // which is the distinction the window exists to make plain.
      active: activeProvider() || 'local',
      model: modelOf(),
    };
  }

  // Storing a key the user pasted, for one provider. Sealed by the OS keychain
  // where that is available; refused rather than written in the clear where it
  // is not, because a key in a plain JSON file is a worse outcome than a feature
  // that will not turn on.
  function setKey(provider, raw) {
    if (!PROVIDERS[provider]) return { ok: false, error: 'Unknown speech provider.' };
    const value = typeof raw === 'string' ? raw.trim() : '';
    const all = config.get('agentSpeechKeys');
    const keys = { ...(all && typeof all === 'object' ? all : {}) };

    if (!value) {
      delete keys[provider];
      config.set({ agentSpeechKeys: keys });
      // A forgotten key invalidates the roster it fetched: the next one may be
      // a different account with different voices.
      voiceCache.delete(provider);
      return { ok: true, hasKey: false };
    }
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'This machine has no secure storage to keep the key in.' };
    }
    keys[provider] = { mode: 'sealed', cipher: safeStorage.encryptString(value).toString('base64') };
    config.set({ agentSpeechKeys: keys });
    voiceCache.delete(provider);
    return { ok: true, hasKey: true };
  }

  return { speak, voices, status, setKey };
}

module.exports = {
  createSpeech,
  PROVIDERS,
  ENGINES,
  XAI_FALLBACK_VOICES,
  engineOf,
  DEFAULT_MODEL,
  DEFAULT_VOICE,
  DEFAULT_RATE,
  MAX_TEXT_CHARS,
  MAX_CACHE_BYTES,
  boundText,
  rateOf,
  audioOf,
  wavOf,
};
