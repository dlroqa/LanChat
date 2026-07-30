// How long the connection light stays up.
//
// The numbers live here rather than inline in AgentFlash.jsx for the same reason
// splashTiming.js exists: they can be asserted without a browser, and the one
// place that has to agree with the CSS choreography ("Agent connection light" in
// styles.css) is obvious from both sides.

// Long enough to read as an arrival, short enough never to be in the way. The
// length varies per play so summoning an agent twice does not feel like the same
// cutscene replaying — but the range is narrow, so it never reads as inconsistent
// either.
export const CONNECT_MIN_MS = 4000;
export const CONNECT_MAX_MS = 8000;

// A run that came back with nothing in it. One pass, not an ambient presence:
// this is a report on something that just finished, not a state to sit in.
export const EMPTY_MS = 1400;

// Under reduced motion there is no rotation and no sheen, so there is no
// choreography left to watch — only a soft fade. Holding that for the full eight
// seconds would be the worst of both worlds: no motion *and* the whole wait.
export const REDUCED_CONNECT_MS = 2600;

export function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// `pick` is injectable so a test can drive both ends of the range without
// stubbing a global.
//
// The clamp is not defensive tidiness. Whatever comes back from here becomes a
// setTimeout delay, and a value outside the range — from a seeded pick in a test,
// or from a future refactor handing this something other than Math.random — would
// become NaN or a number of minutes. Either one is a light that never leaves,
// sitting over somebody's conversation.
export function connectDuration(reducedMotion, pick = Math.random) {
  if (reducedMotion) return REDUCED_CONNECT_MS;
  const raw = typeof pick === 'function' ? pick() : NaN;
  const t = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.5;
  return Math.round(CONNECT_MIN_MS + t * (CONNECT_MAX_MS - CONNECT_MIN_MS));
}

// The two lengths behind one call, so a caller never has to know which mode maps
// to which constant.
export function flashDuration(mode, reducedMotion, pick) {
  return mode === 'empty' ? EMPTY_MS : connectDuration(reducedMotion, pick);
}
