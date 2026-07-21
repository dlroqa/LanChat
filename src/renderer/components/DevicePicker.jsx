import React, { useEffect, useState, useCallback } from 'react';
import { listDevices, ensureLabels, labelFor, onDeviceChange } from '../lib/devices.js';

// Microphone + camera source selectors. Used both in Settings (persisted
// preference) and mid-call (live switching via replaceTrack).
export default function DevicePicker({ audioInputId, videoInputId, onChange, showVideo = true, compact = false }) {
  const [devices, setDevices] = useState({ audioInputs: [], videoInputs: [] });
  const [needsPermission, setNeedsPermission] = useState(false);

  const refresh = useCallback(async () => {
    const d = await listDevices();
    setDevices(d);
    // Empty labels mean permission has never been granted, so names are hidden.
    const all = [...d.audioInputs, ...d.videoInputs];
    setNeedsPermission(all.length > 0 && all.every((x) => !x.label));
  }, []);

  useEffect(() => {
    refresh();
    return onDeviceChange(refresh);
  }, [refresh]);

  async function grant() {
    await ensureLabels();
    refresh();
  }

  return (
    <div>
      <div className="field" style={compact ? { marginBottom: 10 } : undefined}>
        <label htmlFor="mic">Microphone</label>
        <select id="mic" value={audioInputId || ''} onChange={(e) => onChange('audioInputId', e.target.value || null)}>
          <option value="">System default</option>
          {devices.audioInputs.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {labelFor(d, i, 'Microphone')}
            </option>
          ))}
        </select>
      </div>

      {showVideo && (
        <div className="field" style={compact ? { marginBottom: 10 } : undefined}>
          <label htmlFor="cam">Camera</label>
          <select id="cam" value={videoInputId || ''} onChange={(e) => onChange('videoInputId', e.target.value || null)}>
            <option value="">System default</option>
            {devices.videoInputs.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {labelFor(d, i, 'Camera')}
              </option>
            ))}
          </select>
        </div>
      )}

      {needsPermission && (
        <button className="btn ghost" onClick={grant} style={{ width: '100%', marginTop: 2 }}>
          Allow access to show device names
        </button>
      )}
      {devices.audioInputs.length === 0 && devices.videoInputs.length === 0 && (
        <div className="hint">No input devices detected.</div>
      )}
    </div>
  );
}
