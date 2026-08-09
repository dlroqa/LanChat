'use strict';

// Every platform LanChat ships can actually run the offline voice.
//
// There are two runtimes. `onnxruntime-node` is the native one and is used
// wherever a binary exists for the platform; `onnxruntime-web` is the same
// runtime compiled to WebAssembly, ships no native code at all, and is what
// keeps the voice alive anywhere the native one is unavailable. This file
// guards both.
//
// The native half exists because of one specific way the feature can be lost
// without anybody noticing. onnxruntime-node bundles a prebuilt native library
// for each platform and architecture, and **the set is not stable across its
// releases**. ONNX Runtime's own v1.23.0 notes say it plainly, under Upcoming
// Changes:
//
//   "The next release will stop providing x86_64 binaries for macOS and iOS
//    operating systems."
//
// It did. Listing the npm tarballs confirms it: 1.23.2 ships
// bin/napi-v6/darwin/x64, and 1.24.1 does not. So **1.23.2 is the last native
// runtime that can speak on an Intel Mac**, and the dependency is pinned there —
// exactly, not with a caret.
//
// Since the WebAssembly backend arrived, upgrading past that line no longer
// costs Intel Macs the feature — they fall back to wasm and get slower. That is
// a real trade and still one to make deliberately rather than discover, so the
// assertion stays; only what it means has changed, and its message says so.
//
// The second half checks the pruning in build/afterPack.js against the same
// list: shipping a binary is no use if packaging then deletes it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Exactly what electron-builder.yml builds, read from it rather than restated:
// dmg and zip for mac arm64 and x64, nsis/portable for win, AppImage/deb for
// linux. If a target is added there, this list has to grow with it.
const SHIPPED = [
  ['darwin', 'arm64'],
  ['darwin', 'x64'],
  ['win32', 'x64'],
  ['linux', 'x64'],
];

test('the offline voice has a native library for every platform we ship', () => {
  const pkg = require('onnxruntime-node/package.json');
  const bin = path.join(path.dirname(require.resolve('onnxruntime-node/package.json')), 'bin', 'napi-v6');

  for (const [platform, arch] of SHIPPED) {
    const binding = path.join(bin, platform, arch, 'onnxruntime_binding.node');
    assert.ok(
      fs.existsSync(binding),
      `onnxruntime-node@${pkg.version} has no native binding for ${platform}/${arch}. ` +
        `ONNX Runtime stopped shipping macOS x86_64 after 1.23, so an upgrade past the pin ` +
        `costs Intel Macs native speed: they still speak, through the WebAssembly backend, ` +
        `but slower. Decide that deliberately rather than by bumping a version.`
    );
  }
});

test('the offline voice is pinned to an exact version, not a range', () => {
  const spec = require('../package.json').dependencies['onnxruntime-node'];
  // A caret here would let `npm install` walk onto a release that ships fewer
  // platforms, which is the whole failure this file guards.
  assert.match(spec, /^\d+\.\d+\.\d+$/, `onnxruntime-node must be pinned exactly, found "${spec}"`);
});

test('its native modules stay ABI-stable with Electron', () => {
  // Node-API v6 is what makes this work without electron-rebuild: an N-API
  // binary is stable across Node and Electron versions by contract. A package
  // that moved off N-API would need a rebuild step this repo does not have.
  const pkg = require('onnxruntime-node/package.json');
  assert.deepEqual(pkg.binary?.napi_versions, [6]);
});

// ------------------------------------------------------------------ pruning

const afterPack = require('../build/afterPack.js');
const { pruneOnnx, pruneOnnxWeb } = afterPack;

// A stand-in for what electron-builder leaves on disk: every platform's binaries
// unpacked beside the asar.
function fakeBuild(dir) {
  const root = path.join(
    dir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'onnxruntime-node',
    'bin',
    'napi-v6'
  );
  for (const [platform, arch] of [
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['linux', 'arm64'],
    ['linux', 'x64'],
    ['win32', 'arm64'],
    ['win32', 'x64'],
  ]) {
    const target = path.join(root, platform, arch);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'onnxruntime_binding.node'), Buffer.alloc(1024));
    fs.writeFileSync(path.join(target, 'libonnxruntime.so.1'), Buffer.alloc(4096));
  }
  // The GPU providers the install script fetches on linux/x64, which this app
  // never asks for.
  fs.writeFileSync(path.join(root, 'linux', 'x64', 'libonnxruntime_providers_cuda.so'), Buffer.alloc(8192));
  fs.writeFileSync(
    path.join(root, 'linux', 'x64', 'libonnxruntime_providers_tensorrt.so'),
    Buffer.alloc(2048)
  );
  return root;
}

// electron-builder's Arch enum: 0 = ia32, 1 = x64, 3 = arm64.
const ARCH = { x64: 1, arm64: 3 };

async function pack(platform, arch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-pack-'));
  const root = fakeBuild(dir);
  // The pruner directly, not the whole afterPack: the darwin path of that goes
  // on to run codesign, which on a macOS runner really executes against a
  // directory holding no .app. Signing is a separate job with its own failure
  // mode and is not what these cases are about.
  pruneOnnx({ appOutDir: dir, electronPlatformName: platform, arch: ARCH[arch] });
  const left = [];
  for (const p of fs.readdirSync(root)) {
    for (const a of fs.readdirSync(path.join(root, p))) left.push(`${p}/${a}`);
  }
  return { dir, root, left };
}

