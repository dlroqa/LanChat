// Ringtones and notification sounds, synthesized with the Web Audio API.
//
// Generated rather than shipped as audio files: nothing to bundle, nothing to
// load from disk or network, and it all works offline inside the packaged app.
// A user-supplied file can be used instead for either category.

// ---------------------------------------------------------------- definitions

// note: [frequency, startOffset, duration, type?]
export const RINGTONES = {
  classic: {
    label: 'Classic',
    loop: 3000,
    notes: [
      [440, 0, 0.4], [554, 0, 0.4],
      [440, 0.6, 0.4], [554, 0.6, 0.4],
    ],
  },
  chime: {
    label: 'Chime',
    loop: 3400,
    notes: [
      [1047, 0, 0.5], [784, 0.18, 0.5], [523, 0.36, 0.8],
      [1047, 1.2, 0.5], [784, 1.38, 0.5], [523, 1.56, 0.9],
    ],
  },
  pulse: {
    label: 'Pulse',
    loop: 2400,
    notes: [
      [880, 0, 0.12], [880, 0.2, 0.12], [880, 0.4, 0.12],
      [880, 0.9, 0.12], [880, 1.1, 0.12], [880, 1.3, 0.12],
    ],
  },
  marimba: {
    label: 'Marimba',
    loop: 3000,
    notes: [
      [659, 0, 0.28, 'triangle'], [784, 0.16, 0.28, 'triangle'],
      [988, 0.32, 0.36, 'triangle'], [784, 0.52, 0.4, 'triangle'],
      [659, 1.1, 0.28, 'triangle'], [988, 1.26, 0.5, 'triangle'],
    ],
  },
  digital: {
    label: 'Digital',
    loop: 2600,
    notes: [
      [1200, 0, 0.1, 'square'], [900, 0.12, 0.1, 'square'],
      [1200, 0.28, 0.1, 'square'], [900, 0.4, 0.1, 'square'],
      [1200, 0.8, 0.1, 'square'], [900, 0.92, 0.1, 'square'],
    ],
  },
  radar: {
    label: 'Radar',
    loop: 3200,
    notes: [
      [600, 0, 0.22], [800, 0.22, 0.22], [1000, 0.44, 0.22], [1250, 0.66, 0.34],
      [600, 1.4, 0.22], [800, 1.62, 0.22], [1000, 1.84, 0.22], [1250, 2.06, 0.34],
    ],
  },
};

// Ordered loosely from subtle to most attention-grabbing.
export const NOTIFICATIONS = {
  ping: { label: 'Ping', notes: [[1200, 0, 0.14]] },
  pop: { label: 'Pop', notes: [[520, 0, 0.07, 'triangle'], [900, 0.05, 0.09, 'triangle']] },
  bloop: { label: 'Bloop', notes: [[400, 0, 0.1, 'sine'], [700, 0.08, 0.14, 'sine']] },
  chirp: { label: 'Chirp', notes: [[1400, 0, 0.07], [1800, 0.06, 0.09]] },
  knock: { label: 'Knock', notes: [[180, 0, 0.09, 'square'], [150, 0.14, 0.11, 'square']] },
  bell: { label: 'Bell', notes: [[1047, 0, 0.5], [1568, 0.02, 0.4]] },
  alert: {
    label: 'Alert (attention-grabbing)',
    notes: [
      [1318, 0, 0.12, 'square'], [1760, 0.14, 0.12, 'square'],
      [1318, 0.3, 0.12, 'square'], [1760, 0.44, 0.2, 'square'],
    ],
  },
  subtle: { label: 'Subtle', notes: [[660, 0, 0.18, 'sine']] },
};

export const DEFAULT_RINGTONE = 'classic';
export const DEFAULT_NOTIFICATION = 'ping';

// ------------------------------------------------------------------- playback

let sharedCtx = null;
function ctx() {
  if (!sharedCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    sharedCtx = new Ctx();
  }
  if (sharedCtx.state === 'suspended') sharedCtx.resume().catch(() => {});
  return sharedCtx;
}

