'use strict';

// The Kokoro weights on this machine: where they are, whether they are whole,
// and getting them if they are not.
//
// Written to the same rules as the rest of main. Sockets through node:https
// rather than fetch, redirects followed by hand and counted, every file written
// beside its target and renamed into place so a run that dies mid-write cannot
// leave a truncated model that every later launch would load as if it were
// whole — the same temp-then-rename the speech cache uses, for the same reason.
//
// One thing here is new to this codebase: **downloads are verified by hash.**
// updater.js checks a downloaded installer's length and nothing else, which
// catches the failure that happens by accident. This is 93 MB that gets handed to
// an inference engine, so it is checked against the sha256 pinned in manifest.js,
// which was itself cross-checked against Hugging Face's LFS etag. A file that
// does not match is deleted rather than kept, because a bad file that stays on
// disk is a bad file that gets retried forever.
//
// Nothing in here runs unless the user pressed Download. There is no first-launch
// fetch and no background poll: with the engine left alone this module opens no
// socket, exactly like speech.js around it.

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');

const manifest = require('./manifest.js');

// A slow network on a 86 MB file, not a busy machine. Applied per socket-idle
// rather than to the whole transfer, so a genuinely slow link finishes.
const IDLE_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;

// Hashing 93 MB is a second of work, so it is not done on every status check —
// only after a download, and on demand. `ready()` asks the cheap question: is
// every file present and the right length? A wrong-length file is the common
// corruption and costs a stat to find.
function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { 'user-agent': 'LanChat' } }, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        // Hugging Face redirects LFS objects to a CDN on another host, so the
        // location is resolved against the current URL rather than assumed
        // absolute.
        return resolve(get(new URL(headers.location, url).href, redirects + 1));
      }
      if (statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${statusCode}`));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new Error('the connection stalled')));
  });
}

function createWeights({ userDataDir, host = manifest.HOST, onProgress = null }) {
  const dir = path.join(userDataDir, 'tts', 'kokoro');

  function pathOf(local) {
    return path.join(dir, ...local.split('/'));
  }

  function modelPath() {
    return pathOf('model.onnx');
  }

  function voicePath(voice) {
    return pathOf(`voices/${voice}.bin`);
  }

  // Present and the right length, for every file. The question `speak()` asks on
  // every single turn, so it must stay a handful of stats.
  function ready() {
    try {
      for (const file of manifest.FILES) {
        const stat = fs.statSync(pathOf(file.local));
        if (stat.size !== file.bytes) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  // How much of the download is already done, for the Settings line. Counts only
  // files that are the right length, so a half-written file does not read as
  // progress that never completes.
  function bytesOnDisk() {
    let total = 0;
    for (const file of manifest.FILES) {
      try {
        const stat = fs.statSync(pathOf(file.local));
        if (stat.size === file.bytes) total += stat.size;
      } catch {
        // Not there yet.
      }
    }
    return total;
  }

  // The full check, hashes included. Used after a download and by the test
  // suite; too slow for the hot path.
  async function verify() {
    for (const file of manifest.FILES) {
      const full = pathOf(file.local);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        return { ok: false, file: file.local, reason: 'missing' };
      }
      if (stat.size !== file.bytes) return { ok: false, file: file.local, reason: 'wrong size' };
      const digest = await sha256Of(full);
      if (digest !== file.sha256) return { ok: false, file: file.local, reason: 'wrong contents' };
    }
    return { ok: true };
  }

  // One file, streamed to disk, hashed as it lands.
  //
  // The hash is computed from the bytes going past rather than by reading the
  // file back, so a disk that lies about what it wrote is caught too, and a
  // 86 MB file is not read twice.
  async function fetchOne(file, signal, progress) {
    const full = pathOf(file.local);
    fs.mkdirSync(path.dirname(full), { recursive: true });

    const url = `${host}/${manifest.REPO}/resolve/${manifest.REVISION}/${file.remote}`;
    const res = await get(url);
    const temp = `${full}.${process.pid}.part`;
    const hash = crypto.createHash('sha256');

    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(temp);
      let received = 0;
      let stopped = false;

      const fail = (err) => {
        if (stopped) return;
        stopped = true;
        res.destroy();
        out.destroy();
        reject(err);
      };

      const abort = () => fail(new Error('cancelled'));
      if (signal) signal.addEventListener('abort', abort, { once: true });

      res.on('data', (chunk) => {
        received += chunk.length;
        hash.update(chunk);
        // A file that keeps sending past its stated length is not the file.
        if (received > file.bytes) fail(new Error('longer than expected'));
        else if (progress) progress(chunk.length);
      });
      res.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => {
        if (signal) signal.removeEventListener('abort', abort);
        if (stopped) return;
        if (received !== file.bytes) return fail(new Error(`incomplete (${received} of ${file.bytes})`));
        resolve();
      });
      res.pipe(out);
    }).catch((err) => {
      fs.rmSync(temp, { force: true });
      throw err;
    });

    const digest = hash.digest('hex');
    if (digest !== file.sha256) {
      fs.rmSync(temp, { force: true });
      throw new Error(`${file.local} did not match its checksum`);
    }
    fs.renameSync(temp, full);
  }

  // Everything missing, in order, reporting as it goes.
  //
  // Files already on disk at the right length are skipped, which is what makes a
  // failed download resumable: pressing Download again picks up where it stopped
  // rather than starting the 86 MB again. Progress counts those skipped bytes so
  // the bar does not restart at zero.
  async function download({ signal = null } = {}) {
    const total = manifest.TOTAL_BYTES;
    let done = 0;

    for (const file of manifest.FILES) {
      const full = pathOf(file.local);
      try {
        if (fs.statSync(full).size === file.bytes) {
          done += file.bytes;
          onProgress?.({ received: done, total, file: file.local });
          continue;
        }
      } catch {
        // Not there; fetch it.
      }

      if (signal?.aborted) return { ok: false, error: 'The download was stopped.' };

      const base = done;
      let intoFile = 0;
      try {
        await fetchOne(file, signal, (n) => {
          intoFile += n;
          done = base + Math.min(intoFile, file.bytes);
          onProgress?.({ received: done, total, file: file.local });
        });
      } catch (err) {
        if (err.message === 'cancelled') return { ok: false, error: 'The download was stopped.' };
        return { ok: false, error: `Could not download the voice model.`, detail: err.message };
      }
      done = base + file.bytes;
      onProgress?.({ received: done, total, file: file.local });
    }

    return { ok: true, bytes: total };
  }

  // Getting the disk back. Used by Settings' Remove, and deliberately narrow: it
  // deletes the weights directory and nothing above it.
  function remove() {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  return {
    dir,
    pathOf,
    modelPath,
    voicePath,
    ready,
    bytesOnDisk,
    verify,
    download,
    remove,
    total: manifest.TOTAL_BYTES,
  };
}

module.exports = { createWeights, sha256Of };
