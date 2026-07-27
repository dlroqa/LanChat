import { useEffect, useRef, useState } from 'react';

// Motion for the agent panel's status row: the label types itself in under a
// block cursor, and the pip beside it bursts while the agent is actually doing
// something.
//
// The frame maths lives here as plain functions so the rhythm can be tested
// without a renderer, and so both pieces of motion tick off the same clock.

// One tick per character. Fast enough to read as typing rather than as a word
// being spelled out, slow enough that the cursor is visibly travelling.
export const STEP_MS = 48;

// Ticks of stillness once the cursor reaches the end of the word, before a
// sweep starts over. Without it the cursor snaps back the instant it arrives
// and the row never settles.
export const HOLD_TICKS = 8;

// A cursor sweep is two phases sharing one clock:
//
//   pass 0  — typing. Characters at or past the cursor are not shown yet, so
//             the word builds up left to right behind it.
//   pass 1+ — scanning. The whole word is there and the cursor runs back
//             across it, which is what an agent mid-thought looks like.
//
// `head` is the character the cursor is sitting on, or null while the row is
// resting at the end of a pass.
export function sweepFrame(tick, len) {
  if (len <= 0) return { head: null, typed: true };
  const span = len + HOLD_TICKS;
  const pass = Math.floor(tick / span);
  const pos = tick % span;
  return { head: pos < len ? pos : null, typed: pass > 0 };
}

// The tick at which the first pass has finished typing and the word is whole.
// Past this point a still row is a correct row, so a label that is not going to
// keep sweeping can simply stop here.
export function typedTick(len) {
  return len;
}

// Drives `sweepFrame` off a real interval. `sweeping` keeps the cursor running
// after the word is typed; without it the hook types the label once and stops,
// which is what a settled state should look like.
export function useSweep(text, sweeping, enabled = true) {
  const len = text ? text.length : 0;
  const [tick, setTick] = useState(() => (enabled ? 0 : typedTick(len)));

  useEffect(() => {
    if (!enabled) {
      setTick(typedTick(len));
      return undefined;
    }
    setTick(0);
    const stop = typedTick(len);
    const id = setInterval(() => {
      setTick((t) => {
        // A settled label types itself in and then leaves the cursor behind.
        if (!sweeping && t >= stop) {
          clearInterval(id);
          return t;
        }
        return t + 1;
      });
    }, STEP_MS);
    return () => clearInterval(id);
  }, [text, sweeping, enabled, len]);

  return sweepFrame(tick, len);
}

// Neon hues for the burst, spaced far enough apart that consecutive bursts are
// obviously different colours rather than two shades of the same one. Hues
// only — saturation and lightness are pinned in CSS so every burst stays inside
// the contrast band the dark surface can carry.
export const BURST_HUES = [
  158, // mint
  190, // cyan
  212, // electric blue
  268, // violet
  292, // magenta
  330, // hot pink
  16, // coral
  44, // amber
  96, // lime
];

// Picks a hue that is not the one already burning, so the colour genuinely
// changes on every burst instead of occasionally repeating itself.
export function nextHue(current, rand = Math.random) {
  const options = BURST_HUES.filter((h) => h !== current);
  return options[Math.floor(rand() * options.length)] ?? BURST_HUES[0];
}

// How long one burst takes to fly out and fade. Kept in step with the CSS
// animation of the same name, so the colour changes between bursts rather than
// halfway through one.
export const BURST_MS = 1500;

export function useBurstHue(active) {
  const [hue, setHue] = useState(BURST_HUES[0]);
  const hueRef = useRef(hue);
  hueRef.current = hue;

  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setHue(nextHue(hueRef.current)), BURST_MS);
    return () => clearInterval(id);
  }, [active]);

  return hue;
}

// ---- The Ready burst ----
//
// The one moment in the row's life that had no motion of its own: an agent
// finishing. Busy and Ready both look after themselves, but the step between
// them was a silent class swap, so a job that had just landed looked exactly
// like a row that had been idle all afternoon. A firework marks the edge.

// How long one burst takes to fly out and fade to nothing. In step with the CSS
// animation of the same length, so the element is unmounted the moment after it
// stops being visible rather than lingering as an invisible layer.
export const READY_BURST_MS = 2000;

// A beat between the word being whole and the burst leaving, so the two read as
// one gesture — typed, then celebrated — instead of firing over each other.
export const READY_BURST_PAD_MS = 120;

// Only a finish is worth a firework. Arriving at Ready from anywhere else —
// mounting on an idle agent, coming back online, clearing an error — is a state
// the row simply is, not something that just happened.
export function burstOnEdge(prevTone, tone) {
  return prevTone === 'busy' && tone === 'ready';
}

// When the burst launches, measured from the tone flip: the label starts typing
// itself in at the same instant, so this waits out exactly that.
export function readyBurstDelay(len) {
  return typedTick(len) * STEP_MS + READY_BURST_PAD_MS;
}

// How far a ray at this angle may travel. The row is far wider than it is tall,
// so a circular burst would be a stripe with its top and bottom sliced off by
// the border; reaching along an ellipse instead lets every ray run its full
// length and fade out in open space, whichever way it is pointed.
export function rayReach(angleDeg, rx, ry) {
  const t = (angleDeg * Math.PI) / 180;
  const x = ry * Math.cos(t);
  const y = rx * Math.sin(t);
  return (rx * ry) / Math.sqrt(x * x + y * y);
}

// Raises a new burst id once the word is typed, then drops it again when the
// firework has finished. The id is a counter rather than a flag because it is
// used as a React key: a fresh one remounts the layer, which is what restarts
// the CSS animation from its first frame — two finishes in quick succession
// each get their own burst instead of the second landing mid-flight.
export function useReadyBurst(tone, label) {
  const [burst, setBurst] = useState(null);
  const prev = useRef(tone);
  const seq = useRef(0);
  const len = label ? label.length : 0;

  useEffect(() => {
    const from = prev.current;
    prev.current = tone;
    if (!burstOnEdge(from, tone)) return undefined;

    let end;
    const start = setTimeout(() => {
      seq.current += 1;
      setBurst(seq.current);
      end = setTimeout(() => setBurst(null), READY_BURST_MS);
    }, readyBurstDelay(len));

    // Leaving the panel, or the agent picking up work again, takes the firework
    // with it — a burst is about the moment it fires, and there is nothing to
    // celebrate on a row you are no longer looking at.
    return () => {
      clearTimeout(start);
      clearTimeout(end);
      setBurst(null);
    };
  }, [tone, len]);

  return burst;
}

// Reduced motion is a system preference that can change while the app is open,
// so it is watched rather than read once at mount.
export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => matches());
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return undefined;
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

function matches() {
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}
