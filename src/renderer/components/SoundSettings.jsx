import React, { useEffect, useRef, useState } from 'react';
import { RINGTONES, NOTIFICATIONS, Ringer, playNotification } from '../lib/sounds.js';
import { Play, Plus, Stop } from '../lib/icons.jsx';
import { TRACKS, TRACK_KEYS, HAS_TRACK, DEFAULT_TRACK, trackUrl } from '../lib/agentMusicTrack.js';
import { previewTrack, PREVIEW_SECONDS } from '../lib/agentMusic.js';

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

  // Closing Settings mid-audition must not leave music playing behind it.
  useEffect(() => () => stopPreview.current?.(), []);

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
