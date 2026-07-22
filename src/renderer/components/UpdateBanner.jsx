import React from 'react';
import { Download } from '../lib/icons.jsx';

// A subtle, non-blocking update notice pinned to the top-centre of the window.
//
// Unlike the full UpdatePrompt modal, this never interrupts what you're doing —
// it just floats above the app and offers two choices: "Update now" opens the
// real download/install flow, "Later" dismisses it for this session (it returns
// on the next periodic check or the next launch).
export default function UpdateBanner({ info, onUpdateNow, onLater }) {
  return (
    <div className="update-banner" role="status" aria-live="polite">
      <span className="update-banner-dot" aria-hidden="true" />
      <span className="update-banner-text">
        LanChat <strong>{info.latest}</strong> is available
      </span>
      <div className="update-banner-actions">
        <button className="btn ghost update-banner-btn" onClick={onLater}>
          Later
        </button>
        <button className="btn primary update-banner-btn" onClick={onUpdateNow}>
          <Download size={14} />
          Update now
        </button>
      </div>
    </div>
  );
}
