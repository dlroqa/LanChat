import React, { useState } from 'react';
import Avatar from './Avatar.jsx';
import { platformLabel } from '../lib/util.js';

const MAX_PARTICIPANTS = 5; // mesh scale: keep small for a personal LAN tool

// Pick online people and start a group call. Video is on by default; a toggle
// makes it audio-only.
export default function NewGroupCallModal({ peers, onStart, onClose }) {
  const online = peers.filter((p) => p.online);
  const [selected, setSelected] = useState(new Set());
  const [withVideo, setWithVideo] = useState(true);

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_PARTICIPANTS) next.add(id);
      return next;
    });
  }

  function start() {
    const chosen = online.filter((p) => selected.has(p.id));
    if (!chosen.length) return;
    onStart(chosen, withVideo);
    onClose();
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>New group call</h3>
        <p className="desc">
          Choose who to invite. Everyone connects directly to everyone else, so keep groups small —
          up to {MAX_PARTICIPANTS} others works well on a LAN or tailnet.
        </p>

        <div className="switch">
          <div>
            <div style={{ fontWeight: 500 }}>Video</div>
            <div style={{ fontSize: 12, color: 'var(--fg-faint)' }}>Off makes it an audio-only group call.</div>
          </div>
          <button
            className={`toggle ${withVideo ? 'on' : ''}`}
            onClick={() => setWithVideo((v) => !v)}
            aria-pressed={withVideo}
            aria-label="Video"
          />
        </div>

        <div className="gc-picker">
          {online.length === 0 && <div className="empty-hint">No one is online right now.</div>}
          {online.map((p) => {
            const on = selected.has(p.id);
            const full = !on && selected.size >= MAX_PARTICIPANTS;
            return (
              <label key={p.id} className={`gc-pick ${on ? 'sel' : ''} ${full ? 'disabled' : ''}`}>
                <input type="checkbox" checked={on} disabled={full} onChange={() => toggle(p.id)} />
                <Avatar name={p.name} id={p.id} avatar={p.avatar} online />
                <div className="meta">
                  <div className="name">{p.name || p.hostname}</div>
                  <div className="sub">{platformLabel(p.platform)}</div>
                </div>
              </label>
            );
          })}
        </div>

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={start} disabled={selected.size === 0}>
            Start call{selected.size ? ` (${selected.size})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
