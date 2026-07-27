import React from 'react';

// The LanChat mark — matches the app / dock icon (see scripts/make-icons.js):
// a brand-blue rounded tile with a white speech bubble and three dots.
//
// The tile is a div, not part of the SVG, because its prism needs a conic
// gradient and a blend mode and SVG can do neither. Styling lives in the
// "The logo mark" section of styles.css, which the launch splash imports too —
// splash.jsx renders this same component, so the mark the user sees at launch
// and the one in the empty chat pane are literally the same drawing.
//
// The dots' cx values match the icon rasterizer's [0.32, 0.5, 0.68].
const DOTS = [34, 50, 66];

export default function Logo({ size = 84 }) {
  return (
    <div className="lc-logo" style={{ '--logo-size': `${size}px` }} role="img" aria-label="LanChat">
      <span className="lc-logo-prism" />
      <span className="lc-logo-sheen" />
      <svg className="lc-logo-bubble" viewBox="0 0 100 100" aria-hidden="true">
        <rect x="18" y="24" width="64" height="40" rx="13" fill="#fff" />
        <path d="M34 60 L34 77 L51 62 Z" fill="#fff" />
        {DOTS.map((cx, i) => (
          // --pos drives both the bounce stagger and the colour crest, the same
          // way it does for the letters of "Ready" in ConnectionPanel.
          <circle key={cx} className="lc-logo-dot" cx={cx} cy="44" r="5" style={{ '--pos': i + 1 }} />
        ))}
      </svg>
    </div>
  );
}
