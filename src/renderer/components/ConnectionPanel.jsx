import React, { useMemo } from 'react';
import Avatar from './Avatar.jsx';

// Live connection quality for the selected peer, drawn from real round-trip
// measurements taken over the peer WebSocket (see src/main/linkStats.js) — the
// animation reflects actual latency rather than being decorative.

const QUALITY = {
  excellent: { label: 'Excellent', color: 'var(--online)', bars: 4 },
  good: { label: 'Good', color: 'var(--online)', bars: 3 },
  fair: { label: 'Fair', color: 'var(--warn)', bars: 2 },
  poor: { label: 'Poor', color: 'var(--danger)', bars: 1 },
  offline: { label: 'Offline', color: 'var(--fg-faint)', bars: 0 },
};

export default function ConnectionPanel({ peer, stats }) {
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

function Stat({ label, value }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
