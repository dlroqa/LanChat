// Measures the loudness of a MediaStream's audio track.
//
// Used to make call problems diagnosable: a moving local meter proves the
// microphone is actually capturing, and a flat remote meter alongside inbound
// RTP bytes distinguishes "not being sent" from "not being played".

export function createLevelMeter(stream) {
  if (!stream || stream.getAudioTracks().length === 0) return null;
  let ctx;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    ctx = new Ctx();
  } catch {
    return null;
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});

  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.6;
  source.connect(analyser);
  const buf = new Uint8Array(analyser.frequencyBinCount);

  return {
    // 0..1 RMS loudness.
    getLevel() {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 1) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      return Math.min(1, Math.sqrt(sum / buf.length) * 3);
    },
    stop() {
      try {
        source.disconnect();
        analyser.disconnect();
      } catch {}
      ctx.close().catch(() => {});
    },
  };
}
