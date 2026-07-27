// How long the launch splash stays up.
//
// The number lives here rather than inline in splash.jsx so it can be asserted
// without a browser, and so the one place that has to agree with the CSS
// choreography ("Launch splash" in styles.css) is obvious from both sides.

// The full sequence: ignite (0–1.2s), bubble (1.2–2.0s), the dots running,
// wordmark (2.6–3.4s), hairline (3.4–9.4s), handoff (9.4–10s).
export const SPLASH_MS = 10000;

// Under reduced motion every animation is off, so there is no sequence left to
// watch — only a still mark. Holding that for ten seconds would be the worst of
// both worlds: no motion *and* the full wait. Long enough to register as an
// identity, short enough not to be an obstacle.
export const REDUCED_SPLASH_MS = 1200;

// Dismissing early still fades rather than cutting, so the window behind does
// not appear to snap into place.
export const SKIP_FADE_MS = 220;

export function splashDuration(reducedMotion) {
  return reducedMotion ? REDUCED_SPLASH_MS : SPLASH_MS;
}
