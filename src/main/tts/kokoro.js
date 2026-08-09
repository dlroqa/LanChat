'use strict';

// Main's side of the Kokoro worker: start it, keep it, feed it one turn at a
// time, and let it go when nobody is listening.
//
// The interesting part is not the queue. It is what happens when the worker dies
// during session creation, which is a real outcome on real machines: ONNX
// Runtime's default graph optimisation level segfaults while loading a quantised
// model on a CPU with no AVX-family instructions. A segfault is not an exception
// — the process is simply gone — so it cannot be handled where it happens, only
// out here where it looks like an exit code.
//
// So the first open is a probe. Start at ONNX Runtime's own default; if the
// worker dies before answering, start a second one at 'basic' and write that
// choice into config so the crash happens at most once per machine, ever. The
// fast path is not slowed down for the slow one, and no CPU model is named
// anywhere in this file.

const fs = require('node:fs');
const path = require('node:path');

const manifest = require('./manifest.js');

// Which ONNX Runtime this machine can use, and in what order of preference.
//
// **Native, if there is one for this platform.** onnxruntime-node ships one
// prebuilt binary per platform and architecture and the set is not stable
// across its releases: ONNX Runtime announced in v1.23.0 that the next release
// would stop shipping x86_64 binaries for macOS, and it did. So 1.23.2 is the
// last native runtime that speaks on an Intel Mac.
//
// **WebAssembly otherwise.** onnxruntime-web is the same runtime compiled to
// wasm, with an official Node entry point and no native binary anywhere, so it
// runs wherever Node does. It is what keeps the offline voice alive on any
// platform the native package stops publishing for — which is why the pin on
// onnxruntime-node is now about *speed* rather than about whether the feature
// exists at all.
//
// Both are plain path lookups, so this costs a stat rather than a dlopen and
// can be answered on every status call.

// `bin/napi-v6/<platform>/<arch>/onnxruntime_binding.node`.
function bindingAvailable() {
  try {
    const pkg = require.resolve('onnxruntime-node/package.json');
    const binary = path.join(
      path.dirname(pkg),
      'bin',
      'napi-v6',
      process.platform,
      process.arch,
      'onnxruntime_binding.node'
    );
    return fs.existsSync(binary);
  } catch {
    // The dependency is not installed at all — a source checkout without
    // `npm install`, or a build that pruned it.
    return false;
  }
}

// Where onnxruntime-web keeps its .wasm, or null if it is not installed.
//
// Resolved through `require.resolve` rather than by walking up from __dirname,
// so it lands in the right place in a source tree and inside a packaged app
// alike — Electron redirects reads of unpacked paths transparently, which is the
// same trick bindingAvailable() above relies on.
//
// Resolved from the *main entry* rather than from package.json, unlike the
// native check above. onnxruntime-web declares an `exports` map that does not
// list "./package.json", so asking for that subpath throws
// ERR_PACKAGE_PATH_NOT_EXPORTED — which a catch turns into a silent "no wasm
// backend here" and an Intel Mac with no voice. The main entry is exported by
// definition and already resolves into dist/, which is the directory wanted.
function wasmDir() {
  try {
    const dir = path.dirname(require.resolve('onnxruntime-web'));
    // The runtime itself, not just the package: packaging prunes this directory
    // down to the three files that are actually needed, and a prune that went
    // wrong should read as "no wasm backend" rather than as a backend that
    // fails on the first turn.
    return fs.existsSync(path.join(dir, 'ort-wasm-simd-threaded.wasm')) ? dir : null;
  } catch {
    return null;
  }
}

// What this machine will actually run, or null if it can run neither. Null is
// what makes Settings say so before the engine is chosen, rather than saying
// "Ready" and then falling back to the local voice on every turn with nothing on
// screen explaining why — the same distinction the API-key gate makes.
function backendFor() {
  if (bindingAvailable()) return 'native';
  if (wasmDir()) return 'wasm';
  return null;
}

// Loading the model is seconds of work; a turn is much less. Both get the same
// generous budget because the alternative — a timeout that fires while the model
// is genuinely still working — abandons a turn that was about to succeed.
const OPEN_TIMEOUT_MS = 120000;
const SPEAK_TIMEOUT_MS = 180000;

// How long an idle engine keeps ~90 MB resident before giving it back. Long
// enough that reading a session aloud never pays the load cost twice, short
// enough that a window left open overnight is not holding the model.
const IDLE_MS = 5 * 60 * 1000;

// The levels tried, in order. The first is ONNX Runtime's own default.
const OPTIMIZATIONS = Object.freeze(['all', 'basic']);

// The default spawner. Kept behind a parameter so the whole engine can be driven
// under `node --test` with child_process.fork, which is the only way any of this
// gets tested without an Electron window on screen.
function electronFork(script) {
  // Required lazily: this module is loaded by tests that have no electron.
  const { utilityProcess } = require('electron');
  const child = utilityProcess.fork(script, [], { stdio: 'inherit' });
  return {
    send: (message) => child.postMessage(message),
    onMessage: (handler) => child.on('message', handler),
    onExit: (handler) => child.on('exit', handler),
    kill: () => child.kill(),
  };
}

