import React, { useState } from 'react';
import Avatar from './Avatar.jsx';
import { colorFor } from '../lib/util.js';

const SWATCHES = ['#2563eb', '#7c3aed', '#db2777', '#059669', '#d97706', '#0891b2', '#dc2626', '#4f46e5'];

// First-run + edit-profile modal. `firstRun` hides the cancel button.
export default function ProfileModal({ self, firstRun, onSave, onClose }) {
  const [name, setName] = useState(self?.name || '');
  const [color, setColor] = useState(self?.avatar?.color || colorFor(self?.id || self?.name));

  function save() {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave({ displayName: trimmed, avatar: { color } });
  }

  return (
    <div className="scrim" onClick={firstRun ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{firstRun ? 'Welcome to LanChat' : 'Edit profile'}</h3>
        <p className="desc">
          {firstRun
            ? 'Pick a display name and color. This is how others on your network will see you.'
            : 'Update how you appear to peers.'}
        </p>

        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 18 }}>
          <Avatar name={name || '?'} id={self?.id} avatar={{ color }} size="lg" />
        </div>

        <div className="field">
          <label htmlFor="dn">Display name</label>
          <input
            id="dn"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Alex"
            maxLength={40}
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
        </div>

        <div className="field">
          <label>Color</label>
          <div className="avatar-picker">
            {SWATCHES.map((c) => (
              <span
                key={c}
                className={`swatch ${c === color ? 'sel' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>

        <div className="modal-actions">
          {!firstRun && (
            <button className="btn ghost" onClick={onClose}>
              Cancel
            </button>
          )}
          <button className="btn primary" onClick={save} disabled={!name.trim()}>
            {firstRun ? 'Get started' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
