import React, { useEffect, useState } from 'react';
import ModalShell from './ModalShell.jsx';
import DevicePicker from './DevicePicker.jsx';
import UpdateSection from './UpdateSection.jsx';
import SoundSettings from './SoundSettings.jsx';
import AgentSection from './AgentSection.jsx';
import { PTT_KEYS, defaultPttKey, describeKeyCode } from '../lib/ptt.js';

const DEFAULT_STUN = 'stun:stun.l.google.com:19302';

// Settings: audio/video sources, discovery toggles, optional STUN, network info.
export default function SettingsModal({ config, self, peers, soundUrl, onSave, onClose }) {
  const [enableTailscale, setTs] = useState(config.enableTailscale);
  const [enableLan, setLan] = useState(config.enableLan);
  const [useStun, setUseStun] = useState((config.iceServers || []).length > 0);
  const [showAddresses, setShowAddresses] = useState(Boolean(config.showAddresses));
  const [sounds, setSounds] = useState({
    ringtone: config.ringtone,
    ringtoneVolume: config.ringtoneVolume,
    customRingtonePath: config.customRingtonePath,
    notificationSound: config.notificationSound,
    notificationVolume: config.notificationVolume,
    customNotificationPath: config.customNotificationPath,
    muteNotifications: config.muteNotifications,
  });
  const [ptt, setPtt] = useState({
    pttEnabled: config.pttEnabled !== false,
    pttKey: config.pttKey || defaultPttKey(),
    pttCustomCode: config.pttCustomCode || null,
    pttAllowIncoming: config.pttAllowIncoming !== false,
  });
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
      ...sounds,
      ...ptt,
    });
    onClose();
  }

  return (
    <ModalShell
      title="Settings"
      desc="Audio, video, and discovery preferences. Changes apply immediately."
      onClose={onClose}
    >
        <div className="section-head">Call devices</div>
        <DevicePicker
          audioInputId={devices.audioInputId}
          videoInputId={devices.videoInputId}
          onChange={(key, value) => setDevices((d) => ({ ...d, [key]: value }))}
        />

        <div className="section-head">Push to talk</div>
        <Toggle
          label="Enable push to talk"
          desc="Hold a key to transmit instantly — no ringing."
          on={ptt.pttEnabled}
          set={(v) => setPtt((p) => ({ ...p, pttEnabled: v }))}
        />
        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor="pttkey">Push-to-talk key</label>
          <select
            id="pttkey"
            value={ptt.pttKey}
            disabled={!ptt.pttEnabled}
            onChange={(e) => setPtt((p) => ({ ...p, pttKey: e.target.value }))}
          >
            {Object.entries(PTT_KEYS).map(([key, def]) => (
              <option key={key} value={key}>
                {def.label}
              </option>
            ))}
            <option value="custom">Custom key…</option>
          </select>
          {ptt.pttKey === 'custom' && (
            <KeyRecorder
              code={ptt.pttCustomCode}
              disabled={!ptt.pttEnabled}
              onRecord={(code) => setPtt((p) => ({ ...p, pttCustomCode: code }))}
            />
          )}
          <div className="hint">
            Hold to talk while LanChat is focused. It is ignored while you are typing a message, and
            releasing the key stops transmitting.
          </div>
        </div>
        <Toggle
          label="Allow others to reach you by push to talk"
          desc="Incoming audio plays without ringing. Your microphone is never opened by an incoming transmission."
          on={ptt.pttAllowIncoming}
          set={(v) => setPtt((p) => ({ ...p, pttAllowIncoming: v }))}
        />

        <div className="section-head">Sounds</div>
        <SoundSettings
          value={sounds}
          soundUrl={soundUrl}
          onChange={(patch) => setSounds((v) => ({ ...v, ...patch }))}
        />

        <div className="section-head">Agents</div>
        <AgentSection peers={peers} />

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

        <div className="section-head">Updates</div>
        <UpdateSection />

        <div className="section-head">This device</div>
        <div className="field">
          <div className="hint" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
            Service port: <b>{self?.servicePort}</b>
            <br />
            Identity: <b>{self?.hostname}</b>
            <br />
            Share your Tailscale IP (from <code>tailscale ip</code>) with a peer, then they can add you via + →
            <b> IP:{self?.servicePort}</b>.
          </div>
        </div>
        <StorageInfo />

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </div>
    </ModalShell>
  );
}

// Records a single key press and stores its physical `code`, so the binding is
// layout-independent. Escape aborts rather than binding Escape itself, which
// would leave no way to cancel out of the recorder.
function KeyRecorder({ code, disabled, onRecord }) {
  const [listening, setListening] = useState(false);

  useEffect(() => {
    if (!listening) return undefined;
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      setListening(false);
      if (e.code !== 'Escape') onRecord(e.code);
    };
    // Capture phase, so the key is claimed before anything else reacts to it.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [listening, onRecord]);

  return (
    <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 8 }}>
      <button
        className={`btn ${listening ? 'primary' : ''}`}
        disabled={disabled}
        onClick={() => setListening((v) => !v)}
      >
        {listening ? 'Press any key…' : 'Record a key'}
      </button>
      <span className="hint" style={{ margin: 0 }}>
        {listening ? 'Escape to cancel' : `Bound to ${describeKeyCode(code)}`}
      </span>
    </div>
  );
}

// Where conversations actually live on disk. Chat history is plain JSON per
// peer, so it is worth being able to find (and back up, or delete) directly.
function StorageInfo() {
  const [paths, setPaths] = useState(null);

  useEffect(() => {
    window.lanchat.getPaths().then(setPaths);
  }, []);

  if (!paths) return null;

  return (
    <div className="field">
      <label>Where your messages are stored</label>
      <div className="hint" style={{ lineHeight: 1.7 }}>
        Conversations are saved as one JSON file per contact, unencrypted, in:
        <br />
        <code className="path">{paths.history}</code>
      </div>
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <button className="btn" onClick={() => window.lanchat.revealFile(paths.history)}>
          Show in file manager
        </button>
        <button className="btn" onClick={() => window.lanchat.revealFile(paths.downloads)}>
          Received files
        </button>
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
