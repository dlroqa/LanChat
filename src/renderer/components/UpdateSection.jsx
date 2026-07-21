import React, { useEffect, useState } from 'react';
import { Refresh, Download } from '../lib/icons.jsx';
import { formatBytes } from '../lib/util.js';

const api = window.lanchat;

// "Check for Updates": queries the project's GitHub releases, downloads the
// asset for this platform, then hands off to the installer.
export default function UpdateSection() {
  const [version, setVersion] = useState('');
  const [state, setState] = useState({ phase: 'idle' }); // idle|checking|available|current|downloading|ready|error|dev|no-asset
  const [progress, setProgress] = useState(null);

  useEffect(() => {
    api.appVersion().then(setVersion);
    return api.onEvent((evt) => {
      if (evt.type === 'update-progress') setProgress(evt.payload);
    });
  }, []);

  async function check() {
    setState({ phase: 'checking' });
    setProgress(null);
    try {
      const res = await api.checkForUpdates();
      if (res.status === 'available') setState({ phase: 'available', ...res });
      else if (res.status === 'current') setState({ phase: 'current', ...res });
      else if (res.status === 'dev') setState({ phase: 'dev' });
      else if (res.status === 'no-asset') setState({ phase: 'no-asset', ...res });
    } catch (err) {
      setState({ phase: 'error', message: err.message });
    }
  }

  async function download() {
    setState((s) => ({ ...s, phase: 'downloading' }));
    try {
      await api.downloadUpdate();
      setState((s) => ({ ...s, phase: 'ready' }));
    } catch (err) {
      setState({ phase: 'error', message: err.message });
    }
  }

  async function install() {
    try {
      const res = await api.installUpdate();
      if (res.status === 'manual') {
        setState((s) => ({ ...s, phase: 'manual' }));
      }
      // On success the app quits and the installer takes over.
    } catch (err) {
      setState({ phase: 'error', message: err.message });
    }
  }

  const pct = progress && progress.total ? Math.round((progress.received / progress.total) * 100) : 0;

  return (
    <div>
      <div className="update-row">
        <div>
          <div style={{ fontWeight: 500 }}>LanChat {version}</div>
          <div className="update-status">{statusText(state)}</div>
        </div>
        {state.phase !== 'available' && state.phase !== 'ready' && state.phase !== 'downloading' && (
          <button className="btn" onClick={check} disabled={state.phase === 'checking'}>
            <Refresh size={16} />
            {state.phase === 'checking' ? 'Checking…' : 'Check for Updates'}
          </button>
        )}
        {state.phase === 'available' && (
          <button className="btn primary" onClick={download}>
            <Download size={16} />
            Download {state.latest}
          </button>
        )}
        {state.phase === 'ready' && (
          <button className="btn primary" onClick={install}>
            Install &amp; Restart
          </button>
        )}
      </div>

      {state.phase === 'downloading' && (
        <div style={{ marginTop: 10 }}>
          <div className="progress">
            <span style={{ width: `${pct}%` }} />
          </div>
          <div className="hint">
            {pct}%{progress?.total ? ` of ${formatBytes(progress.total)}` : ''}
          </div>
        </div>
      )}

      {state.phase === 'available' && state.notes && (
        <details className="release-notes">
          <summary>What&apos;s new in {state.latest}</summary>
          <pre>{state.notes}</pre>
        </details>
      )}
    </div>
  );
}

function statusText(state) {
  switch (state.phase) {
    case 'checking':
      return 'Checking GitHub for a newer release…';
    case 'available':
      return `Version ${state.latest} is available.`;
    case 'current':
      return 'You are on the latest version.';
    case 'downloading':
      return 'Downloading update…';
    case 'ready':
      return 'Update ready. LanChat will restart to finish installing.';
    case 'manual':
      return 'Downloaded. Your package manager has been opened to finish the install.';
    case 'dev':
      return 'Running from source — updates apply to installed builds only.';
    case 'no-asset':
      return 'A newer version exists, but no download matches this platform.';
    case 'error':
      return `Update check failed: ${state.message}`;
    default:
      return 'Checks the LanChat releases on GitHub.';
  }
}
