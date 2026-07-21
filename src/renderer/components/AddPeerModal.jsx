import React, { useState } from 'react';

// Manually add a peer by IP (+ optional port). Useful on locked-down networks or
// for connecting two machines directly by their Tailscale IP.
export default function AddPeerModal({ defaultPort, onAdd, onClose }) {
  const [ip, setIp] = useState('');
  const [port, setPort] = useState(String(defaultPort || 47100));

  function add() {
    const trimmed = ip.trim();
    if (!trimmed) return;
    onAdd(trimmed, Number(port) || defaultPort);
    onClose();
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Add a peer</h3>
        <p className="desc">
          Enter another device's Tailscale or LAN IP address. They must be running LanChat. Find yours with{' '}
          <code>tailscale ip</code> or your system network settings.
        </p>

        <div className="field">
          <label htmlFor="ip">IP address</label>
          <input
            id="ip"
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            placeholder="100.x.y.z or 192.168.x.x"
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
        </div>
        <div className="field">
          <label htmlFor="port">Port</label>
          <input id="port" value={port} onChange={(e) => setPort(e.target.value)} placeholder="47100" />
          <div className="hint">Default is 47100 unless the peer changed it.</div>
        </div>

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={add} disabled={!ip.trim()}>
            Add peer
          </button>
        </div>
      </div>
    </div>
  );
}
