import React, { useState } from 'react';
import ModalShell from './ModalShell.jsx';
import Avatar from './Avatar.jsx';
import { Video } from '../lib/icons.jsx';

const api = window.lanchat;

// Developer panel: reachable only once DevPasswordModal has verified the
// password with main (main/devgate.js). Closing this panel immediately
// revokes that unlocked session via lockDevGate(), rather than leaving it to
// the main-process TTL alone.
//
// "Request support session" does not silently reach into a contact's camera —
// it starts an ordinary outgoing call (see App.jsx requestSupportSession /
// rtc.js CallManager) tagged `support: true`, which the other side sees as an
// explicit accept/decline prompt in IncomingCall.jsx. There is no path here
// that opens a peer's mic or camera without their own local accept.
export default function DevPanel({ peers, onRequestSupport, onClose }) {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwError, setPwError] = useState(null);
  const [pwSaved, setPwSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const online = (peers || []).filter((p) => p.online && p.kind !== 'agent');

  async function savePassword() {
    setPwSaved(false);
    if (!newPassword) return setPwError('Enter a new password.');
    if (newPassword !== confirmPassword) return setPwError('Passwords do not match.');
    setPwError(null);
    setBusy(true);
    try {
      const res = await api.setDevPassword(newPassword);
      if (res?.ok) {
        setPwSaved(true);
        setNewPassword('');
        setConfirmPassword('');
      } else {
        setPwError(res?.error || 'Could not change the password.');
      }
    } finally {
      setBusy(false);
    }
  }

  function close() {
    api.lockDevGate();
    onClose();
  }

  return (
    <ModalShell title="Developer" desc="Tools for the person maintaining this install." onClose={close}>
      <div className="section-head">Change developer password</div>
      <div className="field">
        <label htmlFor="newpw">New password</label>
        <input id="newpw" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="confirmpw">Confirm new password</label>
        <input
          id="confirmpw"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && savePassword()}
        />
        {pwError && <div className="field-error">{pwError}</div>}
        {pwSaved && <div className="hint">Password changed.</div>}
      </div>
      <div className="row" style={{ marginTop: 4 }}>
        <button className="btn" onClick={savePassword} disabled={busy}>
          {busy ? 'Saving…' : 'Save password'}
        </button>
      </div>

      <div className="section-head">Online contacts</div>
      <div className="hint" style={{ marginBottom: 8 }}>
        A support session is a normal video call — the contact sees who is asking and must accept it themselves.
      </div>
      {online.length === 0 ? (
        <div className="hint">No contacts are online right now.</div>
      ) : (
        <div className="dev-contacts">
          {online.map((p) => (
            <div key={p.id} className="dev-contact-row">
              <Avatar name={p.name} id={p.id} avatar={p.avatar} size="sm" />
              <div className="meta">
                <div className="name">{p.name}</div>
              </div>
              <button className="btn" onClick={() => onRequestSupport(p)} title="Request a support session">
                <Video size={15} /> Request support session
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="modal-actions">
        <button className="btn ghost" onClick={close}>
          Close
        </button>
      </div>
    </ModalShell>
  );
}
