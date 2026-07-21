import React, { useState } from 'react';
import ModalShell from './ModalShell.jsx';
import Avatar from './Avatar.jsx';
import { Plus } from '../lib/icons.jsx';
import { platformLabel } from '../lib/util.js';

// Add a peer, either by picking one discovery already found or by typing an
// address. Useful on locked-down networks or for connecting two machines
// directly by their Tailscale IP.
export default function AddPeerModal({ defaultPort, tailnet, peers, onAdd, onClose }) {
  const [ip, setIp] = useState('');
  const [port, setPort] = useState(String(defaultPort || 47100));

  function add() {
    const trimmed = ip.trim();
    if (!trimmed) return;
    onAdd(trimmed, Number(port) || defaultPort);
    onClose();
  }

  function pick(pickedIp, pickedPort) {
    onAdd(pickedIp, pickedPort || defaultPort);
    onClose();
  }

  return (
    <ModalShell
      title="Add a peer"
      desc={
        <>
          Pick a device found on your network, or enter an address by hand. They must be running LanChat. Find
          yours with <code>tailscale ip</code> or your system network settings.
        </>
      }
      onClose={onClose}
    >
      <DiscoveredPeers tailnet={tailnet} knownPeers={peers} defaultPort={defaultPort} onPick={pick} />

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
    </ModalShell>
  );
}

// Devices Tailscale reports that are not already connected peers. Adding one is
// a click instead of copying an IP across from another window.
function DiscoveredPeers({ tailnet, knownPeers, defaultPort, onPick }) {
  const known = new Set((knownPeers || []).map((p) => (p.address || '').split(':')[0]).filter(Boolean));
  const found = (tailnet || []).filter((t) => t.online && !known.has(t.ip));

  if (found.length === 0) return null;

  return (
    <div className="field">
      <label>Found on your network</label>
      <div className="discovered">
        {found.map((t) => (
          <button
            key={t.ip}
            type="button"
            className="discovered-row"
            onClick={() => onPick(t.ip, defaultPort)}
            title={`Add ${t.hostname} at ${t.ip}`}
          >
            <Avatar name={t.hostname} id={t.ip} size="sm" />
            <div className="meta">
              <div className="name">
                {t.hostname}
                {t.hasApp && <span className="tag">LanChat</span>}
                {t.shared && <span className="tag">shared</span>}
              </div>
              <div className="sub">
                {platformLabel(t.os)} · {t.ip}
              </div>
            </div>
            <Plus size={16} />
          </button>
        ))}
      </div>
      <div className="hint">Devices already connected are not listed.</div>
    </div>
  );
}
