import React, { useEffect, useState } from 'react';
import ModalShell from './ModalShell.jsx';
import { Download } from '../lib/icons.jsx';
import { formatBytes } from '../lib/util.js';

const api = window.lanchat;

// Shown once per launch when the startup check finds a newer release.
//
// Deliberately dismissable in two different ways: "Later" asks again next
// launch, "Skip this version" records the version so this particular release
// never prompts again. An update prompt that cannot be silenced becomes a
// prompt people learn to dismiss without reading.
export default function UpdatePrompt({ info, onClose, onSkip, autoStart = false }) {
  const [phase, setPhase] = useState('available'); // available|downloading|ready|manual|error
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => api.onEvent((evt) => evt.type === 'update-progress' && setProgress(evt.payload)), []);

  // Opened via the "Update now" banner button: start downloading straight away
  // so a single click begins the update, with progress shown here.
  useEffect(() => {
    if (autoStart) download();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function download() {
    setPhase('downloading');
    setError(null);
    try {
      await api.downloadUpdate();
      setPhase('ready');
    } catch (err) {
      setError(err.message);
      setPhase('error');
    }
  }

  async function install() {
    try {
      const res = await api.installUpdate();
      // A package-manager handoff leaves this window up; everything else quits.
      if (res && res.status === 'manual') setPhase('manual');
    } catch (err) {
      setError(err.message);
      setPhase('error');
    }
  }

  const pct = progress && progress.total ? Math.round((progress.received / progress.total) * 100) : 0;
  // Downloading must not be interrupted by a stray Escape or backdrop click.
  const dismissable = phase === 'available' || phase === 'error';

  return (
    <ModalShell
      title={`LanChat ${info.latest} is available`}
      desc={`You\u2019re on ${info.current}. Updating to ${info.latest} keeps calls, group video, and file transfers working reliably \u2014 peers on newer versions can otherwise behave unexpectedly.`}
      onClose={dismissable ? onClose : null}
    >
      {info.notes && (
        <div className="field">
          <label>What&apos;s new</label>
          <pre className="update-notes">{info.notes}</pre>
        </div>
      )}

      {phase === 'downloading' && (
        <div className="field">
          <div className="progress">
            <span style={{ width: `${pct}%` }} />
          </div>
          <div className="hint">
            {pct}%{progress?.total ? ` of ${formatBytes(progress.total)}` : ''}
          </div>
        </div>
      )}

      {phase === 'ready' && (
        <div className="hint">Downloaded. LanChat will restart to finish installing.</div>
      )}
      {phase === 'manual' && (
        <div className="hint">Downloaded. Your package manager has been opened to finish the install.</div>
      )}
      {phase === 'error' && <div className="agent-result bad">Update failed: {error}</div>}

      <div className="modal-actions">
        {dismissable && (
          <>
            <button className="btn ghost" onClick={onSkip} title={`Stop reminding me about ${info.latest}`}>
              Skip this version
            </button>
            <button className="btn ghost" onClick={onClose}>
              Later
            </button>
          </>
        )}
        {phase === 'available' && (
          <button className="btn primary" onClick={download}>
            <Download size={16} />
            Download {info.assetName ? `(${formatBytes(info.size)})` : ''}
          </button>
        )}
        {phase === 'error' && (
          <button className="btn primary" onClick={download}>
            Try again
          </button>
        )}
        {phase === 'downloading' && (
          <button className="btn primary" disabled>
            Downloading…
          </button>
        )}
        {phase === 'ready' && (
          <button className="btn primary" onClick={install}>
            Install &amp; Restart
          </button>
        )}
        {phase === 'manual' && (
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        )}
      </div>
    </ModalShell>
  );
}
