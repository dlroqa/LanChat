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
