'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// updater.js requires electron for app/shell. Stub it so the pure helpers can be
// unit-tested outside an Electron process.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return 'electron-stub';
  return originalResolve.call(this, request, ...args);
};
require.cache['electron-stub'] = {
  id: 'electron-stub',
  filename: 'electron-stub',
  loaded: true,
  exports: { app: { getVersion: () => '0.1.3', isPackaged: true, getPath: () => '/tmp' }, shell: {} },
};

const { compareVersions, pickAsset } = require('../src/main/updater.js');

// Real asset names as produced by our electron-builder config.
const ASSETS = [
  { name: 'LanChat-0.1.4-arm64-mac.zip' },
  { name: 'LanChat-0.1.4-arm64.dmg' },
  { name: 'LanChat-0.1.4-mac.zip' },
  { name: 'LanChat-0.1.4.dmg' },
  { name: 'LanChat-0.1.4.AppImage' },
  { name: 'LanChat.0.1.4.exe' },
  { name: 'LanChat.Setup.0.1.4.exe' },
  { name: 'lanchat_0.1.4_amd64.deb' },
];

test('compareVersions orders releases correctly', () => {
  assert.ok(compareVersions('0.1.4', '0.1.3') > 0);
  assert.ok(compareVersions('0.2.0', '0.1.9') > 0);
  assert.ok(compareVersions('1.0.0', '0.9.9') > 0);
  assert.equal(compareVersions('0.1.3', '0.1.3'), 0);
  assert.ok(compareVersions('0.1.3', '0.1.4') < 0);
  // Tag prefixes and ragged lengths must not break ordering.
  assert.equal(compareVersions('v0.1.3', '0.1.3'), 0);
  assert.ok(compareVersions('0.2', '0.1.9') > 0);
});

test('pickAsset selects the Apple Silicon zip on arm64 macOS', () => {
  const a = pickAsset(ASSETS, { platform: 'darwin', arch: 'arm64' });
  assert.equal(a.name, 'LanChat-0.1.4-arm64-mac.zip');
});

test('pickAsset does not hand an arm64 build to an Intel Mac', () => {
  const a = pickAsset(ASSETS, { platform: 'darwin', arch: 'x64' });
  assert.equal(a.name, 'LanChat-0.1.4-mac.zip');
});

test('pickAsset prefers the NSIS installer over the portable exe on Windows', () => {
  const a = pickAsset(ASSETS, { platform: 'win32', arch: 'x64' });
  assert.equal(a.name, 'LanChat.Setup.0.1.4.exe');
});

test('pickAsset chooses AppImage vs deb based on how Linux is running', () => {
  assert.equal(pickAsset(ASSETS, { platform: 'linux', arch: 'x64', isAppImage: true }).name, 'LanChat-0.1.4.AppImage');
  assert.equal(pickAsset(ASSETS, { platform: 'linux', arch: 'x64', isAppImage: false }).name, 'lanchat_0.1.4_amd64.deb');
});

// The macOS updater consumes the ZIP. Artifact names must keep resolving under
// both the default electron-builder scheme and any explicit-arch scheme, or a
// rename silently strands users on an old version.
const ASSETS_EXPLICIT_ARCH = [
  { name: 'LanChat-0.2.1-arm64.dmg' },
  { name: 'LanChat-0.2.1-x64.dmg' },
  { name: 'LanChat-0.2.1-arm64-mac.zip' },
  { name: 'LanChat-0.2.1-mac.zip' },
];

test('macOS asset resolves with explicit-arch dmg names alongside default zips', () => {
  assert.equal(
    pickAsset(ASSETS_EXPLICIT_ARCH, { platform: 'darwin', arch: 'arm64' }).name,
    'LanChat-0.2.1-arm64-mac.zip'
  );
  assert.equal(
    pickAsset(ASSETS_EXPLICIT_ARCH, { platform: 'darwin', arch: 'x64' }).name,
    'LanChat-0.2.1-mac.zip'
  );
});

test('macOS asset resolves even if zips are renamed with explicit arch', () => {
  const renamed = [{ name: 'LanChat-0.3.0-arm64.zip' }, { name: 'LanChat-0.3.0-x64.zip' }];
  assert.equal(pickAsset(renamed, { platform: 'darwin', arch: 'arm64' }).name, 'LanChat-0.3.0-arm64.zip');
  assert.equal(pickAsset(renamed, { platform: 'darwin', arch: 'x64' }).name, 'LanChat-0.3.0-x64.zip');
});

test('an Intel Mac is never handed an arm64 build', () => {
  for (const assets of [ASSETS, ASSETS_EXPLICIT_ARCH]) {
    const picked = pickAsset(assets, { platform: 'darwin', arch: 'x64' });
    assert.ok(picked && !/arm64/i.test(picked.name), `x64 must not receive ${picked && picked.name}`);
  }
});

test('pickAsset returns null rather than a wrong-platform download', () => {
  assert.equal(pickAsset([{ name: 'notes.txt' }], { platform: 'darwin', arch: 'arm64' }), null);
  assert.equal(pickAsset([], { platform: 'win32', arch: 'x64' }), null);
  assert.equal(pickAsset(undefined, { platform: 'linux', arch: 'x64' }), null);
});
