'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { spawn, execFileSync } = require('node:child_process');
const { app, shell } = require('electron');

// Self-updater backed by the GitHub Releases API.
//
// Why not electron-updater/Squirrel? Squirrel.Mac refuses to apply an update
// unless the app carries a real Developer ID signature, and LanChat ships
// ad-hoc signed (no paid Apple account). So we do the three steps ourselves:
// check -> download -> hand off to a detached script that swaps the files once
// this process has exited (nothing can be replaced while it is still running).
//
// Trust model: assets are fetched over HTTPS from the project's own GitHub
// release, and the downloaded size is checked against the size GitHub reports
// so a truncated download can never be executed.

const REPO = 'dlroqa/LanChat';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;

// ---------------------------------------------------------------- pure helpers

// Compares dotted versions. Returns >0 if a is newer than b.
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Chooses the right release asset for this machine.
function pickAsset(assets, { platform, arch, isAppImage }) {
  const names = (assets || []).filter((a) => a && a.name);
  const find = (pred) => names.find(pred) || null;

  if (platform === 'darwin') {
    // The zip is what we can swap in place; the dmg needs a manual drag.
    return arch === 'arm64'
      ? find((a) => /-arm64-mac\.zip$/i.test(a.name))
      : find((a) => /-mac\.zip$/i.test(a.name) && !/arm64/i.test(a.name));
  }
  if (platform === 'win32') {
    // "Setup" is the NSIS installer, which upgrades in place.
    return find((a) => /setup.*\.exe$/i.test(a.name)) || find((a) => /\.exe$/i.test(a.name));
  }
  if (platform === 'linux') {
    if (isAppImage) return find((a) => /\.AppImage$/i.test(a.name));
    return find((a) => /\.deb$/i.test(a.name)) || find((a) => /\.AppImage$/i.test(a.name));
  }
  return null;
}

// ------------------------------------------------------------------ networking

function httpsGet(url, headers = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': `LanChat/${app.getVersion()}`, ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpsGet(res.headers.location, headers, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('request timed out')));
  });
}

async function fetchJson(url) {
  const res = await httpsGet(url, { Accept: 'application/vnd.github+json' });
  let body = '';
  for await (const chunk of res) body += chunk;
  return JSON.parse(body);
}

function downloadTo(url, dest, expectedSize, onProgress) {
  return new Promise((resolve, reject) => {
    httpsGet(url, { Accept: 'application/octet-stream' })
      .then((res) => {
        const total = Number(res.headers['content-length']) || expectedSize || 0;
        let received = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (c) => {
          received += c.length;
          if (onProgress) onProgress({ received, total });
        });
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => {
            const size = fs.statSync(dest).size;
            // Guard against a truncated download being executed.
            if (expectedSize && size !== expectedSize) {
              return reject(new Error(`download incomplete (${size} of ${expectedSize} bytes)`));
            }
            resolve(dest);
          });
        });
        out.on('error', reject);
        res.on('error', reject);
      })
      .catch(reject);
  });
}

// ------------------------------------------------------------------- installers

function tmpDir() {
  const dir = path.join(os.tmpdir(), `lanchat-update-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Runs a script detached so it outlives this process, then quits the app.
function runDetached(command, args, cwd) {
  const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore' });
  child.unref();
}

function installMac(file, onLog) {
  const work = path.dirname(file);
  const extract = path.join(work, 'extracted');
  fs.mkdirSync(extract, { recursive: true });

  // ditto understands macOS zip metadata; unzip can mangle app bundles.
  execFileSync('ditto', ['-x', '-k', file, extract]);
  const appName = fs.readdirSync(extract).find((n) => n.endsWith('.app'));
  if (!appName) throw new Error('no .app found inside the downloaded archive');
  const newApp = path.join(extract, appName);

  // Match how our CI builds are signed, and clear the download quarantine so
  // the replacement launches without the "damaged" dialog.
  try {
    execFileSync('xattr', ['-dr', 'com.apple.quarantine', newApp]);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', newApp]);
  } catch (err) {
    onLog?.(`warning: could not re-sign update (${err.message})`);
  }

  // /Applications/LanChat.app/Contents/MacOS/LanChat -> /Applications/LanChat.app
  const current = app.getPath('exe').split('/Contents/MacOS/')[0];
  const script = path.join(work, 'install.sh');
  fs.writeFileSync(
    script,
    `#!/bin/bash
set -e
# Wait for LanChat to exit before touching its bundle.
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done
sleep 0.5
rm -rf "${current}"
ditto "${newApp}" "${current}"
open "${current}"
`,
    { mode: 0o755 }
  );
  runDetached('/bin/bash', [script], work);
}

function installWindows(file) {
  // The NSIS installer performs the in-place upgrade and relaunches.
  runDetached(file, [], path.dirname(file));
}

function installAppImage(file) {
  const current = process.env.APPIMAGE;
  const work = path.dirname(file);
  const script = path.join(work, 'install.sh');
  fs.writeFileSync(
    script,
    `#!/bin/bash
set -e
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done
sleep 0.5
mv -f "${file}" "${current}"
chmod +x "${current}"
"${current}" &
`,
    { mode: 0o755 }
  );
  runDetached('/bin/bash', [script], work);
}

// --------------------------------------------------------------------- service

function createUpdater({ bus }) {
  let pending = null; // { version, asset, file }

  function platformInfo() {
    return {
      platform: process.platform,
      arch: process.arch,
      isAppImage: Boolean(process.env.APPIMAGE),
    };
  }

  async function check() {
    // Packaged builds only: in dev there is nothing to replace.
    if (!app.isPackaged) {
      return { status: 'dev', current: app.getVersion() };
    }
    const release = await fetchJson(API);
    const latest = String(release.tag_name || release.name || '').replace(/^v/, '');
    const current = app.getVersion();
    if (!latest) throw new Error('could not read the latest version');

    if (compareVersions(latest, current) <= 0) {
      return { status: 'current', current, latest };
    }
    const asset = pickAsset(release.assets, platformInfo());
    if (!asset) {
      return { status: 'no-asset', current, latest, url: release.html_url };
    }
    pending = { version: latest, asset, file: null };
    return {
      status: 'available',
      current,
      latest,
      notes: (release.body || '').slice(0, 4000),
      assetName: asset.name,
      size: asset.size,
      url: release.html_url,
    };
  }

  async function download() {
    if (!pending) throw new Error('check for updates first');
    const dir = tmpDir();
    const dest = path.join(dir, pending.asset.name);
    await downloadTo(pending.asset.browser_download_url, dest, pending.asset.size, (p) =>
      bus.emit('update-progress', p)
    );
    pending.file = dest;
    return { status: 'downloaded', file: dest, version: pending.version };
  }

  // Hands off to a detached installer and quits so files can be replaced.
  function install() {
    if (!pending || !pending.file) throw new Error('download the update first');
    const { platform, isAppImage } = platformInfo();
    const log = (m) => bus.emit('update-log', m);

    if (platform === 'darwin') installMac(pending.file, log);
    else if (platform === 'win32') installWindows(pending.file);
    else if (platform === 'linux' && isAppImage) installAppImage(pending.file);
    else {
      // .deb needs root; hand it to the system package installer instead.
      shell.showItemInFolder(pending.file);
      shell.openPath(pending.file);
      return { status: 'manual', file: pending.file };
    }

    app.isQuitting = true;
    setTimeout(() => app.quit(), 400);
    return { status: 'installing' };
  }

  return { check, download, install };
}

module.exports = { createUpdater, compareVersions, pickAsset };
