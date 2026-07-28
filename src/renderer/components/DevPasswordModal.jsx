import React, { useEffect, useState } from 'react';
import ModalShell from './ModalShell.jsx';

const api = window.lanchat;

// Password gate for the Developer panel. This is a local convenience lock, not
// real security: the hash and every verification attempt stay in the main
// process (see main/devgate.js) — the renderer only ever learns ok/lockedMs.
export default function DevPasswordModal({ onUnlock, onClose }) {
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(false);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);

  // Only ticks while a lockout is active, so the countdown is live without a
  // timer running the rest of the time.
  useEffect(() => {
    if (!lockedUntil) return undefined;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [lockedUntil]);

  const lockedMs = Math.max(0, lockedUntil - now);
  const locked = lockedMs > 0;

  async function submit() {
    if (locked || busy || !password) return;
    setBusy(true);
    try {
      const res = await api.verifyDevPassword(password);
      if (res?.ok) {
        onUnlock();
        return;
      }
      setWrong(true);
      if (res?.lockedMs) setLockedUntil(Date.now() + res.lockedMs);
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell title="Developer" desc="Enter the developer password to continue." onClose={onClose}>
      <div className="field">
        <label htmlFor="devpw">Password</label>
        <input
          id="devpw"
          type="password"
          value={password}
          autoFocus
          disabled={locked}
          onChange={(e) => {
            setPassword(e.target.value);
            setWrong(false);
          }}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {locked ? (
          <div className="field-error">Too many attempts — try again in {Math.ceil(lockedMs / 1000)}s</div>
        ) : (
          wrong && <div className="field-error">Incorrect password.</div>
        )}
      </div>

      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" onClick={submit} disabled={!password || locked || busy}>
          {busy ? 'Checking…' : 'Unlock'}
        </button>
      </div>
    </ModalShell>
  );
}
