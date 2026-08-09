'use strict';

// The process that runs the model. Nothing else in the app loads onnxruntime.
//
// This is an Electron utilityProcess entry, which is a plain Node context with no
// DOM and no `electron` module — so it is ordinary CommonJS, like the rest of
// src/main, and it talks to its parent over `process.parentPort` alone.
//
// It is a separate process for three reasons, in increasing order of importance:
//
//   1. Synthesis is seconds of solid CPU. On the main thread that is seconds of
//      frozen tray, frozen IPC and a window that does not redraw.
//   2. The model is ~90 MB resident. Ending the process is the only way to
//      actually give that back, which is what the idle shutdown in kokoro.js
//      relies on.
//   3. **Session creation can hard-crash.** ONNX Runtime's default graph
//      optimisation level segfaults while loading a quantised model on a machine
//      with no AVX-family instructions. A SIGSEGV cannot be caught — no
//      try/catch, no promise rejection, the process is simply gone. Out here that
//      is an exit code the parent can see and respond to; on the main thread it
//      is the app disappearing.
//
// Point 3 is why `optimization` arrives as a parameter rather than being decided
// here. The parent starts at ONNX Runtime's own default and, if this process dies
// during session creation, starts a new one at 'basic' and remembers. Machines
// with vector units keep the full optimisation; machines without degrade instead
// of failing. Neither case is hardcoded to a CPU anybody has measured.

const fs = require('node:fs');
const path = require('node:path');

const text = require('./kokoroText.js');

// Kokoro's output rate. Not a preference — the vocoder produces 24 kHz mono and
// writing any other number into the WAV header transposes the voice.
const SAMPLE_RATE = 24000;

// A voice pack is 510 rows of 256 float32.
const STYLE_DIM = 256;

// Held for the life of the process, which is the whole point of having one.
let session = null;
let vocab = null;
const voices = new Map();

// Loaded lazily so that requiring this file — which the test suite does, to
// drive the text layer — does not pull in a 200 MB native module.
let ort = null;
let phonemize = null;

// Which ONNX Runtime is doing the arithmetic.
//
// Two backends, one API. `onnxruntime-node` is the native library and is used
// wherever one exists; `onnxruntime-web` is the same runtime compiled to
// WebAssembly, and Microsoft ships it with an official Node entry point
// (`exports["."].node`) that instantiates the .wasm from node:fs and pulls in no
// native binary at all. Both packages depend on the same `onnxruntime-common`,
// so `InferenceSession` and `Tensor` below are literally the same classes and
// nothing else in this file knows which one it got.
//
// The point of the second one is that ONNX Runtime stopped publishing macOS
// x86_64 binaries after 1.23, so a native-only engine is one dependency bump
// away from going silent on every Intel Mac. WebAssembly has no such cliff: it
// runs wherever Node does.
//
// They are not bit-identical — int8 kernels differ between execution providers,
// and a vocoder's output phase moves with them — but they are the same speech.
// Measured on the same sentence: 20 ms energy envelopes correlate at 0.9996,
// log spectra at 0.9985, and the worst octave band differs by 0.07 dB against an
// audibility threshold of about 1 dB. scripts/kokoro-harness.js asserts that.
//
// The parent decides which; this file is told, exactly as it is told the
// optimisation level, so policy lives in one place.
function load(backend, wasmDir) {
  if (!ort) {
    if (backend === 'wasm') {
      // Refused rather than defaulted: without a directory the runtime silently
      // goes looking for a CDN, and an offline voice that reaches for the
      // network is the one thing this engine must never do.
      if (!wasmDir) throw new Error('the WebAssembly runtime was not told where its .wasm is');
      ort = require('onnxruntime-web');
      // Where its .wasm lives. Given by the parent rather than worked out here,
      // because the answer differs between a source tree and a packaged app and
      // this process should not have to know which it is in. Without it the
      // runtime looks for a CDN, which is precisely what an offline voice must
      // never do.
      ort.env.wasm.wasmPaths = wasmDir.endsWith(path.sep) ? wasmDir : wasmDir + path.sep;
      ort.env.logLevel = 'error';
    } else {
      ort = require('onnxruntime-node');
    }
  }
  if (!phonemize) ({ phonemize } = require('phonemizer'));
}

// How this process talks to its parent.
//
// Electron's utilityProcess gives it a `parentPort` with structured-clone
// messaging; child_process.fork gives it `process.send`. Both are supported for
// one concrete reason: utilityProcess exists only inside Electron, and a worker
// that could only run inside Electron could only be tested inside Electron. The
// test suite forks this file with `serialization: 'advanced'` — which is the same
// structured clone, so a Buffer of PCM crosses as bytes rather than as a JSON
// array of ten thousand numbers.
const channel = process.parentPort
  ? {
      send: (message) => process.parentPort.postMessage(message),
      listen: (handler) => process.parentPort.on('message', (event) => handler(event.data)),
    }
  : {
      send: (message) => process.send(message),
      listen: (handler) => process.on('message', handler),
    };

function reply(id, body) {
  channel.send({ id, ...body });
}

// ------------------------------------------------------------------ the model

