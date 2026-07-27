import React, { useEffect, useState, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import Logo from './components/Logo.jsx';
import { splashDuration, SKIP_FADE_MS } from './lib/splashTiming.js';
import './styles.css';

// The launch splash. A separate Vite entry (see vite.config.js) loaded into its
// own frameless window by src/main/splash.js, which closes it once both this
// screen is finished and the real window is ready to be shown.
//
// It imports the app's stylesheet, so the mark below is the same `<Logo>` the
// welcome state renders — the splash cannot drift away from the app's own icon.

const WORD = 'LanChat';

// The main process passes the version in the URL rather than over IPC: it is
// known before the window is even created, and a query string costs nothing to
// read under the strict CSP this page runs with.
function version() {
  const v = new URLSearchParams(window.location.search).get('v');
  return v ? `v${v}` : '';
}

function Splash() {
  const [leaving, setLeaving] = useState(false);
  const skipped = useRef(false);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const finish = useCallback(() => {
    window.lanchatSplash?.done();
  }, []);

  // Clicking or pressing Esc ends it early. The screen stays interactive the
  // whole way through — nothing here should ever hold someone hostage.
  //
  // The guard is a ref rather than the `leaving` state because a second click
  // can land before React has re-rendered, and it would otherwise start a
  // second exit on top of the first.
  const skip = useCallback(() => {
    if (skipped.current) return;
    skipped.current = true;
    setLeaving(true);
    setTimeout(finish, SKIP_FADE_MS);
  }, [finish]);

  useEffect(() => {
    const timer = setTimeout(finish, splashDuration(reduced));
    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') skip();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
    };
  }, [finish, skip, reduced]);

  return (
    <div
      className={`splash ${leaving ? 'is-leaving' : ''}`}
      onClick={skip}
      role="img"
      aria-label="LanChat is starting"
    >
      <div className="splash-bloom" />
      <div className="splash-mark">
        <Logo size={112} />
      </div>
      <div className="splash-word" aria-hidden="true">
        {WORD.split('').map((ch, i) => (
          // --pos again, the same way the status label staggers its letters.
          <i key={`${ch}${i}`} style={{ '--pos': i + 1 }}>
            {ch}
          </i>
        ))}
      </div>
      <div className="splash-version">{version()}</div>
      <div className="splash-track">
        <div className="splash-fill" />
      </div>
      <div className="splash-hint">Click to skip</div>
    </div>
  );
}

createRoot(document.getElementById('splash-root')).render(<Splash />);