// `backend` is injectable only so the test suite can drive every answer —
// native, wasm and neither — on a machine that has only one of them installed.
// Nothing but a test passes it.
function createKokoro({
  weights,
  config = null,
  fork = electronFork,
  workerPath = null,
  idleMs = IDLE_MS,
  backend = backendFor,
}) {
  const script = workerPath || path.join(__dirname, 'kokoroWorker.js');

  let worker = null;
  let opening = null;
  let nextId = 1;
  const pending = new Map();
  let idleTimer = null;
  let queue = Promise.resolve();

  // Which optimisation level this machine is known to survive. Remembered in
  // config so a machine that crashed once does not crash again on every launch.
  function level() {
    const stored = config?.get?.('speechModelOptimization');
    return OPTIMIZATIONS.includes(stored) ? stored : null;
  }

  function rememberLevel(value) {
    if (!config?.set) return;
    if (level() === value) return;
    config.set({ speechModelOptimization: value });
  }

  function clearIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  function armIdle() {
    clearIdle();
    if (!idleMs) return;
    idleTimer = setTimeout(() => stop(), idleMs);
    // Never a reason to keep the app alive.
    idleTimer.unref?.();
  }

  // Everything in flight fails together when the worker goes, whatever took it —
  // a crash, a kill, or an orderly close. Leaving a promise unsettled here would
  // wedge the queue and with it every later turn.
  function abandon(reason) {
    const waiting = [...pending.values()];
    pending.clear();
    for (const entry of waiting) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
  }

  function stop() {
    clearIdle();
    const dying = worker;
    worker = null;
    opening = null;
    abandon('the speech engine stopped');
    try {
      dying?.kill();
    } catch {
      // Already gone.
    }
  }

  function spawn() {
    const child = fork(script);
    child.onMessage((message) => {
      const entry = message && pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message);
      else entry.reject(new Error(message.error || 'the speech engine failed'));
    });
    child.onExit(() => {
      if (worker === child) worker = null;
      opening = null;
      abandon('the speech engine stopped unexpectedly');
    });
    return child;
  }

  function ask(child, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('the speech engine did not answer in time'));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      try {
        child.send({ id, ...body });
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  // Bringing up a worker at one optimisation level. Resolves with the worker, or
  // rejects — including when the process died rather than answered, which is the
  // case this whole dance exists for.
  async function openAt(optimization) {
    const child = spawn();
    const which = backend();
    try {
      await ask(
        child,
        {
          kind: 'open',
          modelPath: weights.modelPath(),
          tokenizerPath: weights.pathOf('tokenizer.json'),
          optimization,
          // Which runtime, and where its .wasm is. Decided here so the worker
          // never has to work out whether it is inside a packaged app.
          backend: which,
          wasmDir: which === 'wasm' ? wasmDir() : null,
        },
        OPEN_TIMEOUT_MS
      );
    } catch (err) {
      try {
        child.kill();
      } catch {
        // Already gone — which is the interesting case.
      }
      throw err;
    }
    worker = child;
    return child;
  }

  // A worker with the model open, starting one if there is not one already.
  async function engine() {
    if (worker) return worker;
    if (opening) return opening;

    opening = (async () => {
      const known = level();
      const tries = known ? [known] : OPTIMIZATIONS;
      let last = null;
      for (const optimization of tries) {
        try {
          const child = await openAt(optimization);
          rememberLevel(optimization);
          return child;
        } catch (err) {
          last = err;
          // Fall through to the next level. The one that matters is a worker
          // that exited without answering; a genuine error (a missing file, a
          // model that takes different inputs) will fail the same way at every
          // level and the loop ends with it.
        }
      }
      throw last || new Error('the speech engine could not start');
    })();

    try {
      return await opening;
    } finally {
      opening = null;
    }
  }

  // One turn. Serialised behind every turn before it, because there is one
  // session and ONNX Runtime is not reentrant across concurrent run() calls on
  // it — and because two turns synthesised at once on a busy CPU is slower than
  // the same two in order.
  function synthesize({ text, voice, speed = 1 }) {
    const run = queue.then(
      () => once({ text, voice, speed }),
      () => once({ text, voice, speed })
    );
    // The queue follows completion, not success: one failed turn must not
    // poison every turn behind it.
    queue = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  async function once({ text, voice, speed }) {
    clearIdle();
    try {
      const child = await engine();
      const answer = await ask(
        child,
        {
          kind: 'speak',
          voicesDir: weights.pathOf('voices'),
          voice,
          text,
          speed,
        },
        SPEAK_TIMEOUT_MS
      );
      return { pcm: answer.pcm, ms: answer.ms, seconds: answer.seconds };
    } finally {
      armIdle();
    }
  }

  // Getting the weights, and giving them back.
  //
  // Both go through here rather than straight to the weights store because both
  // must stop the worker first: a running worker holds model.onnx open, and on
  // Windows a file that is open cannot be replaced or deleted. Downloading over
  // a model that is currently being read from would be the same bug with a
  // longer fuse.
  async function download(options) {
    stop();
    return weights.download(options);
  }

  function remove() {
    stop();
    return weights.remove();
  }

  return {
    synthesize,
    stop,
    download,
    remove,
    verify: () => weights.verify(),
    // Both halves: the model on disk, and a runtime on this machine able to run
    // it. Either one missing means the local voice reads instead.
    ready: () => Boolean(backend()) && weights.ready(),
    // Kept under its old name because Settings and speech.js both read it, and
    // it still answers the same question — only the set of ways to say yes has
    // grown from "a native binary exists" to "a native binary or the wasm one".
    supported: () => Boolean(backend()),
    // Which runtime is in use, for the line in Settings that explains why a
    // machine without a native library is slower. Null when neither is present.
    backend,
    bytesOnDisk: () => weights.bytesOnDisk(),
    running: () => Boolean(worker),
    voices: () => [...manifest.RING],
  };
}

module.exports = { createKokoro, OPTIMIZATIONS, IDLE_MS, bindingAvailable, wasmDir, backendFor };