async function open({ modelPath, tokenizerPath, optimization, backend = 'native', wasmDir = null }) {
  load(backend, wasmDir);
  vocab = JSON.parse(fs.readFileSync(tokenizerPath, 'utf8')).model.vocab;
  if (!vocab || typeof vocab !== 'object') throw new Error('the tokenizer file has no vocabulary');

  session = await ort.InferenceSession.create(modelPath, {
    graphOptimizationLevel: optimization,
    // The two runtimes name their CPU provider differently — 'cpu' is the native
    // library's, 'wasm' is the WebAssembly one's — and neither accepts the
    // other's name. This is the only line in the file that knows which backend
    // it is running on.
    executionProviders: [backend === 'wasm' ? 'wasm' : 'cpu'],
  });

  // The contract this file is written against. Asserted rather than assumed: a
  // future revision of the export that renamed an input would otherwise fail
  // deep inside run() with a message about a missing feed.
  const wanted = ['input_ids', 'style', 'speed'];
  const missing = wanted.filter((name) => !session.inputNames.includes(name));
  if (missing.length) throw new Error(`this model does not take ${missing.join(', ')}`);
  if (!session.outputNames.includes('waveform')) throw new Error('this model produces no waveform');
}

// A voice pack, read once and kept. 522 kB each, thirteen of them at most.
function styleFor(voicesDir, voice, tokenCount) {
  if (!voices.has(voice)) {
    const file = path.join(voicesDir, `${voice}.bin`);
    const bytes = fs.readFileSync(file);
    // A Buffer's underlying ArrayBuffer may be a slice of a larger pool, so the
    // offset and length are given explicitly rather than trusting `.buffer`.
    voices.set(voice, new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
  }
  const pack = voices.get(voice);
  const at = text.styleOffset(tokenCount);
  return pack.slice(at, at + STYLE_DIM);
}

// Text to token ids, through the whole pipeline. Shared by the measuring pass in
// splitFor and by synthesis itself, so the count a chunk was accepted on is the
// count it is actually run with.
async function idsFor(raw, language) {
  const normalized = text.normalize(raw);
  const parts = await Promise.all(
    text.segment(normalized).map(async (run) => {
      if (run.punctuation) return run.text;
      const spoken = (await phonemize(run.text, language)).join(' ');
      return spoken;
    })
  );
  const phonemes = text.repairPhonemes(parts.join(''), language);
  return text.toIds(phonemes, vocab);
}

async function synthesizeChunk(voicesDir, voice, chunk, language, speed) {
  const ids = await idsFor(chunk, language);
  const style = styleFor(voicesDir, voice, ids.length);

  const out = await session.run({
    input_ids: new ort.Tensor(
      'int64',
      BigInt64Array.from(ids, (n) => BigInt(n)),
      [1, ids.length]
    ),
    style: new ort.Tensor('float32', style, [1, STYLE_DIM]),
    speed: new ort.Tensor('float32', new Float32Array([speed]), [1]),
  });
  return out.waveform.data;
}

// One turn, however long, as 16-bit PCM.
//
// Long turns are split at sentence ends and synthesised in pieces, because the
// model has a hard 510-token ceiling and the style vector is indexed by token
// count — past the end of the pack there is nothing to read. The pieces are
// concatenated with a short silence between them, which is what the pause at a
// sentence end would have been had the model seen the whole thing at once.
async function speak({ voicesDir, voice, text: raw, speed }) {
  const language = text.languageOf(voice);
  const chunks = await text.splitFor(raw, async (piece) => (await idsFor(piece, language)).length);
  if (!chunks.length) return Buffer.alloc(0);

  const gap = new Float32Array(Math.round(SAMPLE_RATE * 0.12));
  const waves = [];
  let samples = 0;
  for (const chunk of chunks) {
    if (waves.length) {
      waves.push(gap);
      samples += gap.length;
    }
    const wave = await synthesizeChunk(voicesDir, voice, chunk, language, speed);
    waves.push(wave);
    samples += wave.length;
  }

  // Float to int16, the format speech.js's wavOf() writes a header around.
  // Clamped rather than scaled: the model occasionally exceeds unity on a
  // plosive, and wrapping that would be an audible click where clipping it is
  // not noticeable.
  const pcm = Buffer.alloc(samples * 2);
  let at = 0;
  for (const wave of waves) {
    for (let i = 0; i < wave.length; i++) {
      const value = Math.max(-1, Math.min(1, wave[i]));
      pcm.writeInt16LE(Math.round(value < 0 ? value * 0x8000 : value * 0x7fff), at);
      at += 2;
    }
  }
  return pcm;
}

// ------------------------------------------------------------------- messages

channel.listen(async (raw) => {
  const message = raw || {};
  const { id, kind } = message;

  try {
    if (kind === 'open') {
      await open(message);
      return reply(id, { ok: true, sampleRate: SAMPLE_RATE });
    }
    if (kind === 'speak') {
      if (!session) throw new Error('the model is not open');
      const started = Date.now();
      const pcm = await speak(message);
      return reply(id, {
        ok: true,
        pcm,
        ms: Date.now() - started,
        seconds: pcm.length / 2 / SAMPLE_RATE,
      });
    }
    if (kind === 'close') {
      if (session) await session.release().catch(() => {});
      session = null;
      reply(id, { ok: true });
      return process.exit(0);
    }
    reply(id, { ok: false, error: `unknown request ${kind}` });
  } catch (err) {
    reply(id, { ok: false, error: err && err.message ? err.message : String(err) });
  }
});