// One note with short fades so it never clicks.
function playNote(audio, [freq, at, dur, type = 'sine'], startAt, volume) {
  const gain = audio.createGain();
  const peak = Math.max(0, Math.min(1, volume)) * 0.25;
  const t0 = startAt + at;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(peak, t0 + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  gain.connect(audio.destination);

  const osc = audio.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(gain);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

function playPattern(notes, volume) {
  const audio = ctx();
  const start = audio.currentTime + 0.01;
  for (const n of notes) playNote(audio, n, start, volume);
}

// Plays a one-shot notification sound (or the user's custom file).
export function playNotification(name, { volume = 0.7, customUrl = null } = {}) {
  if (name === 'custom' && customUrl) return playFile(customUrl, volume);
  const def = NOTIFICATIONS[name] || NOTIFICATIONS[DEFAULT_NOTIFICATION];
  try {
    playPattern(def.notes, volume);
  } catch {
    // Audio unavailable — never let a sound break messaging.
  }
  return null;
}

// Call-event chimes. A descending two-note "door close" says someone left; a
// brighter ascending pair says someone joined. Distinct from message sounds so
// call activity is recognizable without looking.
const CALL_EVENTS = {
  leave: [
    [660, 0, 0.16, 'sine'],
    [440, 0.15, 0.26, 'sine'],
  ],
  join: [
    [520, 0, 0.14, 'sine'],
    [784, 0.13, 0.22, 'sine'],
  ],
};

export function playCallEvent(kind, { volume = 0.6 } = {}) {
  const notes = CALL_EVENTS[kind];
  if (!notes) return;
  try {
    playPattern(notes, volume);
  } catch {
    // Audio unavailable — never let a chime break a call.
  }
}

// Radio-style push-to-talk cues, so hold-to-talk feels like a GMRS/ham handheld.
// The transmitter hears a short rising "talk-permit" tone the instant they key
// up — a prompt to press first, then speak — while the receiver hears a distinct
// descending "incoming" tone a beat before the audio streams. Kept short and in
// different registers so the two are never mistaken for each other.
const PTT_CUES = {
  transmit: [
    [587, 0, 0.07, 'sine'],
    [880, 0.06, 0.13, 'sine'],
  ],
  incoming: [
    [1175, 0, 0.07, 'sine'],
    [880, 0.06, 0.13, 'sine'],
  ],
};

export function playPttCue(kind, { volume = 0.6 } = {}) {
  const notes = PTT_CUES[kind];
  if (!notes) return;
  try {
    playPattern(notes, volume);
  } catch {
    // Audio unavailable — never let a cue break push-to-talk.
  }
}

function playFile(url, volume) {
  try {
    const el = new Audio(url);
    el.volume = Math.max(0, Math.min(1, volume));
    el.play().catch(() => {});
    return el;
  } catch {
    return null;
  }
}

// Repeating ring for incoming/outgoing calls.
export class Ringer {
  constructor() {
    this.timer = null;
    this.kind = null;
    this.audioEl = null;
  }

  // kind: 'incoming' | 'outgoing'
  start(kind, { ringtone = DEFAULT_RINGTONE, volume = 0.8, customUrl = null } = {}) {
    if (this.kind === kind) return;
    this.stop();
    this.kind = kind;

    // Ringback for the caller is deliberately quieter and simpler than the
    // ringtone the callee hears.
    if (kind === 'outgoing') {
      const notes = [[440, 0, 1.2], [480, 0, 1.2]];
      const cycle = () => {
        try {
          playPattern(notes, volume * 0.35);
        } catch {}
      };
      cycle();
      this.timer = setInterval(cycle, 4000);
      return;
    }

    if (ringtone === 'custom' && customUrl) {
      try {
        this.audioEl = new Audio(customUrl);
        this.audioEl.loop = true;
        this.audioEl.volume = Math.max(0, Math.min(1, volume));
        this.audioEl.play().catch(() => {});
      } catch {}
      return;
    }

    const def = RINGTONES[ringtone] || RINGTONES[DEFAULT_RINGTONE];
    const cycle = () => {
      try {
        playPattern(def.notes, volume);
      } catch {}
    };
    cycle();
    this.timer = setInterval(cycle, def.loop);
  }

  // Preview a ringtone once, for the settings screen.
  static preview(ringtone, { volume = 0.8, customUrl = null } = {}) {
    if (ringtone === 'custom' && customUrl) return playFile(customUrl, volume);
    const def = RINGTONES[ringtone] || RINGTONES[DEFAULT_RINGTONE];
    try {
      playPattern(def.notes, volume);
    } catch {}
    return null;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.kind = null;
    if (this.audioEl) {
      try {
        this.audioEl.pause();
        this.audioEl.currentTime = 0;
      } catch {}
      this.audioEl = null;
    }
  }
}
