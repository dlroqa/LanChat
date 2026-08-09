'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Two jobs after electron-builder has laid out the app directory, both of which
// have to happen here because both need to know what was actually built.

// ---------------------------------------------------------------- ONNX pruning
//
// onnxruntime-node ships every platform's native library in a single npm
// package: darwin, linux and win32, x64 and arm64, about 211 MB of binaries of
// which any one build needs exactly one pair. Nothing prunes that automatically,
// so without this the AppImage carries Windows DLLs and the Windows installer
// carries Mach-O dylibs.
//
// It is done here rather than with `files` globs in electron-builder.yml, and
// that is not a matter of taste. Naming node_modules in the `files` allowlist
// makes electron-builder fall back to packing the entire tree — src/renderer,
// test/ and scripts/ all reappear in the asar — and a per-platform `files:` list
// containing only exclusions gets `**/*` prepended, with the same result. Both
// were measured: the asar went from 3.4 MB to 15 MB. Here the platform and the
// architecture are facts on `context`, not glob macros whose spelling has to be
// guessed against onnxruntime's directory names.
//
// The binaries live in app.asar.unpacked because a .node file cannot be loaded
// from inside an archive, which is what makes them ordinary files to delete.
const ORT = ['node_modules', 'onnxruntime-node', 'bin', 'napi-v6'];

// ------------------------------------------------------------- WASM pruning
//
// The second backend. onnxruntime-web is the same runtime compiled to
// WebAssembly, and it is what keeps the offline voice working on a platform the
// native package has stopped publishing binaries for — Intel Macs, after ONNX
// Runtime dropped macOS x86_64 in 1.24.
//
// It unpacks to ~137 MB because it ships every variant there is: WebGL, JSEP,
// asyncify, training, and a source map for each. Exactly three files are used.
// Everything else is deleted rather than shipped, the same way and in the same
// place as the native binaries above, and for the same reason: this is where the
// target is a fact rather than a glob macro.
const ORT_WEB = ['node_modules', 'onnxruntime-web', 'dist'];
const ORT_WEB_KEEP = new Set([
  // The Node entry point — exports["."].node.require resolves here.
  'ort.node.min.js',
  // Which loads this, which instantiates the .wasm.
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
]);

function pruneOnnxWeb(context) {
  const dir = path.join(context.appOutDir, 'resources', 'app.asar.unpacked', ...ORT_WEB);
  if (!fs.existsSync(dir)) return;

  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (ORT_WEB_KEEP.has(name)) continue;
    const full = path.join(dir, name);
    removed += sizeOf(full);
    fs.rmSync(full, { recursive: true, force: true });
  }

  const kept = [...ORT_WEB_KEEP].filter((n) => fs.existsSync(path.join(dir, n)));
  if (kept.length === ORT_WEB_KEEP.size) {
    console.log(`  • onnxruntime-web pruned  kept ${kept.length} files, freed ${mb(removed)}`);
  } else {
    // Losing one of the three is losing the fallback, which would only show up
    // as an Intel Mac with no voice. Loud, immediately.
    const missing = [...ORT_WEB_KEEP].filter((n) => !kept.includes(n));
    throw new Error(`onnxruntime-web is missing ${missing.join(', ')} — the WebAssembly fallback would not load`);
  }
}

function pruneOnnx(context) {
  const root = path.join(context.appOutDir, 'resources', 'app.asar.unpacked', ...ORT);
  if (!fs.existsSync(root)) return; // a build without the offline voice

  const keepPlatform = context.electronPlatformName === 'mas' ? 'darwin' : context.electronPlatformName;
  const keepArch = context.arch === undefined ? process.arch : archName(context.arch);

  let removed = 0;
  let kept = null;
  for (const platform of fs.readdirSync(root)) {
    const platformDir = path.join(root, platform);
    if (platform !== keepPlatform) {
      removed += sizeOf(platformDir);
      fs.rmSync(platformDir, { recursive: true, force: true });
      continue;
    }
    for (const arch of fs.readdirSync(platformDir)) {
      const archDir = path.join(platformDir, arch);
      if (arch !== keepArch) {
        removed += sizeOf(archDir);
        fs.rmSync(archDir, { recursive: true, force: true });
        continue;
      }
      // The CUDA and TensorRT execution providers, which onnxruntime-node's
      // install script fetches on Linux x64. 315 MB of GPU libraries this app
      // never asks for — it runs on the CPU provider. CI sets
      // ONNXRUNTIME_NODE_INSTALL=skip so they should not exist at all, but a
      // developer's node_modules may still have them and an installer's size
      // should not depend on remembering an environment variable.
      for (const file of fs.readdirSync(archDir)) {
        if (!/_providers_(cuda|tensorrt)/.test(file)) continue;
        const full = path.join(archDir, file);
        removed += sizeOf(full);
        fs.rmSync(full, { force: true });
      }
      kept = `${platform}/${arch}`;
    }
  }

  // Every platform this app ships has a binary — test/ttsPackaging.test.js
  // asserts that against the installed package, so a dependency bump that
  // dropped one fails the suite rather than shipping a build with no offline
  // voice. Reaching the second branch therefore means something is wrong with
  // the build, not with the platform, and it is said out loud rather than left
  // for a user to discover.
  if (kept) console.log(`  • onnxruntime pruned  kept ${kept}, freed ${mb(removed)}`);
  else console.log(`  • onnxruntime MISSING  no binary for ${keepPlatform}/${keepArch} — Kokoro is off in this build`);
}

// electron-builder's Arch enum to the directory names onnxruntime uses, which
// are process.arch spellings — and the enum's names already are those, so this
// is a lookup rather than a mapping.
function archName(arch) {
  const { Arch } = require('electron-builder');
  return Arch[arch] || String(arch);
}

function sizeOf(target) {
  let total = 0;
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return stat.size;
  for (const name of fs.readdirSync(target)) total += sizeOf(path.join(target, name));
  return total;
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`;

// ------------------------------------------------------------ ad-hoc signing
//
// Repackaging Electron invalidates the signature it ships with, and Apple Silicon
// refuses to execute a binary with no signature at all — macOS then reports the
// app as "damaged", which is really "unsigned". An ad-hoc signature ("-") costs
// nothing, needs no Apple account, and downgrades that hard failure to the normal
// "unidentified developer" prompt users can bypass with right-click -> Open.
//
// This is NOT a substitute for a Developer ID + notarization, which is what
// removes the prompt entirely.
function signMac(context) {
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    console.log(`  • ad-hoc signed  ${appName}`);
    // Fail loudly here rather than shipping a bundle that won't launch.
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
    console.log(`  • signature verified  ${appName}`);
  } catch (err) {
    throw new Error(`ad-hoc codesign failed for ${appPath}: ${err.message}`);
  }
}

module.exports = async function afterPack(context) {
  // Before signing, always: deleting files inside the bundle after it has been
  // signed invalidates the signature, which is the failure this whole function
  // exists to prevent.
  pruneOnnx(context);
  pruneOnnxWeb(context);

  if (context.electronPlatformName !== 'darwin') return;
  signMac(context);
};

// The two pruners on their own, for test/ttsPackaging.test.js.
//
// Exported because driving them through afterPack() means also driving
// signMac(), and on a macOS runner that really does shell out to codesign —
// against the temporary directory a test built, which contains no .app. That
// failed CI on macOS alone while passing on Linux and Windows, which is the
// least useful shape a test failure can have. Pruning and signing are separate
// jobs; the tests now ask for the one they are about, and every platform runs
// every case.
module.exports.pruneOnnx = pruneOnnx;
module.exports.pruneOnnxWeb = pruneOnnxWeb;
