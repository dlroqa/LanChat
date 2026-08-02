import React from 'react';
import ModalShell from './ModalShell.jsx';

// A device we know turned up holding a different key.
//
// There is exactly one innocent explanation — they reinstalled, or lost the file
// that held their key — and one that is not. Nothing here can tell them apart, so
// this asks rather than decides, and it is deliberately not shaped like a routine
// confirmation:
//
//   The two fingerprints are the content, not a detail under a heading. Comparing
//   them out loud is the entire mechanism, so they are the largest thing here.
//
//   Nothing is focused by default and the accept action is not the primary
//   button. A dialog that can be dismissed by pressing Return is a dialog that
//   gets dismissed by pressing Return.
//
//   The cost is stated before it is paid. Accepting revokes every agent this
//   peer could reach, because the peer id survives a key change and the grant
//   list would otherwise outlive the warning.
export default function KeyChangeModal({ alarm, onAccept, onForget, onClose }) {
  const who = alarm.name || alarm.peerId;
  return (
    <ModalShell onClose={onClose}>
      <h3>Verify {who} again</h3>
      <p className="desc">
        {who} is using a different key than the one this device remembers. That happens when somebody
        reinstalls LanChat — and it is also what it looks like when somebody else is pretending to be them.
        Until this is resolved they cannot connect.
      </p>

      <div className="key-change-keys">
        <div className="key-change-key">
          <span className="label">The key you trusted</span>
          <div className="fingerprint">{alarm.knownFingerprint || 'unknown'}</div>
        </div>
        <div className="key-change-key offered">
          <span className="label">The key being offered now</span>
          <div className="fingerprint">{alarm.offeredFingerprint || 'unknown'}</div>
        </div>
      </div>

      <p className="desc">
        Ask {who} — over a call, or in person, not over LanChat — to read out the key shown in their own
        Settings. Accept only if it matches the second one above.
      </p>
      <p className="desc">
        Accepting also takes back every agent {who} was allowed to reach. You can grant those again
        afterwards.
      </p>

      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Not now
        </button>
        <button className="btn" onClick={onForget}>
          Forget this device
        </button>
        <button className="btn danger" onClick={onAccept}>
          The keys match — trust it
        </button>
      </div>
    </ModalShell>
  );
}
