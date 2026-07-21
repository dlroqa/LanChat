import React, { useState } from 'react';
import { RINGTONES, NOTIFICATIONS, Ringer, playNotification } from '../lib/sounds.js';
import { Play, Plus } from '../lib/icons.jsx';

const api = window.lanchat;

// Ringtone + notification sound pickers with instant preview, volume, and an
// optional user-supplied audio file for either category.
export default function SoundSettings({ value, onChange, soundUrl }) {
  const [customNames, setCustomNames] = useState({});

  async function pickCustom(kind) {
    const res = await api.pickSound(kind);
    if (!res) return;
    setCustomNames((n) => ({ ...n, [kind]: res.name }));
    onChange(kind === 'ringtone' ? { customRingtonePath: res.path, ringtone: 'custom' } : { customNotificationPath: res.path, notificationSound: 'custom' });
  }

  const ringCustomLabel = customNames.ringtone || baseName(value.customRingtonePath) || 'Choose a file…';
  const noteCustomLabel = customNames.notification || baseName(value.customNotificationPath) || 'Choose a file…';

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
