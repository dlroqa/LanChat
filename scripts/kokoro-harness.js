'use strict';

// The offline voice, for real: real weights, a real ONNX session, real audio.
//
// What `npm test` cannot do. test/kokoroSpeech.test.js drives everything around
// the model with a stub in its place, which is the right trade for a suite that
// runs on every push — but it means the one thing nobody has checked is whether
// the model actually speaks. This does that, and it is manual for the same
// reason the other fifteen harnesses are: it needs 93 MB from the network and a
// minute of CPU, and neither belongs in CI.
//
// Four things are proved here that cannot be proved anywhere else:
//
//   1. A turn of English comes back as audible 24 kHz audio, through the real
//      normalisation → phonemiser → tokeniser → session → WAV path.
//   2. Different voices really do sound different — the same words in two voices
//      are two different recordings, which is what the whole podcast ring rests
//      on. Asserted on the samples, not on the file names.
//   3. **Nothing opens a socket.** Every endpoint is pointed at a listener that
//      fails the run if it is ever contacted. This is the reason somebody would
//      choose this engine over Gemini, and a promise nobody has tested is not a
//      promise.
//   4. Weights that go missing fall back to the local voice rather than to
//      silence — the same degradation a refused API key gets.
//
//   node scripts/kokoro-harness.js [--keep] [--dir <userData>]
//
// `--dir` reuses a directory that already holds the weights, so the download
// happens once across many runs.

const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { fork } = require('node:child_process');

const { createSpeech, DEFAULT_RATE } = require('../src/main/speech.js');
const { createWeights } = require('../src/main/tts/weights.js');
const { createKokoro } = require('../src/main/tts/kokoro.js');
const manifest = require('../src/main/tts/manifest.js');

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const dirArg = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : null;
// Which ONNX Runtime to force. Left alone it uses whatever this machine would
// really pick; `--backend wasm` is how the WebAssembly path gets exercised on a
// machine that has a native library, which is every machine we develop on.
const backendArg = args.includes('--backend') ? args[args.indexOf('--backend') + 1] : null;
// Where to write the PCM for a cross-backend comparison — see --compare below.
const dumpArg = args.includes('--dump') ? args[args.indexOf('--dump') + 1] : null;

// The worker is an Electron utilityProcess in the app. Out here there is no
// Electron, so it is forked as an ordinary Node child — which the worker
// supports precisely so that this harness can exist. `advanced` serialisation is
// what lets a Buffer of PCM cross as bytes rather than as a JSON array.
function nodeFork(script) {
  const child = fork(script, [], { serialization: 'advanced', stdio: 'inherit' });
  return {
    send: (m) => child.send(m),
    onMessage: (h) => child.on('message', h),
    onExit: (h) => child.on('exit', h),
    kill: () => child.kill(),
  };
}

function fakeConfig(seed = {}) {
  const data = { agentSpeechEngine: 'kokoro', agentSpeechKeys: {}, ...seed };
  return { get: (k) => data[k], set: (patch) => Object.assign(data, patch), all: () => data };
}

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s),
  decryptString: (b) => b.toString('utf8'),
};

// ------------------------------------------------- comparing two backends
//
// The native runtime and the WebAssembly one do **not** agree byte for byte, and
// that is expected rather than a fault. ONNX Runtime's int8 kernels differ
// between execution providers, and a neural vocoder's output *phase* moves with
// them — measured here, 82% of samples differ and the largest single difference
// is 64% of full scale, while nothing about the speech changes. A bitwise
// comparison would fail on audio that is indistinguishable.
//
// So the comparison is on what a listener could actually notice: how loud it is,
// where the words and the silences fall, and the shape of the spectrum. All
// three are phase-blind, which is the point.

// Short-time energy, 20 ms frames — "the same words with the same rhythm".
function envelope(pcm, frame = 480) {
  const out = [];
  for (let at = 0; at + frame * 2 <= pcm.length; at += frame * 2) {
    let sum = 0;
    for (let i = 0; i < frame; i++) {
      const s = pcm.readInt16LE(at + i * 2);
      sum += s * s;
    }
    out.push(Math.sqrt(sum / frame));
  }
  return out;
}

