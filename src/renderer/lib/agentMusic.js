import { useEffect, useRef } from 'react';
import { audioContext } from './sounds.js';

// A bed of music for as long as an agent is working, and silence the rest of the
// time.
//
// The whole design is in the two edges. Work starting is a quick fade up, so the
// music arrives with the work rather than being switched on over it. Work
// finishing is a long fade down, because an agent that finishes and is asked
// something else three seconds later has not really stopped — and a bed that cut
// out and restarted on every pause would be worse than no bed at all. A run that
// begins again before the fade-out has finished simply turns the fade around
// where it stands: the track is never rewound, never restarted, never
// double-triggered.
//
// The fade runs on a GainNode rather than on the element's own volume so it is
// sample-accurate and lives on the audio thread — a fade driven by rAF freezes
// when the window is hidden, which would leave the loop playing at half volume
// behind a minimised window.
//
// Deliberately not tied to prefers-reduced-motion. That setting is about things
// moving on screen, not about sound; the toggle in Settings is the control, and
// it is off until somebody turns it on.

// Up quickly, down slowly. See above.
export const FADE_IN_MS = 600;
export const FADE_OUT_MS = 1500;

// No fade is ever instant: a gain step of any size is an audible click.
export const MIN_FADE_MS = 60;

// Following the volume slider while the bed is playing. Short enough to feel
// like the slider, long enough not to zipper.
export const VOLUME_STEP_MS = 120;

// A run that never reports finishing must not leave the loop playing for the
// rest of the day. Nothing should ever hit this — it is the difference between a
// stuck spinner, which is a bug you can ignore, and music you cannot.
export const MAX_RUN_MS = 20 * 60 * 1000;

