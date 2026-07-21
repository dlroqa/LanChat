// Call ring tones, synthesized with the Web Audio API.
//
// Generated rather than shipped as audio files: no assets to bundle, nothing to
// load from disk or network, and it works offline inside the packaged app.
//
//   'incoming' — a two-burst "ring ring" for the person being called
//   'outgoing' — quieter ringback so the caller hears the line is live
//                (440 + 480 Hz is the North American ringback pair)

const PATTERNS = {
  incoming: {
    freqs: [440, 554],
    gain: 0.14,
    bursts: [
      { at: 0, dur: 0.4 },
      { at: 0.6, dur: 0.4 },
    ],
    period: 3000,
  },
  outgoing: {
    freqs: [440, 480],
    gain: 0.06,
    bursts: [{ at: 0, dur: 1.2 }],
    period: 4000,
  },
};

export class Ringer {
  constructor() {
    this.ctx = null;
    this.timer = null;
    this.kind = null;
  }

  start(kind) {
    if (this.kind === kind) return; // already ringing this pattern
    this.stop();
    const pattern = PATTERNS[kind];
    if (!pattern) return;
    this.kind = kind;

    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      // Without a user gesture the context can start suspended.
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    } catch {
      this.ctx = null;
      return;
    }

    const cycle = () => {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      for (const b of pattern.bursts) {
        this.burst(pattern.freqs, now + b.at, b.dur, pattern.gain);
      }
    };
    cycle();
    this.timer = setInterval(cycle, pattern.period);
  }

  // One dual-tone burst with short fades so it doesn't click.
  burst(freqs, startAt, duration, peak) {
    const ctx = this.ctx;
    if (!ctx) return;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(peak, startAt + 0.03);
    gain.gain.setValueAtTime(peak, startAt + Math.max(duration - 0.06, 0.04));
    gain.gain.linearRampToValueAtTime(0, startAt + duration);
    gain.connect(ctx.destination);

    for (const f of freqs) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      osc.connect(gain);
      osc.start(startAt);
      osc.stop(startAt + duration + 0.02);
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.kind = null;
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      ctx.close().catch(() => {});
    }
  }
}