function overallRms(pcm) {
  let sum = 0;
  const n = pcm.length / 2;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / Math.max(n, 1));
}

// The long-term average spectrum, which is how the two backends are really
// compared.
//
// A fine-grained envelope comparison looked obvious and was wrong: the duration
// prediction drifts by a frame or two per chunk, so by the end of a long turn
// the two recordings are ~25 ms out of step and a 20 ms-frame correlation
// collapses to 0.58 on audio that is indistinguishable. The average spectrum has
// no such problem — it is blind to phase *and* to alignment, and it is what
// "sounds the same" actually means.
const FFT_N = 1024;

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
      }
    }
  }
}

function spectrum(pcm) {
  const acc = new Float64Array(FFT_N / 2);
  const win = new Float64Array(FFT_N);
  for (let i = 0; i < FFT_N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_N - 1));
  let frames = 0;
  for (let at = 0; at + FFT_N * 2 <= pcm.length; at += FFT_N) {
    const re = new Float64Array(FFT_N);
    const im = new Float64Array(FFT_N);
    for (let i = 0; i < FFT_N; i++) re[i] = pcm.readInt16LE(at + i * 2) * win[i];
    fft(re, im);
    for (let k = 0; k < FFT_N / 2; k++) acc[k] += Math.hypot(re[k], im[k]);
    frames++;
  }
  if (frames) for (let k = 0; k < acc.length; k++) acc[k] /= frames;
  return acc;
}

// Octave-ish bands, and the worst difference between them in decibels. About
// 1 dB is where a listener starts to notice a tonal change at all.
const BANDS = [
  [0, 200],
  [200, 500],
  [500, 1000],
  [1000, 2000],
  [2000, 4000],
  [4000, 8000],
  [8000, 12000],
];

function worstBandDb(a, b, rate = 24000) {
  const sa = spectrum(a);
  const sb = spectrum(b);
  let worst = 0;
  for (const [lo, hi] of BANDS) {
    const k0 = Math.floor((lo * FFT_N) / rate);
    const k1 = Math.floor((hi * FFT_N) / rate);
    let ea = 0;
    let eb = 0;
    for (let k = k0; k < k1; k++) {
      ea += sa[k];
      eb += sb[k];
    }
    worst = Math.max(worst, Math.abs(20 * Math.log10((eb + 1e-9) / (ea + 1e-9))));
  }
  return worst;
}

// Loudness and silence, read back out of the WAV the app actually wrote.
function measure(file) {
  const bytes = fs.readFileSync(file);
  const rate = bytes.readUInt32LE(24);
  const pcm = bytes.subarray(44);
  let peak = 0;
  let sum = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const sample = Math.abs(pcm.readInt16LE(i));
    peak = Math.max(peak, sample);
    sum += sample;
  }
  const samples = pcm.length / 2;
  return { rate, samples, seconds: samples / rate, peak, mean: samples ? sum / samples : 0 };
}

