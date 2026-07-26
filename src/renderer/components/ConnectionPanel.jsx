import React, { useEffect, useMemo, useState } from 'react';
import Avatar from './Avatar.jsx';
import { useCountdown } from '../lib/useCountdown.js';
import { useAgentPhrase } from '../lib/agentPhrase.js';
import { turnStanding, turnStandingLabel } from '../lib/turnStanding.js';

// Live connection quality for the selected peer, drawn from real round-trip
// measurements taken over the peer WebSocket (see src/main/linkStats.js) — the
// animation reflects actual latency rather than being decorative.
//
// Agents get a different panel entirely. There is no network path to an agent to
// measure — a local one rides a virtual socket, and a shared one is reached
// through its owner — so latency, jitter and packet loss are meaningless for it.
// What matters instead is what the agent is doing and whose turn it is.

const QUALITY = {
  excellent: { label: 'Excellent', color: 'var(--online)', bars: 4 },
  good: { label: 'Good', color: 'var(--online)', bars: 3 },
  fair: { label: 'Fair', color: 'var(--warn)', bars: 2 },
  poor: { label: 'Poor', color: 'var(--danger)', bars: 1 },
  offline: { label: 'Offline', color: 'var(--fg-faint)', bars: 0 },
};

export default function ConnectionPanel({ peer, stats, agentStatus, awaiting }) {
  if (!peer) {
    return (
      <div className="panel-empty">
        <div className="pulse-ring" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <h4>No conversation selected</h4>
        <p>Pick someone on the left to see their connection and start a call.</p>
      </div>
    );
  }

  if (peer.kind === 'agent') return <AgentPanel peer={peer} status={agentStatus} awaiting={awaiting} />;

  const q = QUALITY[stats?.quality || (peer.online ? 'good' : 'offline')];
  const samples = stats?.samples || [];

  return (
    <div className="conn-panel">
      <div className="conn-head">
        <Avatar name={peer.name} id={peer.id} avatar={peer.avatar} online={peer.online} />
        <div style={{ minWidth: 0 }}>
          <div className="conn-name">{peer.name || peer.hostname}</div>
          <div className="conn-sub" style={{ color: q.color }}>
            {/* Text label as well as colour, so quality never depends on colour alone. */}
            <SignalBars bars={q.bars} color={q.color} /> {q.label}
          </div>
        </div>
      </div>

      <StreamGraph samples={samples} color={q.color} live={peer.online} />

      <div className="conn-stats">
        <Stat label="Latency" value={stats?.rtt != null ? `${stats.rtt} ms` : '—'} />
        <Stat label="Average" value={stats?.avg != null ? `${stats.avg} ms` : '—'} />
        <Stat label="Loss" value={stats ? `${Math.round((stats.loss || 0) * 100)}%` : '—'} />
      </div>

      <div className="conn-note">
        {peer.online
          ? 'Measured peer-to-peer over your LAN or Tailscale mesh. Start a video call and it plays here.'
          : 'This peer is offline. They will appear here when LanChat is running on their device.'}
      </div>
    </div>
  );
}

