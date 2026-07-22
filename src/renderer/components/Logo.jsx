import React from 'react';

// The LanChat mark — matches the app / dock icon (see scripts/make-icons.js):
// a brand-blue rounded square with a white speech bubble and three dots.
export default function Logo({ size = 84 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="LanChat">
      <rect x="2" y="2" width="96" height="96" rx="22" fill="#2563eb" />
      <rect x="18" y="24" width="64" height="40" rx="13" fill="#fff" />
      <path d="M34 60 L34 77 L51 62 Z" fill="#fff" />
      <circle cx="34" cy="44" r="5" fill="#2563eb" />
      <circle cx="50" cy="44" r="5" fill="#2563eb" />
      <circle cx="66" cy="44" r="5" fill="#2563eb" />
    </svg>
  );
}