export function clampVolume(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// How long a fade should take when it does not start from where a fade normally
// starts. Interrupt a fade-in a third of the way up and the fade back down has a
// third of the distance to cover, so it gets a third of the time: the slope is
// what the two constants above really describe, and holding it constant is what
// keeps a quick flap from sounding like a long swoop. `span` is the configured
// volume — the full travel of a fade at the current setting.
export function fadeMs(from, to, fullMs, span) {
  if (from === to) return 0;
  const reach = clampVolume(span);
  if (reach <= 0) return MIN_FADE_MS;
  const frac = Math.min(1, Math.abs(to - from) / reach);
  return Math.max(MIN_FADE_MS, Math.round(fullMs * frac));
}

export class AgentMusic {
  // The context and the element are arguments so the state machine can be driven
  // by a test without a renderer: everything that reaches outside this file goes
  // through them.
  constructor({ url = null, context = audioContext, element = (u) => new Audio(u) } = {}) {
    this.url = url || null;
    this.makeContext = context;
    this.makeElement = element;
    this.el = null;
    this.source = null;
    this.gain = null;
    this.stopTimer = null;
    this.gestureOff = null;
    this.volume = 0.5;
    // What the music is *for*, not what the element is doing. A fading-out track
    // is still playing; a track that wants to play but was refused autoplay is
    // not. This is the intent, and everything else follows it.
    this.wanted = false;
  }

  get available() {
    return Boolean(this.url);
  }

  // Built on the first start rather than in the constructor, so a build with no
  // track — or a user who never turns the setting on — never opens an
  // AudioContext or claims the output device.
  _build() {
    if (this.el) return true;
    if (!this.url) return false;
    try {
      const audio = this.makeContext();
      if (!audio) return false;
      const el = this.makeElement(this.url);
      el.loop = true;
      el.preload = 'auto';
      const source = audio.createMediaElementSource(el);
      const gain = audio.createGain();
      gain.gain.value = 0;
      source.connect(gain).connect(audio.destination);
      this.el = el;
      this.source = source;
      this.gain = gain;
      return true;
    } catch {
      // Audio unavailable — never let a soundtrack break messaging.
      return false;
    }
  }

  // Turns whatever ramp is in flight into a ramp to `to`, continuing from the
  // value the old one had actually reached. This is the whole of "a fade-out
  // that is interrupted resumes rather than restarting".
  _ramp(to, ms) {
    const audio = this.makeContext();
    const now = audio.currentTime;
    const p = this.gain.gain;
    if (typeof p.cancelAndHoldAtTime === 'function') {
      p.cancelAndHoldAtTime(now);
    } else {
      const held = p.value;
      p.cancelScheduledValues(now);
      p.setValueAtTime(held, now);
    }
    if (ms <= 0) p.setValueAtTime(to, now);
    else p.linearRampToValueAtTime(to, now + ms / 1000);
  }

  // Changing the track. A MediaElementAudioSourceNode is welded to its element
  // for good, so a different piece of music means a new pair of both — which is
  // why this tears the graph down rather than reassigning `el.src`. The intent
  // survives: swap tracks while an agent is working and the new one fades in
  // where the old one left off.
  setUrl(url) {
    const next = url || null;
    if (next === this.url) return;
    const wasWanted = this.wanted;
    this._teardown();
    this.url = next;
    if (wasWanted) this.start();
  }

  setVolume(v) {
    this.volume = clampVolume(v);
    // Dragging the slider while an agent is working is audible immediately,
    // rather than taking effect on some future run.
    if (this.wanted && this.gain) {
      try {
        this._ramp(this.volume, VOLUME_STEP_MS);
      } catch {}
    }
  }

  start() {
    if (!this._build()) return;
    try {
      // A pending fade-out is cancelled before it can pause anything.
      if (this.stopTimer) {
        clearTimeout(this.stopTimer);
        this.stopTimer = null;
      }
      this.wanted = true;
      const from = this.gain.gain.value;
      this._ramp(this.volume, fadeMs(from, this.volume, FADE_IN_MS, this.volume));
      this._play();
    } catch {}
  }

  stop() {
    if (!this.el || !this.wanted) return;
    try {
      this.wanted = false;
      const from = this.gain.gain.value;
      const ms = fadeMs(from, 0, FADE_OUT_MS, this.volume);
      this._ramp(0, ms);
      clearTimeout(this.stopTimer);
      // Paused only once it is inaudible, and only if nothing has asked for it
      // again in the meantime. `currentTime` is never touched: a loop has no
      // beginning worth returning to, and picking up where it left off is what
      // makes work, done, work again sound like one session instead of a track
      // being restarted at every pause.
      this.stopTimer = setTimeout(() => {
        this.stopTimer = null;
        if (this.wanted) return;
        try {
          this.el.pause();
        } catch {}
      }, ms + 60);
    } catch {}
  }

  _play() {
    // The shared context resumes a suspended one on the way past, which is the
    // other half of coming back from a refused autoplay.
    try {
      this.makeContext();
    } catch {}
    try {
      const p = this.el.play();
      if (p && typeof p.catch === 'function') p.catch(() => this._waitForGesture());
    } catch {
      this._waitForGesture();
    }
  }

  // Autoplay was refused because nothing has been clicked yet. Electron's own
  // default policy does not require a gesture, so in the packaged app this
  // should never fire; it is here for a renderer opened in a browser, and for
  // the day that default changes. One listener, dropped the moment it fires.
  _waitForGesture() {
    if (this.gestureOff) return;
    const retry = () => {
      this._offGesture();
      if (this.wanted) this._play();
    };
    window.addEventListener('pointerdown', retry, { once: true });
    window.addEventListener('keydown', retry, { once: true });
    this.gestureOff = () => {
      window.removeEventListener('pointerdown', retry);
      window.removeEventListener('keydown', retry);
    };
  }

  _offGesture() {
    if (!this.gestureOff) return;
    this.gestureOff();
    this.gestureOff = null;
  }

  dispose() {
    this._teardown();
  }

  _teardown() {
    clearTimeout(this.stopTimer);
    this.stopTimer = null;
    this._offGesture();
    this.wanted = false;
    try {
      this.el?.pause();
      this.gain?.disconnect();
      this.source?.disconnect();
    } catch {}
    // A MediaElementAudioSourceNode cannot be detached from its element and
    // cannot be made twice for the same one, so the two are dropped together and
    // a later start builds a fresh pair. The shared AudioContext is left open —
    // every other sound in the app is still using it.
    this.el = null;
    this.source = null;
    this.gain = null;
  }
}

// How long an audition in Settings runs before it fades itself out. Long enough
// to hear whether a loop suits being worked to, short enough that forgetting to
// stop it is not a problem.
export const PREVIEW_SECONDS = 12;

// Auditions a track with the same fades the real thing uses, so what you hear in
// Settings is what an agent starting work sounds like. Returns the stop
// function; calling it twice is harmless.
export function previewTrack(url, volume) {
  const music = new AgentMusic({ url });
  music.setVolume(volume);
  music.start();

  let stopped = false;
  const finish = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    music.stop();
    // The graph goes only once the fade-out has actually run out.
    setTimeout(() => music.dispose(), FADE_OUT_MS + 200);
  };
  const timer = setTimeout(finish, PREVIEW_SECONDS * 1000);
  return finish;
}

// Drives the bed from one boolean. Called once, at the top of the app, because
// the music is a property of the machine's state and not of whichever
// conversation happens to be open — switching threads mid-run must not touch it.
export function useAgentMusic(busy, { enabled = false, volume = 0.5, url = null } = {}) {
  const ref = useRef(null);
  // No track chosen, or "custom" with nothing picked yet, is simply silence —
  // the same as being switched off, and not a thing to report.
  const wanted = Boolean(busy) && enabled === true && Boolean(url);
  const vol = clampVolume(volume);

  // Read inside the effect below without being a dependency of it: a nudge of
  // the volume slider must not count as work stopping and starting again.
  const volRef = useRef(vol);
  volRef.current = vol;

  useEffect(() => {
    ref.current?.setVolume(vol);
  }, [vol]);

  useEffect(() => {
    if (!wanted) {
      // Not `setUrl` here as well: a track chosen while nothing is playing is
      // picked up by the `start()` below next time round, and swapping it now
      // would tear down the graph mid-fade-out and cut the tail short.
      ref.current?.stop();
      return undefined;
    }
    if (!ref.current) ref.current = new AgentMusic({ url });
    ref.current.setUrl(url);
    ref.current.setVolume(volRef.current);
    ref.current.start();
    const cap = setTimeout(() => ref.current?.stop(), MAX_RUN_MS);
    return () => clearTimeout(cap);
  }, [wanted, url]);

  // Never leave a loop playing if the window goes.
  useEffect(
    () => () => {
      ref.current?.dispose();
      ref.current = null;
    },
    []
  );
}
