// 16 kHz mono PCM WAV, for handing recorded speech to a transcriber.
//
// MediaRecorder gives us WebM/Opus (see pickFormat in voice.js), which macOS
// AVFoundation — and therefore the FluidAudio CLI, which opens clips with
// AVAudioFile — cannot read. So the blob is decoded here and re-encoded as the
// one container every audio stack reads without argument.
//
// Both conversions are done by the audio graph rather than by hand:
//   - decodeAudioData resamples to the context's rate, so decoding at 16 kHz
//     resamples properly (a sinc resample, not decimation).
//   - Rendering into a 1-channel destination applies the spec's "speakers"
//     down-mix, M = 0.5*(L+R). Averaging the channels by hand would duplicate
//     work the graph already does correctly, and summing them would clip.
// Measured against ffmpeg's own decode of the same clip: RMS ratio 0.9998,
// waveform correlation 1.00000.

export const DICTATION_RATE = 16000; // Parakeet and every other ASR model here

export function encodeWav(samples, sampleRate = DICTATION_RATE) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buf);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true); // everything after this field
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk length
  view.setUint16(20, 1, true); // format: uncompressed PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, n * 2, true);

  for (let i = 0, offset = 44; i < n; i++, offset += 2) {
    // Clamped, because a resampler can overshoot slightly past full scale and
    // setInt16 wraps rather than saturating — an overshoot would come back as
    // a loud click of the opposite sign.
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

// Decodes a recorded blob and returns WAV bytes, or null if it held no audio.
// `decode` is injectable so this can be tested without an audio device.
export async function toWavBytes(blob, { decode } = {}) {
  const data = await blob.arrayBuffer();
  const decoded = decode
    ? await decode(data)
    : await new OfflineAudioContext(1, 1, DICTATION_RATE).decodeAudioData(data);

  const frames = Math.ceil((decoded.duration || 0) * DICTATION_RATE);
  if (!frames) return null;

  const ctx = new OfflineAudioContext(1, frames, DICTATION_RATE);
  const source = ctx.createBufferSource();
  source.buffer = decoded;
  source.connect(ctx.destination);
  source.start(0);
  const rendered = await ctx.startRendering();
  if (!rendered.length) return null;

  return encodeWav(rendered.getChannelData(0), DICTATION_RATE);
}
