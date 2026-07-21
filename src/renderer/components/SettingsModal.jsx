import React, { useState } from 'react';
import DevicePicker from './DevicePicker.jsx';

const DEFAULT_STUN = 'stun:stun.l.google.com:19302';

// Settings: audio/video sources, discovery toggles, optional STUN, network info.
export default function SettingsModal({ config, self, onSave, onClose }) {
  const [enableTailscale, setTs] = useState(config.enableTailscale);
  const [enableLan, setLan] = useState(config.enableLan);
  const [useStun, setUseStun] = useState((config.iceServers || []).length > 0);
  const [showAddresses, setShowAddresses] = useState(Boolean(config.showAddresses));
  const [devices, setDevices] = useState({
    audioInputId: config.audioInputId || null,
    videoInputId: config.videoInputId || null,
  });

  function save() {
    onSave({
      enableTailscale,
      enableLan,
      iceServers: useStun ? [{ urls: DEFAULT_STUN }] : [],
      showAddresses,
      ...devices,
    });
    onClose();
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Settings</h3>
        <p className="desc">Audio, video, and discovery preferences. Changes apply immediately.</p>

        <div className="section-head">Call devices</div>
        <DevicePicker
          audioInputId={devices.audioInputId}
          videoInputId={devices.videoInputId}
          onChange={(key, value) => setDevices((d) => ({ ...d, [key]: value }))}
        />

        <div className="section-head">Discovery</div>
        <Toggle label="Discover peers over Tailscale" desc="Find people across your tailnet." on={enableTailscale} set={setTs} />
        <Toggle label="Discover peers on local network" desc="UDP broadcast on your subnet." on={enableLan} set={setLan} />
        <Toggle
          label="Use STUN fallback for calls"
          desc="Only needed on awkward networks; calls are direct on a tailnet."
          on={useStun}
          set={setUseStun}
        />

        <div className="section-head">Privacy</div>
        <Toggle
          label="Show IP addresses"
          desc="Off by default. Peers are identified by name; addresses stay hidden."
          on={showAddresses}
          set={setShowAddresses}
        />

        <div className="field" style={{ marginTop: 18 }}>
          <label>This device</label>
          <div className="hint" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
            Service port: <b>{self?.servicePort}</b>
            <br />
            Identity: <b>{self?.hostname}</b>
            <br />
            Share your Tailscale IP (from <code>tailscale ip</code>) with a peer, then they can add you via + →
            <b> IP:{self?.servicePort}</b>.
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function Toggle({ label, desc, on, set }) {
  return (
    <div className="switch">
      <div>
        <div style={{ fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: 12, color: 'var(--fg-faint)' }}>{desc}</div>
      </div>
      <button className={`toggle ${on ? 'on' : ''}`} onClick={() => set(!on)} aria-pressed={on} aria-label={label} />
    </div>
  );
}
