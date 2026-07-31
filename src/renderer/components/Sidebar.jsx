import React, { useState, useMemo } from 'react';
import Avatar from './Avatar.jsx';
import QueueBadge from './QueueBadge.jsx';
import { Settings, Plus, Search, Refresh, Users, GroupCall, Code, Sessions } from '../lib/icons.jsx';
import { platformLabel } from '../lib/util.js';

// Why a peer could not connect, in words rather than a code.
//
// Every one of these was refused identically — an attacker who simply omits the
// proof looks exactly like a build that cannot produce one, and both are turned
// away. This only chooses the sentence, and it is chosen here, in the window,
// where the far end cannot read it. That is what makes it safe to be helpful:
// the friendlier line below is the one an attacker gets, and it costs nothing.
function refusalLabel(reason) {
  switch (reason) {
    case 'older-lanchat':
      return 'Needs a newer LanChat';
    case 'key-changed':
      return 'Could not be verified';
    case 'bad-signature':
    case 'bad-hello':
    case 'id-in-use':
      return 'Could not be verified';
    case 'timed-out':
      return 'Did not respond';
    default:
      return 'Offline';
  }
}

export default function Sidebar({
  self,
  peers,
  tailnet,
  tailnetStatus,
  selectedId,
  unread,
  queued = {},
  authFailures = {},
  showAddresses,
  sessions = [],
  onSelect,
  onOpenProfile,
  onOpenDev,
  onOpenSettings,
  onNewSession,
  onAddPeer,
  onRefresh,
  onNewGroupCall,
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

  // Agents live in their own section at the top rather than among the people —
  // they are a different kind of correspondent, and anything that arrives as an
  // agent lands here without the list needing to know about it in advance.
  const agents = useMemo(() => filtered.filter((p) => p.kind === 'agent'), [filtered]);
  const people = useMemo(() => filtered.filter((p) => p.kind !== 'agent'), [filtered]);

  // Tailnet devices that are online but not running LanChat (informational).
  const noApp = useMemo(() => (tailnet || []).filter((t) => t.online && !t.hasApp), [tailnet]);

  // Sessions answer the search box too. One that kept showing every session
  // while the people below it disappeared would read as a filter that had half
  // failed.
  const shownSessions = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? sessions.filter((x) => (x.title || '').toLowerCase().includes(s)) : sessions;
  }, [sessions, q]);

  // What a session is for, in the line under its name: the agent it asks, or
  // that it has not been given one yet. The agent's name comes from the roster
  // rather than from the record, so a renamed agent is renamed here too.
  const sessionRow = (s) => {
    const agent = s.agentId ? peers.find((p) => p.id === s.agentId) : null;
    return (
      <div
        key={s.id}
        className={`peer session ${s.id === selectedId ? 'active' : ''}`}
        onClick={() => onSelect(s.id)}
      >
        <span className="session-mark" aria-hidden="true">
          <Sessions size={17} />
        </span>
        <div className="meta">
          <div className="name">
            <span className="name-text">{s.title}</span>
          </div>
          <div className="sub">
            {s.agentId ? `Session · ${agent ? agent.name : 'agent unavailable'}` : 'Session · no agent yet'}
          </div>
        </div>
        {unread[s.id] > 0 && <span className="unread-dot">{unread[s.id]}</span>}
      </div>
    );
  };

  const peerRow = (p) => (
    <div
      key={p.id}
      className={`peer ${p.id === selectedId ? 'active' : ''} ${p.online ? '' : 'offline'}`}
      onClick={() => onSelect(p.id)}
    >
      <Avatar name={p.name} id={p.id} avatar={p.avatar} online={p.online} />
      <div className="meta">
        <div className="name">
          <span className="name-text">{p.name || p.hostname || 'Unknown'}</span>
          {p.shared && (
            <span className="tag" title="Shared with you from another tailnet">
              shared
            </span>
          )}
          {p.kind === 'agent' && (
            <span className="tag" title={`Agent connected over ${p.agentKind}`}>
              agent
            </span>
          )}
          {/* Where this thread stands in the queue for a shared agent, so
              waiting your turn is visible rather than looking like the
              agent is ignoring you. */}
          <QueueBadge peer={p} />
        </div>
        <div className="sub">
          {p.kind === 'agent'
            ? // A shared agent says whose it is, so it is never mistaken for
              // one of your own: `delegate` is a peer's conversation with
              // your agent, `remote` is an agent a peer shared with you.
              p.delegate || p.remote
              ? `Agent · via ${p.viaName}`
              : p.online
                ? `Agent · ${p.agentKind}`
                : 'Agent · off'
            : p.online
              ? platformLabel(p.platform) || 'Online'
              : authFailures[p.id]
                ? refusalLabel(authFailures[p.id])
                : 'Offline'}
          {showAddresses && p.address ? ` · ${p.address.split(':')[0]}` : ''}
        </div>
      </div>
      {unread[p.id] > 0 && <span className="unread-dot">{unread[p.id]}</span>}
      {!unread[p.id] && queued[p.id] > 0 && (
        <span className="queued-dot" title={`${queued[p.id]} message(s) waiting to send`}>
          {queued[p.id]}
        </span>
      )}
    </div>
  );

  return (
    <div className="sidebar">
      <div className="me">
        <Avatar name={self?.name} id={self?.id} avatar={self?.avatar} online />
        <div className="meta">
          <div className="name">{self?.name || 'You'}</div>
          <div className="sub">{self?.hostname} · {platformLabel(self?.platform)}</div>
        </div>
      </div>

      {/* The things you do to this machine rather than to a conversation, on
          their own line under the name. They used to share the row with it,
          which left three targets crowded against the edge and no room for a
          fourth. */}
      <div className="me-actions">
        <button className="icon-btn" onClick={onOpenProfile} title="Edit profile" aria-label="Edit profile">
          <Users size={18} />
        </button>
        <button className="icon-btn" onClick={onOpenDev} title="Developer" aria-label="Developer">
          <Code size={18} />
        </button>
        <button className="icon-btn" onClick={onOpenSettings} title="Settings" aria-label="Settings">
          <Settings size={18} />
        </button>
        <button className="icon-btn" onClick={onNewSession} title="New session" aria-label="New session">
          <Sessions size={18} />
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

      <div className="peer-list">
        {/* Work in progress before correspondents: a session is something you
            are in the middle of, and the button that starts one is directly
            above. Like the agents below, the heading only exists when there is
            something under it. */}
        {shownSessions.length > 0 && (
          <>
            <div className="section-label">
              <span>Sessions</span>
            </div>
            {shownSessions.map(sessionRow)}
          </>
        )}

        {/* Agents first, so the panel opens on them. The section only exists
            when there is an agent to put in it — an empty heading would read
            as something missing. */}
        {agents.length > 0 && (
          <>
            <div className="section-label">
              <span>Agents</span>
            </div>
            {agents.map(peerRow)}
          </>
        )}

        <div className="section-label">
          <span>People</span>
          <span style={{ display: 'flex', gap: 2 }}>
            <button
              className="icon-btn"
              style={{ width: 26, height: 26 }}
              onClick={onNewGroupCall}
              title="Start a group call"
            >
              <GroupCall size={16} />
            </button>
            <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={onRefresh} title="Refresh">
              <Refresh size={15} />
            </button>
            <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={onAddPeer} title="Add peer by IP">
              <Plus size={16} />
            </button>
          </span>
        </div>

        {people.length === 0 && (
          <div className="empty-hint">
            No LanChat users found yet. People on your Tailscale network or LAN who run LanChat show up here
            automatically. You can also add one by IP with the + button.
          </div>
        )}
        {people.map(peerRow)}

        {/* An empty tailnet list is ambiguous on its own — say which of "no
            CLI", "signed out" or "nothing there" it actually is. */}
        {tailnetStatus && tailnetStatus.ok === false && (
          <>
            <div className="section-label" style={{ marginTop: 6 }}>
              On your tailnet
            </div>
            <div className="hint" style={{ padding: '0 4px 8px' }}>
              {tailnetStatus.reason === 'not-installed'
                ? 'The Tailscale command-line tool was not found, so tailnet peers cannot be listed. Peers on your local network still appear above.'
                : 'Tailscale is not responding — check that it is running and signed in.'}
            </div>
          </>
        )}

        {noApp.length > 0 && (
          <>
            <div className="section-label" style={{ marginTop: 6 }}>
              On your tailnet
            </div>
            {noApp.map((t) => (
              <div key={t.ip} className="peer offline" title="Online on Tailscale but not running LanChat">
                <Avatar name={t.hostname} id={t.ip} />
                <div className="meta">
                  <div className="name"><span className="name-text">{t.hostname}</span></div>
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