function AgentPanel({ peer, status, awaiting }) {
  // Three sources, all of them real: the bus for an agent hosted here, the
  // owner's relay for a shared one, and simply having asked and not yet heard
  // back. The last is what keeps the panel honest when a relay frame is slow or
  // the agent belongs to somebody else.
  const busy = status?.status === 'working' || peer.agentBusy === true || awaiting === true;
  const detail = status?.detail || peer.agentDetail || null;
  const errored = status?.status === 'error';

  // Shared with the chat indicator, and derived from the clock, so both show the
  // same word at the same moment rather than drifting apart.
  const phrase = useAgentPhrase(busy && !detail);

  const counting = peer.queueExpiring === true && peer.queueExpiresInSec > 0;
  const secondsLeft = useCountdown(peer.queueExpiresInSec, counting);

  let state = { label: 'Ready', tone: 'ready' };
  if (!peer.online) state = { label: peer.delegate ? 'Transcript' : 'Not connected', tone: 'off' };
  else if (errored) state = { label: 'Something went wrong', tone: 'error' };
  else if (busy) state = { label: detail || phrase, tone: 'busy' };

  // One derivation feeds both boxes below, so the word in Status and the tint on
  // Turn can never disagree about which of them is true.
  const standing = turnStanding(peer, secondsLeft);

  return (
    <div className="conn-panel">
      <div className="conn-head">
        <Avatar name={peer.name} id={peer.id} avatar={peer.avatar} online={peer.online} />
        <div style={{ minWidth: 0 }}>
          <div className="conn-name">{peer.name}</div>
          <div className={`conn-sub agent-tone-${state.tone}`}>
            {peer.delegate ? `${peer.viaName}'s conversation` : peer.remote ? `Shared by ${peer.viaName}` : 'Your agent'}
          </div>
        </div>
      </div>

      {/* Where a human peer gets a latency graph, an agent says what it is
          doing. Same slot, information that actually applies. */}
      <div className={`agent-state agent-tone-${state.tone}`}>
        <span className="agent-state-orb" aria-hidden="true" />
        <span className="agent-state-label" key={state.label}>
          {state.label}
          {state.tone === 'busy' && (
            <span className="agent-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          )}
        </span>
      </div>

      {/* Status says where this thread stands in the queue whenever it stands
          anywhere at all — waiting behind someone, about to be handed the turn,
          holding it, or about to lose it. What the agent is *doing* is already
          spelled out in full in the row above, so the box is free to answer the
          question the box next to it raises. */}
      <div className="conn-stats">
        <Stat label="Status" value={standing?.word ?? (state.tone === 'busy' ? 'Working' : state.label)} />
        <Stat
          label="Turn"
          value={standing ? standing.text : '—'}
          tone={standing?.key}
          title={turnStandingLabel(peer, secondsLeft)}
        />
        <Stat label="Via" value={peer.remote || peer.delegate ? peer.viaName : peer.agentKind} />
      </div>

      <div className="conn-note">
        {peer.delegate
          ? `A record of what ${peer.viaName} has asked this agent. Reply to it from your own thread with the agent.`
          : peer.remote
            ? `Reached through ${peer.viaName}, who approves anything it wants to run. Everyone sharing it takes turns.`
            : 'Runs on this machine. You approve every tool call it wants to make — that is never handed to a peer.'}
      </div>
    </div>
  );
}

// Area sparkline of recent round-trip times. Gaps (dropped pings) break the line
// rather than being interpolated, so packet loss is visible.
function StreamGraph({ samples, color, live }) {
  const W = 300;
  const H = 90;

  const { path, area, ticks } = useMemo(() => {
    const pts = samples.slice(-40);
    if (pts.length < 2) return { path: '', area: '', ticks: [] };
    const valid = pts.filter((p) => p != null);
    const max = Math.max(40, ...valid) * 1.25;
    const step = W / (pts.length - 1);
    let d = '';
    let started = false;
    const coords = [];
    pts.forEach((v, i) => {
      if (v == null) {
        started = false;
        return;
      }
      const x = i * step;
      const y = H - (Math.min(v, max) / max) * H;
      coords.push([x, y]);
      d += `${started ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `;
      started = true;
    });
    const a =
      coords.length > 1
        ? `M${coords[0][0].toFixed(1)},${H} ` +
          coords.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join(' ') +
          ` L${coords[coords.length - 1][0].toFixed(1)},${H} Z`
        : '';
    return { path: d.trim(), area: a, ticks: [0.25, 0.5, 0.75] };
  }, [samples]);

  return (
    <div className="stream-graph">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Connection latency over time">
        {ticks.map((t) => (
          <line key={t} x1="0" x2={W} y1={H * t} y2={H * t} className="graph-grid" />
        ))}
        {area && <path d={area} fill={color} opacity="0.12" />}
        {path && <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />}
        {!path && (
          <text x={W / 2} y={H / 2} textAnchor="middle" className="graph-empty">
            measuring…
          </text>
        )}
      </svg>
      {live && <span className="graph-live" style={{ background: color }} aria-hidden="true" />}
    </div>
  );
}

function SignalBars({ bars, color }) {
  return (
    <span className="bars" aria-hidden="true">
      {[1, 2, 3, 4].map((i) => (
        <span key={i} style={{ height: 3 + i * 2.5, background: i <= bars ? color : 'var(--surface-2)' }} />
      ))}
    </span>
  );
}

// `tone` tints the box for a state worth spotting without reading it. Left off,
// the stat looks exactly as it always has — which is how the latency stats above
// stay untouched.
function Stat({ label, value, tone, title }) {
  return (
    <div className={tone ? `stat stat-turn stat-turn-${tone}` : 'stat'} title={title || undefined}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