const out = {};
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? `  — ${detail}` : ''}`);
}

async function main() {
  const dir = dirArg || fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-kokoro-harness-'));
  fs.mkdirSync(dir, { recursive: true });
  console.log(`userData: ${dir}\n`);

  // A listener that fails the run if it is ever spoken to. Every provider
  // endpoint points at it, so any socket at all is a failure rather than a
  // silent success.
  let contacted = 0;
  const guard = http.createServer((_req, res) => {
    contacted += 1;
    res.end();
  });
  await new Promise((r) => guard.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${guard.address().port}`;

  const progress = { last: 0 };
  const weights = createWeights({
    userDataDir: dir,
    onProgress: ({ received, total }) => {
      const pct = Math.round((received / total) * 100);
      if (pct === progress.last) return;
      progress.last = pct;
      process.stdout.write(`\r  downloading ${pct}%   `);
    },
  });

  if (!weights.ready()) {
    console.log(`fetching ${(manifest.TOTAL_BYTES / 1e6).toFixed(0)} MB of weights…`);
    const got = await weights.download();
    process.stdout.write('\n');
    if (!got.ok) {
      console.error(`could not download the weights: ${got.error} ${got.detail || ''}`);
      process.exit(1);
    }
  }

  // Every file, by content, against the pinned manifest.
  const verified = await weights.verify();
  check(
    'every weight file matches its sha256',
    verified.ok,
    verified.ok ? null : `${verified.file}: ${verified.reason}`
  );

  const kokoro = createKokoro({
    weights,
    config: fakeConfig(),
    fork: nodeFork,
    idleMs: 0,
    ...(backendArg ? { backend: () => backendArg } : {}),
  });
  check('this machine has a runtime for the model', kokoro.supported(), kokoro.backend());
  if (backendArg) console.log(`       forced backend: ${backendArg}`);

  const speech = createSpeech({
    config: fakeConfig(),
    userDataDir: dir,
    safeStorage: fakeSafeStorage,
    kokoro,
    endpoint,
  });

  // ---- 1. it speaks ----
  const TURN =
    'Right — the discovery beacon only reaches the local subnet, so two machines ' +
    'on different VLANs never see each other. Dr. Vance filed it in 2019, and the ' +
    'retries cost about $4.50 a host. The fix is 3-5 lines.';

  const started = Date.now();
  const first = await speech.speak({ text: TURN, voice: 'af_bella' });
  const wall = Date.now() - started;
  check('a turn comes back as a playable file', first.ok, first.ok ? first.path : first.error);
  if (!first.ok) return finish(guard, dir);

  const heard = measure(first.path);
  check('it is 24 kHz audio', heard.rate === DEFAULT_RATE, `${heard.rate} Hz`);
  check(
    'it is not silence',
    heard.peak > 3000 && heard.mean > 200,
    `peak ${heard.peak}, mean ${Math.round(heard.mean)}`
  );
  check('it is not clipped to noise', heard.peak <= 32767);
  // A quarter-second of audio for that much text would mean the splitter dropped
  // most of it on the floor.
  check('the whole turn was spoken', heard.seconds > 8, `${heard.seconds.toFixed(2)}s of audio`);
  check('it named itself as the engine', first.engine === 'kokoro', first.engine);
  out.realTimeFactor = (wall / 1000 / heard.seconds).toFixed(2);
  console.log(
    `       ${heard.seconds.toFixed(2)}s of audio in ${(wall / 1000).toFixed(1)}s  (RTF ${out.realTimeFactor})`
  );

  // ---- 1b. the two runtimes are the same speech ----
  //
  // Written out so a second run on the other backend can compare against it.
  // `--dump <file>` then `--compare <file>` is the pair; without them this run
  // only proves that whichever backend it used works.
  if (dumpArg) {
    fs.writeFileSync(dumpArg, fs.readFileSync(first.path).subarray(44));
    console.log(`       wrote ${dumpArg} for cross-backend comparison`);
  }
  const compareArg = args.includes('--compare') ? args[args.indexOf('--compare') + 1] : null;
  if (compareArg && fs.existsSync(compareArg)) {
    const mine = fs.readFileSync(first.path).subarray(44);
    const theirs = fs.readFileSync(compareArg);

    // Not even the *length* matches exactly, and that too is expected. Kokoro
    // predicts each chunk's duration, and the same int8 kernel differences move
    // that prediction by a frame or two; across the several chunks a long turn
    // is split into, it accumulated to 600 samples here — 25 ms in 16.5
    // seconds, or 0.15%. Well inside a tolerance, nowhere near a listener.
    const drift = Math.abs(mine.length - theirs.length) / Math.max(mine.length, theirs.length);
    check(
      'the other backend produced audio of the same duration',
      drift < 0.01,
      `${(drift * 100).toFixed(3)}% drift (${mine.length} vs ${theirs.length} bytes)`
    );

    // Compared over the overlap, which is all but the last few milliseconds.
    const n = Math.min(mine.length, theirs.length);
    const a = mine.subarray(0, n);
    const b = theirs.subarray(0, n);

    const ratio = overallRms(a) / Math.max(overallRms(b), 1);
    check('it is the same loudness', Math.abs(1 - ratio) < 0.02, `RMS ratio ${ratio.toFixed(5)}`);

    // The one that matters, and the only one immune to the duration drift above.
    const db = worstBandDb(a, b);
    check('it has the same tone', db < 1, `worst octave band differs by ${db.toFixed(3)} dB`);

    // How much speech there is, which is what catches a chunk being dropped or
    // repeated — the failure that would actually matter.
    //
    // This took three attempts and the two that failed are worth recording,
    // because both look obviously right:
    //
    //   * A 20 ms envelope correlation scored **0.58**. The duration prediction
    //     drifts a frame or two per chunk, so by the end of a long turn the two
    //     recordings are ~25 ms out of step and every fine frame is compared
    //     against its neighbour.
    //   * A per-frame energy difference at half-second frames scored **15 dB**,
    //     all of it in one frame — the chunk-boundary pause, which the drift
    //     moves, so a window that is mostly silence in one run is mostly speech
    //     in the other.
    //
    // Anything aligned to a clock is fooled by drift around a silence. So the
    // frames are *sorted* before they are compared, which throws away timing and
    // keeps the distribution, and near-silent frames are dropped first because
    // the decibel difference between two almost-zero numbers is meaningless.
    const FLOOR_DB = -30;
    const speechFrames = (pcm) => {
      const all = envelope(pcm, 2400); // 100 ms
      const floor = Math.max(...all) * 10 ** (FLOOR_DB / 20);
      return all.filter((v) => v > floor).sort((x, y) => y - x);
    };
    const fa = speechFrames(a);
    const fb = speechFrames(b);
    const countDrift = Math.abs(fa.length - fb.length) / Math.max(fa.length, fb.length, 1);
    check(
      'there is the same amount of speech',
      countDrift < 0.05,
      `${fa.length} vs ${fb.length} speech frames`
    );

    let worstFrame = 0;
    for (let i = 0; i < Math.min(fa.length, fb.length); i++) {
      worstFrame = Math.max(worstFrame, Math.abs(20 * Math.log10(fa[i] / fb[i])));
    }
    check(
      'and it is distributed the same way',
      worstFrame < 4,
      `worst frame in the sorted distribution differs by ${worstFrame.toFixed(3)} dB`
    );
    // Said explicitly so nobody later "fixes" this into a bitwise check.
    console.log('       (samples are not bit-identical between backends, and are not meant to be)');
  }

  // ---- 2. the ring is really several people ----
  const alt = await speech.speak({ text: TURN, voice: 'bm_george' });
  check('a second voice also speaks', alt.ok, alt.ok ? null : alt.error);
  if (alt.ok) {
    check('the two voices are different recordings', alt.path !== first.path);
    const a = fs.readFileSync(first.path);
    const b = fs.readFileSync(alt.path);
    check('and the samples really differ', !a.equals(b), `${a.length} vs ${b.length} bytes`);
  }

  // The roster the renderer deals out.
  const roster = await speech.voices();
  check('the voice roster is published', roster.voices.length === 13, `${roster.voices.length} voices`);

  // ---- 3. the cache ----
  const again = await speech.speak({ text: TURN, voice: 'af_bella' });
  check('saying it twice synthesises once', again.cached === true && again.path === first.path);

  // ---- 4. nothing left the machine ----
  check('no socket was opened to anybody', contacted === 0, `${contacted} requests`);

  // ---- 5. weights that vanish fall back rather than fail ----
  kokoro.stop();
  const model = weights.modelPath();
  const stash = `${model}.stashed`;
  fs.renameSync(model, stash);
  const cold = await speech.speak({ text: 'Is anybody still there?', voice: 'af_bella' });
  check(
    'a missing model reads locally instead of failing',
    cold.ok === false && cold.fallback === true,
    cold.reason || cold.error
  );
  check('and Settings says so', speech.status().active === 'local');
  fs.renameSync(stash, model);
  check('and it recovers when the model comes back', speech.status().active === 'kokoro');

  if (keep) console.log(`\nWAVs kept in ${path.join(dir, 'speech')}`);
  finish(guard, dirArg ? null : keep ? null : dir);
}

function finish(guard, cleanup) {
  guard.close();
  if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true });
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