test('packaging keeps this target’s binaries and deletes every other platform', async () => {
  for (const [platform, arch] of SHIPPED) {
    const { dir, left } = await pack(platform, arch);
    assert.deepEqual(left, [`${platform}/${arch}`], `${platform}/${arch} should be all that survives`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('packaging an Intel Mac keeps the Intel Mac binary', async () => {
  // The case this whole file is about, asserted on its own so a failure names
  // it rather than being one row of a loop.
  const { dir, root, left } = await pack('darwin', 'x64');
  assert.deepEqual(left, ['darwin/x64']);
  assert.ok(fs.existsSync(path.join(root, 'darwin', 'x64', 'onnxruntime_binding.node')));
  assert.ok(!fs.existsSync(path.join(root, 'linux')), 'other platforms are gone');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('packaging drops the GPU providers nothing asks for', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-pack-'));
  const root = fakeBuild(dir);
  pruneOnnx({ appOutDir: dir, electronPlatformName: 'linux', arch: ARCH.x64 });
  pruneOnnxWeb({ appOutDir: dir, electronPlatformName: 'linux', arch: ARCH.x64 });
  const left = fs.readdirSync(path.join(root, 'linux', 'x64')).sort();
  assert.deepEqual(left, ['libonnxruntime.so.1', 'onnxruntime_binding.node']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('packaging a build without the offline voice is not an error', async () => {
  // A tree with no unpacked onnxruntime at all — which is what a build would
  // look like if the dependency were ever removed. afterPack must not throw.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-pack-'));
  fs.mkdirSync(path.join(dir, 'resources'), { recursive: true });
  pruneOnnx({ appOutDir: dir, electronPlatformName: 'linux', arch: ARCH.x64 });
  pruneOnnxWeb({ appOutDir: dir, electronPlatformName: 'linux', arch: ARCH.x64 });
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------- the WASM backend

test('the WebAssembly runtime is installed and pinned too', () => {
  const spec = require('../package.json').dependencies['onnxruntime-web'];
  assert.match(spec, /^\d+\.\d+\.\d+$/, `onnxruntime-web must be pinned exactly, found "${spec}"`);

  // Version-matched to the native one on purpose: both depend on
  // onnxruntime-common at their own version, and matching them keeps a single
  // copy resolved — which is what makes InferenceSession and Tensor literally
  // the same classes whichever backend is in use.
  assert.equal(spec, require('../package.json').dependencies['onnxruntime-node']);
});

test('the WebAssembly runtime is reachable and carries its .wasm', () => {
  const { wasmDir, backendFor } = require('../src/main/tts/kokoro.js');

  const dir = wasmDir();
  assert.ok(dir, 'onnxruntime-web did not resolve — the fallback would be silently absent');
  for (const file of ['ort.node.min.js', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
    assert.ok(fs.existsSync(path.join(dir, file)), `${file} is missing from ${dir}`);
  }

  // Resolved from the main entry rather than from package.json, because
  // onnxruntime-web's `exports` map does not list "./package.json" and asking
  // for it throws ERR_PACKAGE_PATH_NOT_EXPORTED. That threw here first, was
  // swallowed by a catch, and read as "no wasm backend on this machine" — which
  // on an Intel Mac would have meant no voice at all.
  assert.throws(() => require.resolve('onnxruntime-web/package.json'), /ERR_PACKAGE_PATH_NOT_EXPORTED/);

  // Something is always available, so the engine is never left with nothing.
  assert.ok(['native', 'wasm'].includes(backendFor()));
});

test('packaging keeps the three WebAssembly files and drops the rest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-pack-'));
  fakeBuild(dir);
  const web = path.join(dir, 'resources', 'app.asar.unpacked', 'node_modules', 'onnxruntime-web', 'dist');
  fs.mkdirSync(web, { recursive: true });
  // What the package really contains: every variant, and a map for each.
  for (const name of [
    'ort.node.min.js',
    'ort-wasm-simd-threaded.mjs',
    'ort-wasm-simd-threaded.wasm',
    'ort-wasm-simd-threaded.jsep.wasm',
    'ort-wasm-simd-threaded.asyncify.wasm',
    'ort.webgl.min.js',
    'ort.all.min.js.map',
    'ort.bundle.min.mjs',
  ]) {
    fs.writeFileSync(path.join(web, name), Buffer.alloc(2048));
  }

  pruneOnnx({ appOutDir: dir, electronPlatformName: 'linux', arch: ARCH.x64 });
  pruneOnnxWeb({ appOutDir: dir, electronPlatformName: 'linux', arch: ARCH.x64 });

  assert.deepEqual(fs.readdirSync(web).sort(), [
    'ort-wasm-simd-threaded.mjs',
    'ort-wasm-simd-threaded.wasm',
    'ort.node.min.js',
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('packaging refuses to ship a WebAssembly runtime missing a piece', async () => {
  // Losing one of the three would only surface as a machine with no voice and
  // nothing to explain it, so the build stops instead.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanchat-pack-'));
  fakeBuild(dir);
  const web = path.join(dir, 'resources', 'app.asar.unpacked', 'node_modules', 'onnxruntime-web', 'dist');
  fs.mkdirSync(web, { recursive: true });
  fs.writeFileSync(path.join(web, 'ort.node.min.js'), Buffer.alloc(16));
  fs.writeFileSync(path.join(web, 'ort.webgl.min.js'), Buffer.alloc(16));

  assert.throws(
    () => pruneOnnxWeb({ appOutDir: dir, electronPlatformName: 'linux', arch: ARCH.x64 }),
    /WebAssembly fallback would not load/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
