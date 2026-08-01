'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// wav.js is renderer ESM and touches only OfflineAudioContext, which is passed
// in here. The header assertions below are the ones that actually matter: they
// are the exact field values a decoder reads, and were checked against ffprobe
// and Python's `wave` on a clip produced by this encoder in Chromium.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'wav.js'), 'utf8');

function loadWav({ OfflineAudioContext = function () {} } = {}) {
  const body = SRC.replace(/^export\s+/gm, '');
  const fn = new Function(
    'OfflineAudioContext',
    `'use strict';
     ${body}
     return { DICTATION_RATE, encodeWav, toWavBytes };`
  );
  return fn(OfflineAudioContext);
}

function readHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(...bytes.slice(o, o + 4));
  return {
    riff: tag(0),
    riffSize: view.getUint32(4, true),
    wave: tag(8),
    fmt: tag(12),
    fmtLen: view.getUint32(16, true),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    rate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bits: view.getUint16(34, true),
    data: tag(36),
    dataSize: view.getUint32(40, true),
  };
}

test('the header is a canonical 16 kHz mono 16-bit PCM RIFF', () => {
  const { encodeWav } = loadWav();
  const bytes = encodeWav(new Float32Array(100));
  assert.deepEqual(readHeader(bytes), {
    riff: 'RIFF',
    riffSize: 36 + 200,
    wave: 'WAVE',
    fmt: 'fmt ',
    fmtLen: 16,
    format: 1, // uncompressed PCM
    channels: 1,
    rate: 16000,
    byteRate: 32000,
    blockAlign: 2,
    bits: 16,
    data: 'data',
    dataSize: 200,
  });
});

test('the declared sizes match the bytes actually written', () => {
  const { encodeWav } = loadWav();
  for (const n of [0, 1, 1000, 32000]) {
    const bytes = encodeWav(new Float32Array(n));
    const h = readHeader(bytes);
    assert.equal(bytes.length, 44 + n * 2, `length for ${n} samples`);
    assert.equal(h.riffSize, bytes.length - 8, `RIFF size for ${n} samples`);
    assert.equal(h.dataSize, bytes.length - 44, `data size for ${n} samples`);
  }
});

test('samples are clamped rather than wrapped', () => {
  const { encodeWav } = loadWav();
  // Overshoot past full scale is what a resampler produces, and setInt16 wraps:
  // unclamped, +1.5 would come back as a loud sample of the opposite sign.
  const bytes = encodeWav(new Float32Array([0, 1, -1, 1.5, -1.5, 0.5]));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = (i) => view.getInt16(44 + i * 2, true);
  assert.equal(at(0), 0);
  assert.equal(at(1), 32767);
  assert.equal(at(2), -32768);
  assert.equal(at(3), 32767, '+1.5 must saturate, not wrap');
  assert.equal(at(4), -32768, '-1.5 must saturate, not wrap');
  assert.equal(at(5), 16383);
});

test('a recording with no audio in it produces nothing to send', async () => {
  const { toWavBytes } = loadWav();
  const blob = { arrayBuffer: async () => new ArrayBuffer(0) };
  const result = await toWavBytes(blob, { decode: async () => ({ duration: 0 }) });
  assert.equal(result, null);
});

test('decoded audio is rendered through a mono 16 kHz context and encoded', async () => {
  const seen = {};
  // Enough of the audio graph to observe what is asked of it. The real
  // behaviour this stands in for — the "speakers" down-mix and the resample —
  // was verified against ffmpeg in a real browser; what is checked here is that
  // we ask for a 1-channel 16 kHz destination, which is what triggers it.
  function FakeOfflineAudioContext(channels, frames, rate) {
    seen.channels = channels;
    seen.frames = frames;
    seen.rate = rate;
    this.destination = { name: 'destination' };
    this.createBufferSource = () => ({
      connect: (target) => (seen.connectedTo = target.name),
      start: (when) => (seen.startedAt = when),
    });
    this.startRendering = async () => ({
      length: 3,
      getChannelData: () => new Float32Array([0, 1, -1]),
    });
  }

  const { toWavBytes } = loadWav({ OfflineAudioContext: FakeOfflineAudioContext });
  const blob = { arrayBuffer: async () => new ArrayBuffer(8) };
  const bytes = await toWavBytes(blob, { decode: async () => ({ duration: 0.5 }) });

  assert.equal(seen.channels, 1, 'a 1-channel destination is what down-mixes');
  assert.equal(seen.rate, 16000);
  assert.equal(seen.frames, 8000, '0.5s at 16 kHz');
  assert.equal(seen.connectedTo, 'destination');
  assert.equal(seen.startedAt, 0);
  assert.equal(bytes.length, 44 + 3 * 2);
  assert.equal(readHeader(bytes).dataSize, 6);
});
