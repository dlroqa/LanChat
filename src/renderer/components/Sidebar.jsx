import React, { useState, useMemo } from 'react';
import Avatar from './Avatar.jsx';
import { Settings, Plus, Search, Refresh, Users } from '../lib/icons.jsx';
import { platformLabel } from '../lib/util.js';

export default function Sidebar({
  self,
  peers,
  tailnet,
  selectedId,
  unread,
  showAddresses,
  onSelect,
  onOpenProfile,
  onOpenSettings,
  onAddPeer,
  onRefresh,
}) {
  const [q, setQ] = useState('');

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = [...peers].sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return (a.name || '').localeCompare(b.name || '');
    });
    if (!s) return list;
    return list.filter((p) => (p.name || '').toLowerCase().includes(s) || (p.hostname || '').toLowerCase().includes(s));
  }, [peers, q]);

  // Tailnet devices that are online but not running LanChat (informational).
  const noApp = useMemo(() => (tailnet || []).filter((t) => t.online && !t.hasApp), [tailnet]);

  return (
    <div className="sidebar">
      <div className="me">
        <Avatar name={self?.name} id={self?.id} avatar={self?.avatar} online />
        <div className="meta">
          <div className="name">{self?.name || 'You'}</div>
          <div className="sub">{self?.hostname} · {platformLabel(self?.platform)}</div>
        </div>
        <button className="icon-btn" onClick={onOpenProfile} title="Edit profile">
          <Users size={18} />
        </button>
        <button className="icon-btn" onClick={onOpenSettings} title="Settings">
          <Settings size={18} />
        </button>
      </div>

      <div className="sidebar-search">
        <div style={{ position: 'relative' }}>
          <span style={{ position: 'absolute', left: 10, top: 9, color: 'var(--fg-faint)' }}>
            <Search size={16} />
          </span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search people"
            style={{ paddingLeft: 32 }}
            aria-label="Search people"
          />
        </div>
      </div>

      <div className="section-label">
        <span>People</span>
        <span style={{ display: 'flex', gap: 2 }}>
          <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={onRefresh} title="Refresh">
            <Refresh size={15} />
          </button>
          <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={onAddPeer} title="Add peer by IP">
            <Plus size={16} />
          </button>
        </span>
      </div>

      <div className="peer-list">
        {filtered.length === 0 && (
          <div className="empty-hint">
            No LanChat users found yet. People on your Tailscale network or LAN who run LanChat show up here
            automatically. You can also add one by IP with the + button.
          </div>
        )}
        {filtered.map((p) => (
          <div
            key={p.id}
            className={`peer ${p.id === selectedId ? 'active' : ''} ${p.online ? '' : 'offline'}`}
            onClick={() => onSelect(p.id)}
          >
            <Avatar name={p.name} id={p.id} avatar={p.avatar} online={p.online} />
            <div className="meta">
              <div className="name">
                {p.name || p.hostname || 'Unknown'}
                {p.shared && (
                  <span className="tag" title="Shared with you from another tailnet">
                    shared
                  </span>
                )}
              </div>
              <div className="sub">
                {p.online ? platformLabel(p.platform) || 'Online' : 'Offline'}
                {showAddresses && p.address ? ` · ${p.address.split(':')[0]}` : ''}
              </div>
            </div>
            {unread[p.id] > 0 && <span className="unread-dot">{unread[p.id]}</span>}
          </div>
        ))}

        {noApp.length > 0 && (
          <>
            <div className="section-label" style={{ marginTop: 6 }}>
              On your tailnet
            </div>
            {noApp.map((t) => (
              <div key={t.ip} className="peer offline" title="Online on Tailscale but not running LanChat">
                <Avatar name={t.hostname} id={t.ip} />
                <div className="meta">
                  <div className="name">{t.hostname}</div>
                  <div className="sub">{platformLabel(t.os)} · app not running</div>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
