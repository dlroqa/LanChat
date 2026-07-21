import React, { useState } from 'react';
import ModalShell from './ModalShell.jsx';
import Avatar from './Avatar.jsx';
import { colorFor } from '../lib/util.js';
import { downscaleToAvatar } from '../lib/image.js';
import { Plus, X } from '../lib/icons.jsx';

const api = window.lanchat;

const SWATCHES = ['#2563eb', '#7c3aed', '#db2777', '#059669', '#d97706', '#0891b2', '#dc2626', '#4f46e5'];

// First-run + edit-profile modal. `firstRun` hides the cancel button.
export default function ProfileModal({ self, firstRun, onSave, onClose }) {
  const [name, setName] = useState(self?.name || '');
  const [color, setColor] = useState(self?.avatar?.color || colorFor(self?.id || self?.name));
  const [image, setImage] = useState(self?.avatar?.image || null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  function save() {
    const trimmed = name.trim();
    if (!trimmed) return;
    // Colour is kept alongside the photo so removing the picture restores it.
    onSave({ displayName: trimmed, avatar: { color, image } });
  }

  async function choosePhoto() {
    setError(null);
    setBusy(true);
    try {
      const picked = await api.pickAvatar();
      if (picked) setImage(await downscaleToAvatar(picked.dataUrl));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell
      title={firstRun ? 'Welcome to LanChat' : 'Edit profile'}
      desc={
        firstRun
          ? 'Pick a display name and color. This is how others on your network will see you.'
          : 'Update how you appear to peers.'
      }
      onClose={firstRun ? null : onClose}
    >

        <div className="avatar-edit">
          <Avatar name={name || '?'} id={self?.id} avatar={{ color, image }} size="lg" />
          <div className="avatar-edit-actions">
            <button className="btn" onClick={choosePhoto} disabled={busy}>
              <Plus size={15} /> {busy ? 'Loading…' : image ? 'Change photo' : 'Upload photo'}
            </button>
            {image && (
              <button className="btn ghost" onClick={() => setImage(null)} title="Remove photo">
                <X size={15} /> Remove
              </button>
            )}
          </div>
          {error && <div className="hint" style={{ color: 'var(--danger)' }}>{error}</div>}
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
          <label>{image ? 'Color (used if you remove the photo)' : 'Color'}</label>
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
    </ModalShell>
  );
}
