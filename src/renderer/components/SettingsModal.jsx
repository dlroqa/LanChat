import React, { useEffect, useState } from 'react';
import ModalShell from './ModalShell.jsx';
import DevicePicker from './DevicePicker.jsx';
import UpdateSection from './UpdateSection.jsx';
import SoundSettings from './SoundSettings.jsx';
import AgentSection from './AgentSection.jsx';
import { PTT_KEYS, defaultPttKey, describeKeyCode } from '../lib/ptt.js';

const DEFAULT_STUN = 'stun:stun.l.google.com:19302';
// FluidVoice's LocalAPI.defaultPort. Duplicated from main/dictation.js because
// the renderer cannot require it; main clamps whatever arrives regardless, so
// this only decides what an emptied field saves as.
const DEFAULT_DICTATION_PORT = 47733;

// Settings: audio/video sources, discovery toggles, optional STUN, network info.
export default function SettingsModal({ config, self, peers, soundUrl, onSave, onClose }) {
  const [enableTailscale, setTs] = useState(config.enableTailscale);
  // Applied immediately rather than batched into Save, like openAtLogin below:
  // this decides who may open a socket to this machine, and a setting like that
  // should not sit in a draft state where the window shows one thing and the
  // listener is doing another.
  const [acceptLan, setAcceptLan] = useState(Boolean(config.acceptLan));
  const [security, setSecurity] = useState(null);
  const [enableLan, setLan] = useState(config.enableLan);
  const [useStun, setUseStun] = useState((config.iceServers || []).length > 0);
  const [showAddresses, setShowAddresses] = useState(Boolean(config.showAddresses));
  const [linkPreviews, setLinkPreviews] = useState(config.linkPreviews !== false);
  const [findSessionsOnly, setFindSessionsOnly] = useState(Boolean(config.findSessionsOnly));
  // Applied immediately via IPC (not batched into onSave), since the OS login
  // item should reflect the toggle the moment it changes.
  const [openAtLogin, setOpenAtLogin] = useState(Boolean(config.openAtLogin));
  const [sounds, setSounds] = useState({
    ringtone: config.ringtone,
    ringtoneVolume: config.ringtoneVolume,
    customRingtonePath: config.customRingtonePath,
    notificationSound: config.notificationSound,
    notificationVolume: config.notificationVolume,
    customNotificationPath: config.customNotificationPath,
    muteNotifications: config.muteNotifications,
    agentMusicEnabled: config.agentMusicEnabled,
    agentMusic: config.agentMusic,
    agentMusicVolume: config.agentMusicVolume,
    customAgentMusicPath: config.customAgentMusicPath,
  });
  const [ptt, setPtt] = useState({
    pttEnabled: config.pttEnabled !== false,
    pttKey: config.pttKey || defaultPttKey(),
    pttCustomCode: config.pttCustomCode || null,
    pttAllowIncoming: config.pttAllowIncoming !== false,
    dictationEnabled: config.dictationEnabled !== false,
    dictationPort: config.dictationPort ?? '',
  });
  const [devices, setDevices] = useState({
    audioInputId: config.audioInputId || null,
    videoInputId: config.videoInputId || null,
  });

  // Our own fingerprint, and whether anybody can currently reach us.
  useEffect(() => {
    let alive = true;
    window.lanchat.security().then((s) => alive && setSecurity(s));
    return () => {
      alive = false;
    };
  }, [acceptLan]);

  function save() {
    onSave({
      enableTailscale,
      enableLan,
      iceServers: useStun ? [{ urls: DEFAULT_STUN }] : [],
      showAddresses,
      linkPreviews,
      findSessionsOnly,
      ...devices,
      ...sounds,
      ...ptt,
      // The field is text; the port is a number. An empty or unparseable box
      // means the default rather than an error — main clamps it again anyway,
      // since a config file can be edited by hand.
      dictationPort: Number.parseInt(ptt.dictationPort, 10) || DEFAULT_DICTATION_PORT,
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
        <Dictation value={ptt} set={setPtt} />

        <div className="section-head">Sounds</div>
        <SoundSettings
          value={sounds}
          soundUrl={soundUrl}
          onChange={(patch) => setSounds((v) => ({ ...v, ...patch }))}
        />

        <div className="section-head">Agents</div>
        <AgentSection peers={peers} />

        <div className="section-head">Security</div>
        {security && security.reachability && security.reachability.unreachable && (
          <div className="field-warning" role="status">
            Nobody can reach this device. LanChat only accepts connections over Tailscale, and no
            tailnet was found — turn on the setting below to accept them over your local network
            instead.
          </div>
        )}
        <Toggle
          label="Accept connections from the local network"
          desc={
            acceptLan
              ? 'Anyone on the networks you join can open a connection. They still have to prove who they are, ' +
                'but messages over a plain network are not encrypted in transit the way Tailscale encrypts them. ' +
                'Prefer Tailscale on networks you do not control.'
              : 'Only devices reaching you over Tailscale can connect, where traffic is already encrypted.'
          }
          on={acceptLan}
          set={(v) => {
            setAcceptLan(v);
            window.lanchat.setAcceptLan(v);
          }}
        />
        {security && security.fingerprint && (
          <div className="field">
            <label>This device's key</label>
            <div className="fingerprint" title={security.publicKey || ''}>
              {security.fingerprint}
            </div>
            <div className="hint">
              Read this out to somebody adding you for the first time — if it matches what they see,
              nobody is standing in between. {security.keyMode === 'sealed'
                ? 'The key is held in your system keychain.'
                : 'The key is stored in a file only you can read.'}
            </div>
          </div>
        )}

        <div className="section-head">Conversations</div>
        <Toggle
          label="Find only in sessions"
          desc="The search button beside a conversation's name. Off, every conversation has one; on, only sessions do."
          on={findSessionsOnly}
          set={setFindSessionsOnly}
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
        <Toggle
          label="Preview links in messages"
          desc="Links stay clickable either way. With this on, LanChat fetches the page itself to show its title and picture — the site sees your IP, the way it would if you opened it."
          on={linkPreviews}
          set={setLinkPreviews}
        />

        {self?.platform === 'win32' && (
          <>
            <div className="section-head">Windows</div>
            <Toggle
              label="Start LanChat when Windows starts"
              desc="Launches to the tray at login, so you're reachable without opening it each time."
              on={openAtLogin}
              set={(v) => {
                setOpenAtLogin(v);
                window.lanchat.setOpenAtLogin(v);
              }}
            />
          </>
        )}

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

// Dictation setup. Transcription runs through the FluidVoice app, which only
// ships for macOS — so on anything else this whole panel is hidden rather than
// shown as a control that could never work.
function Dictation({ value, set }) {
  const [probe, setProbe] = useState(null);
  const [checking, setChecking] = useState(false);

  if (!navigator.platform.toLowerCase().includes('mac')) return null;

  async function check() {
    setChecking(true);
    try {
      setProbe(await window.lanchat.probeDictation(value.dictationPort || null));
    } catch (err) {
      setProbe({ ok: false, detail: err.message });
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      <Toggle
        label="Dictate into the message box"
        desc="In agent and session threads, tap the microphone — or hold the push-to-talk key — to speak. FluidVoice transcribes it on this Mac and the text lands in the message box for you to read before sending."
        on={value.dictationEnabled}
        set={(v) => set((p) => ({ ...p, dictationEnabled: v }))}
      />
      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor="dictport">FluidVoice port</label>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <input
            id="dictport"
            type="number"
            min="1"
            max="65535"
            placeholder="47733"
            value={value.dictationPort}
            disabled={!value.dictationEnabled}
            onChange={(e) => {
              set((p) => ({ ...p, dictationPort: e.target.value }));
              setProbe(null);
            }}
          />
          <button className="btn" disabled={!value.dictationEnabled || checking} onClick={check}>
            {checking ? 'Checking…' : 'Check'}
          </button>
        </div>
        {probe && (
          <div className="hint" style={probe.ok ? undefined : { color: 'var(--danger)' }}>
            {probe.ok
              ? `Connected — FluidVoice${probe.version ? ` ${probe.version}` : ''}`
              : `Not reachable — ${probe.detail || 'no answer'}`}
          </div>
        )}
        {(!probe || !probe.ok) && (
          <div className="hint">
            LanChat speaks to FluidVoice over its local API, which ships switched off. To turn it
            on, quit FluidVoice and run:
            <br />
            <code>defaults write com.FluidApp.app LocalAPIEnabled -bool true</code>
            <br />
            then open it again. Leave the port at <code>47733</code> unless you changed it.
          </div>
        )}
        <div className="hint">
          That API has no password: once it is on, any program on this Mac can reach it, including
          your FluidVoice dictation history. It refuses connections from other machines.
        </div>
        <div className="hint">
          Dictation also answers the push-to-talk key above. A letter or digit is a poor choice for
          it — holding one types into the message box while you speak.
        </div>
      </div>
    </>
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
