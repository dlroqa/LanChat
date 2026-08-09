import React, { useEffect, useRef, useState } from 'react';
import { RINGTONES, NOTIFICATIONS, Ringer, playNotification } from '../lib/sounds.js';
import { Play, Plus, Stop } from '../lib/icons.jsx';
import { TRACKS, TRACK_KEYS, HAS_TRACK, DEFAULT_TRACK, trackUrl } from '../lib/agentMusicTrack.js';
import { previewTrack, PREVIEW_SECONDS } from '../lib/agentMusic.js';
import { previewVoice } from '../lib/agentSpeech.js';
import { VOICES } from '../lib/agentVoice.js';

const api = window.lanchat;

// What each kind of custom file is remembered as, and what picking one switches
// the matching dropdown to. Mirrors SOUND_KINDS in main/ipc.js, which is what
// actually writes the path.
const CUSTOM_PATCH = {
  ringtone: (path) => ({ customRingtonePath: path, ringtone: 'custom' }),
  notification: (path) => ({ customNotificationPath: path, notificationSound: 'custom' }),
  agentMusic: (path) => ({ customAgentMusicPath: path, agentMusic: 'custom' }),
};

// Ringtone, notification and agent-music pickers with instant preview, volume,
// and an optional user-supplied audio file for each.
export default function SoundSettings({ value, onChange, soundUrl }) {
  const [customNames, setCustomNames] = useState({});
  const [previewing, setPreviewing] = useState(false);
  // The running audition's stop function. A ref rather than state because the
  // unmount cleanup below must see the current one, not the one from the render
  // that registered it.
  const stopPreview = useRef(null);

  async function pickCustom(kind) {
    const res = await api.pickSound(kind);
    if (!res) return;
    setCustomNames((n) => ({ ...n, [kind]: res.name }));
    onChange(CUSTOM_PATCH[kind](res.path));
  }

  const ringCustomLabel = customNames.ringtone || baseName(value.customRingtonePath) || 'Choose a file…';
  const noteCustomLabel =
    customNames.notification || baseName(value.customNotificationPath) || 'Choose a file…';
  const musicCustomLabel = customNames.agentMusic || baseName(value.customAgentMusicPath) || 'Choose a file…';

  // Saved as null until the user picks, so an install that gains its first
  // bundled track starts playing it rather than nothing.
  const musicChoice = value.agentMusic || DEFAULT_TRACK || 'custom';
  const musicUrl = trackUrl(musicChoice, soundUrl(value.customAgentMusicPath));

  function endPreview() {
    stopPreview.current?.();
    stopPreview.current = null;
    setPreviewing(false);
  }

  function togglePreview() {
    if (previewing) return endPreview();
    if (!musicUrl) return;
    stopPreview.current = previewTrack(musicUrl, value.agentMusicVolume ?? 0.5);
    setPreviewing(true);
    // It fades itself out on its own schedule, so put the button back in step.
    window.setTimeout(() => setPreviewing(false), PREVIEW_SECONDS * 1000);
  }

  // ---- reading discussions aloud ----
  //
  // The engine and the key do not travel on `onChange` with everything else on
  // this panel. They have channels of their own in main, because between them
  // they decide whether the agents' words leave this machine, and a switch like
  // that must never move as a side effect of saving a volume slider. So this
  // section keeps its own small piece of state and talks to main directly.
  // Applied immediately rather than batched into Save, exactly as SettingsModal
  // does for acceptLan: a switch that decides where words go should not sit in a
  // draft state where the panel shows one thing and main is doing another.
  //
  // Seeded from main rather than from the window's copy of the config, and that
  // is a fix rather than a preference. Because this setting travels on its own
  // channel, App's config is not refreshed when it changes — so a panel seeded
  // from that copy showed "This computer's voices" again the next time it was
  // opened, while main had been on Gemini all along. It read exactly like the
  // setting not having taken. Asking main, which is the authority, leaves
  // nothing to fall out of step.
  const [engine, setEngineState] = useState('local');
  const [hasKey, setHasKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [keyError, setKeyError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [auditioning, setAuditioning] = useState(false);
  const stopVoice = useRef(null);

  // Which engine is really on, and whether a key is stored — never the key
  // itself, which main does not hand back to any window.
  useEffect(() => {
    let live = true;
    api.speechStatus?.().then((s) => {
      if (!live || !s) return;
      setEngineState(s.engine === 'gemini' ? 'gemini' : 'local');
      setHasKey(Boolean(s.hasKey));
    });
    return () => {
      live = false;
    };
  }, []);

  async function setEngine(next) {
    setBusy(true);
    setKeyError(null);
    try {
      const res = await api.setSpeechEngine(next);
      if (res?.speech) setHasKey(Boolean(res.speech.hasKey));
      // Main is the authority here, so the panel shows what it settled on rather
      // than what was asked for: it refuses anything that is not 'gemini'.
      setEngineState(res?.agentSpeechEngine === 'gemini' ? 'gemini' : 'local');
    } finally {
      setBusy(false);
    }
  }

  async function saveKey() {
    setBusy(true);
    setKeyError(null);
    try {
      const res = await api.setSpeechKey(keyDraft);
      if (!res?.ok) {
        setKeyError(res?.error || 'The key could not be saved.');
        return;
      }
      setHasKey(Boolean(res.speech?.hasKey));
      // Never left in the box: it is saved, and a key sitting in a form is a key
      // waiting to be read over somebody's shoulder.
      setKeyDraft('');
    } finally {
      setBusy(false);
    }
  }

  async function forgetKey() {
    setBusy(true);
    setKeyError(null);
    try {
      const res = await api.setSpeechKey('');
      setHasKey(Boolean(res?.speech?.hasKey));
      setKeyDraft('');
    } finally {
      setBusy(false);
    }
  }

  function endVoicePreview() {
    stopVoice.current?.();
    stopVoice.current = null;
    setAuditioning(false);
  }

  function toggleVoicePreview() {
    if (auditioning) return endVoicePreview();
    stopVoice.current = previewVoice({
      voice: VOICES[0],
      volume: value.agentSpeechVolume ?? 0.9,
      // The audition takes the same route a real turn does, so a key that does
      // not work is found out here rather than in the middle of a discussion.
      synthesize: async (text, voice) => {
        const res = await api.speak(text, voice);
        return res?.ok ? soundUrl(res.path) : null;
      },
    });
    setAuditioning(true);
  }

  // Closing Settings mid-audition must not leave music — or a voice — playing
  // behind it.
  useEffect(() => () => stopPreview.current?.(), []);
  useEffect(() => () => stopVoice.current?.(), []);

  // Switching the engine, or turning the whole thing off, ends whatever voice is
  // mid-sentence rather than letting it finish in the old one.
  useEffect(() => {
    if (auditioning) endVoicePreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, value.agentSpeechEnabled]);

  // Changing the track, or switching the whole thing off, ends the audition of
  // whatever was playing rather than leaving two pieces of music running.
  useEffect(() => {
    if (previewing) endPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [musicUrl, value.agentMusicEnabled]);

  return (
    <div>
      {/* ---- incoming call ---- */}
      <div className="field">
        <label htmlFor="ringtone">Ringtone</label>
        <div className="row">
          <select
            id="ringtone"
            value={value.ringtone || 'classic'}
            onChange={(e) => onChange({ ringtone: e.target.value })}
            style={{ flex: 1 }}
          >
            {Object.entries(RINGTONES).map(([key, def]) => (
              <option key={key} value={key}>
                {def.label}
              </option>
            ))}
            <option value="custom">Custom file…</option>
          </select>
          <button
            className="btn"
            title="Preview ringtone"
            onClick={() =>
              Ringer.preview(value.ringtone || 'classic', {
                volume: value.ringtoneVolume ?? 0.8,
                customUrl: soundUrl(value.customRingtonePath),
              })
            }
          >
            <Play size={15} />
          </button>
        </div>
        {value.ringtone === 'custom' && (
          <button className="btn ghost file-pick" onClick={() => pickCustom('ringtone')}>
            <Plus size={15} /> {ringCustomLabel}
          </button>
        )}
      </div>

      <Volume
        label="Ringtone volume"
        value={value.ringtoneVolume ?? 0.8}
        onChange={(v) => onChange({ ringtoneVolume: v })}
      />

      {/* ---- messages ---- */}
      <div className="field" style={{ marginTop: 18 }}>
        <label htmlFor="notif">Message sound</label>
        <div className="row">
          <select
            id="notif"
            value={value.notificationSound || 'ping'}
            onChange={(e) => onChange({ notificationSound: e.target.value })}
            style={{ flex: 1 }}
            disabled={value.muteNotifications}
          >
            {Object.entries(NOTIFICATIONS).map(([key, def]) => (
              <option key={key} value={key}>
                {def.label}
              </option>
            ))}
            <option value="custom">Custom file…</option>
          </select>
          <button
            className="btn"
            title="Preview message sound"
            disabled={value.muteNotifications}
            onClick={() =>
              playNotification(value.notificationSound || 'ping', {
                volume: value.notificationVolume ?? 0.7,
                customUrl: soundUrl(value.customNotificationPath),
              })
            }
          >
            <Play size={15} />
          </button>
        </div>
        {value.notificationSound === 'custom' && (
          <button className="btn ghost file-pick" onClick={() => pickCustom('notification')}>
            <Plus size={15} /> {noteCustomLabel}
          </button>
        )}
      </div>

      <Volume
        label="Message volume"
        value={value.notificationVolume ?? 0.7}
        onChange={(v) => onChange({ notificationVolume: v })}
        disabled={value.muteNotifications}
      />

      <div className="switch">
        <div>
          <div style={{ fontWeight: 500 }}>Mute message sounds</div>
          <div style={{ fontSize: 12, color: 'var(--fg-faint)' }}>Calls still ring.</div>
        </div>
        <button
          className={`toggle ${value.muteNotifications ? 'on' : ''}`}
          onClick={() => onChange({ muteNotifications: !value.muteNotifications })}
          aria-pressed={Boolean(value.muteNotifications)}
          aria-label="Mute message sounds"
        />
      </div>

      {/* ---- agents ---- */}
      <div className="switch" style={{ marginTop: 18 }}>
        <div>
          <div style={{ fontWeight: 500 }}>Music while an agent works</div>
          <div style={{ fontSize: 12, color: 'var(--fg-faint)' }}>
            Fades in when an agent starts and out when it finishes. Separate from message sounds.
          </div>
        </div>
        <button
          className={`toggle ${value.agentMusicEnabled ? 'on' : ''}`}
          onClick={() => onChange({ agentMusicEnabled: !value.agentMusicEnabled })}
          aria-pressed={Boolean(value.agentMusicEnabled)}
          aria-label="Music while an agent works"
        />
      </div>

      <div className="field">
        <label htmlFor="agent-music">Music</label>
        <div className="row">
          <select
            id="agent-music"
            value={musicChoice}
            onChange={(e) => onChange({ agentMusic: e.target.value })}
            style={{ flex: 1 }}
            disabled={!value.agentMusicEnabled}
          >
            {TRACK_KEYS.map((key) => (
              <option key={key} value={key}>
                {TRACKS[key].label}
              </option>
            ))}
            {!HAS_TRACK && (
              <option value="" disabled>
                No music bundled in this build
              </option>
            )}
            <option value="custom">Custom file…</option>
          </select>
          <button
            className="btn"
            title={previewing ? 'Stop' : `Preview — plays for ${PREVIEW_SECONDS} seconds`}
            disabled={!value.agentMusicEnabled || !musicUrl}
            onClick={togglePreview}
          >
            {previewing ? <Stop size={15} /> : <Play size={15} />}
          </button>
        </div>
        {musicChoice === 'custom' && (
          <button
            className="btn ghost file-pick"
            onClick={() => pickCustom('agentMusic')}
            disabled={!value.agentMusicEnabled}
          >
            <Plus size={15} /> {musicCustomLabel}
          </button>
        )}
        {musicChoice === 'custom' && (
          <div style={{ fontSize: 12, color: 'var(--fg-faint)', marginTop: 6 }}>
            Ogg Vorbis or Opus. Both stay small over a long loop, and both repeat without a seam.
          </div>
        )}
      </div>

      <Volume
        label="Agent music volume"
        value={value.agentMusicVolume ?? 0.5}
        onChange={(v) => onChange({ agentMusicVolume: v })}
        disabled={!value.agentMusicEnabled}
      />

      {/* ---- reading discussions aloud ---- */}
      <div className="switch" style={{ marginTop: 18 }}>
        <div>
          <div style={{ fontWeight: 500 }}>Read discussions aloud</div>
          <div style={{ fontSize: 12, color: 'var(--fg-faint)' }}>
            In a session set to Discussion, each agent&rsquo;s turn is spoken as it arrives, in a voice of its
            own.
          </div>
        </div>
        <button
          className={`toggle ${value.agentSpeechEnabled ? 'on' : ''}`}
          onClick={() => onChange({ agentSpeechEnabled: !value.agentSpeechEnabled })}
          aria-pressed={Boolean(value.agentSpeechEnabled)}
          aria-label="Read discussions aloud"
        />
      </div>

      <div className="field">
        <label htmlFor="speech-engine">Voice</label>
        <div className="row">
          <select
            id="speech-engine"
            value={engine}
            onChange={(e) => setEngine(e.target.value)}
            style={{ flex: 1 }}
            disabled={!value.agentSpeechEnabled || busy}
          >
            <option value="local">This computer&rsquo;s voices</option>
            <option value="gemini">Gemini — natural voices, needs a key</option>
          </select>
          <button
            className="btn"
            title={auditioning ? 'Stop' : 'Hear a voice'}
            disabled={!value.agentSpeechEnabled}
            onClick={toggleVoicePreview}
          >
            {auditioning ? <Stop size={15} /> : <Play size={15} />}
          </button>
        </div>
        {engine === 'local' && (
          <div style={{ fontSize: 12, color: 'var(--fg-faint)', marginTop: 6 }}>
            Whatever voices this computer already has. Nothing is sent anywhere.
          </div>
        )}
      </div>

      {engine === 'gemini' && (
        <div className="field">
          <label htmlFor="speech-key">Gemini API key</label>
          <div className="row">
            <input
              id="speech-key"
              type="password"
              placeholder={hasKey ? 'A key is saved' : 'Paste your key'}
              value={keyDraft}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setKeyDraft(e.target.value)}
              style={{ flex: 1 }}
              disabled={!value.agentSpeechEnabled || busy}
            />
            <button
              className="btn"
              disabled={!value.agentSpeechEnabled || busy || !keyDraft.trim()}
              onClick={saveKey}
            >
              Save
            </button>
            {hasKey && (
              <button className="btn ghost" disabled={!value.agentSpeechEnabled || busy} onClick={forgetKey}>
                Forget
              </button>
            )}
          </div>
          {/* The one sentence that has to be here. LanChat has no central server
              and this is the setting that changes that, so it says where the
              words go, in words, next to the switch that sends them. */}
          <div style={{ fontSize: 12, color: 'var(--fg-faint)', marginTop: 6 }}>
            The agents&rsquo; replies in a discussion are sent to Google to be read. Nothing else is, and
            nothing at all is while this is set to your computer&rsquo;s voices.
          </div>
          {keyError && <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 6 }}>{keyError}</div>}
        </div>
      )}

      <Volume
        label="Speech volume"
        value={value.agentSpeechVolume ?? 0.9}
        onChange={(v) => onChange({ agentSpeechVolume: v })}
        disabled={!value.agentSpeechEnabled}
      />
    </div>
  );
}

function Volume({ label, value, onChange, disabled }) {
  return (
    <div className="field volume-field">
      <label htmlFor={label}>
        {label} <span className="volume-pct">{Math.round(value * 100)}%</span>
      </label>
      <input
        id={label}
        type="range"
        min="0"
        max="1"
        step="0.05"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function baseName(p) {
  if (!p) return null;
  return p.split(/[\\/]/).pop();
}
