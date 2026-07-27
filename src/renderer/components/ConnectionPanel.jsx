import React, { useEffect, useMemo, useState } from 'react';
import Avatar from './Avatar.jsx';
import { useCountdown } from '../lib/useCountdown.js';
import { useAgentPhrase } from '../lib/agentPhrase.js';
import { turnStanding, turnStandingLabel } from '../lib/turnStanding.js';
import { useSweep, useBurstHue, useReadyBurst, useReducedMotion, rayReach } from '../lib/statusMotion.js';

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
  // The two below are reported by Windows only (see src/main/linkStats.js);
  // macOS and Linux never produce them, so the panel reads there exactly as it
  // always has.
  //
  // Connected, nothing measured yet — said plainly rather than borrowing a band
  // the link has not earned.
  measuring: { label: 'Measuring…', color: 'var(--fg-faint)', bars: 0 },
  // The socket is open but the round trips are going nowhere. "Offline" would be
  // wrong (the peer is right there in the roster) and a quality band would be a
  // guess, so the panel says the one thing that is true.
  unreachable: { label: 'Not responding', color: 'var(--warn)', bars: 0 },
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

  const q = QUALITY[stats?.quality || (peer.online ? 'good' : 'offline')] || QUALITY.offline;
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
        {!peer.online
          ? 'This peer is offline. They will appear here when LanChat is running on their device.'
          : stats?.quality === 'unreachable'
            ? 'Connected, but nothing is coming back from this peer yet. Figures appear as soon as one round trip completes.'
            : 'Measured peer-to-peer over your LAN or Tailscale mesh. Start a video call and it plays here.'}
      </div>
    </div>
  );
}

// Past this many characters the label is small enough, and close enough to the
// three-line cut, that the row is worth being able to hover. Short phrases get
// no tooltip, because a tooltip repeating a word you can already read is noise.
const CUT_RISK = 80;

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

  // Fires once, the moment the agent has finished and the word "Ready" has
  // finished typing itself in. Null the rest of the time.
  const burst = useReadyBurst(state.tone, state.label);

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
      <div
        className={`agent-state agent-tone-${state.tone}`}
        // A tool name long enough to be cut is the one case where the row
        // cannot say everything it knows, so it offers the rest on hover.
        title={state.label.length > CUT_RISK ? state.label : undefined}
      >
        {/* Behind everything, spanning the whole row. */}
        <SpeedStreaks active={state.tone === 'busy'} />
        {/* The finish. A new id is a new firework, and remounting is what makes
            the animation start over rather than picking up mid-flight. */}
        {burst != null && <ReadyBurst key={burst} />}
        {/* Pip and word travel together in a content-sized box, which is what
            lets the veil behind them size itself to the phrase. */}
        <span className="agent-state-front">
          <SparkPip active={state.tone === 'busy'} />
          {/* The row is a fixed size and the phrase is not, so the label is set
              from its own length: the type shrinks as the phrase grows, and the
              phrase fills the row instead of running out of it. One number is
              all CSS needs to do that — see --len in styles.css. */}
          <span className="agent-state-label" style={{ '--len': state.label.length }}>
            <TypedLabel text={state.label} sweeping={state.tone === 'busy'} />
            {state.tone === 'busy' && (
              <span className="agent-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            )}
          </span>
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

      {/* The one thing worth saying to somebody standing in a queue: you do not
          have to watch it. Only shown while it is true, and it stops being true
          the moment the question is read. */}
      {peer.queueHeld && (
        <div className="conn-note conn-note-held">
          Your question is held — it will be read the moment your turn comes, and it does not spend one of your
          queries.
        </div>
      )}
    </div>
  );
}

// The status word, typed in under a block cursor that travels left to right —
// and, while the agent is working, sweeping back across the finished word so the
// row keeps moving for as long as the agent does.
//
// The cursor is the character it is sitting on, drawn as a filled block rather
// than a bar of its own: it is then exactly as wide as the glyph underneath, at
// any font size, without measuring anything. Characters not yet typed keep their
// space (`visibility`, not `display`), so the row never reflows mid-word.
//
// A tool name is not a phrase we chose, so the label has to be able to wrap. But
// every character being its own inline-block means a line would otherwise break
// between any two of them, which reads as nonsense; grouping the characters into
// words puts the break opportunities back where a reader expects to find them.
function TypedLabel({ text, sweeping }) {
  const reduced = useReducedMotion();
  const { head, typed } = useSweep(text, sweeping, !reduced);
  const words = wordsOf(text);

  return (
    <span className="typed">
      {/* Read as one word. The spans below are scaffolding for the cursor and
          would otherwise be announced letter by letter. */}
      <span className="sr-only">{text}</span>
      <span className="typed-run" aria-hidden="true">
        {words.map((word, w) => (
          <span
            key={w}
            // A word too long to fit a line whole is no longer worth keeping
            // whole — a path or an identifier that long has to be allowed to
            // break inside itself, and dropping it back to plain inline text
            // hands the break opportunities back to its characters.
            className={word.length > LONE_WORD_MAX ? 'typed-word typed-word-long' : 'typed-word'}
          >
            {word.map(({ ch, i }) => {
              const cursor = i === head;
              const pending = !typed && head != null && i > head;
              return (
                <span
                  key={`${i}-${ch}`}
                  className={cursor ? 'typed-char typed-cursor' : 'typed-char'}
                  // `--pos` is the character's place in the row, counting the pip
                  // ahead of it as 0. Only the Ready state reads it, to lag each
                  // letter behind the one before it so the colour wave travels.
                  // It counts through the whole label, not through this word.
                  style={{ '--pos': i + 1, ...(pending ? { visibility: 'hidden' } : null) }}
                >
                  {/* A space under the cursor has no glyph to fill, so it borrows
                      the width of an en-space and blocks that instead. */}
                  {ch === ' ' && cursor ? ' ' : ch}
                </span>
              );
            })}
          </span>
        ))}
      </span>
    </span>
  );
}

// Longer than this and a word may break inside itself. Roughly what fits on one
// line at the smallest size the label ever takes, so the only words that break
// are the ones that could not have been kept whole anyway.
const LONE_WORD_MAX = 24;

// The label's characters grouped into words, each keeping its index in the whole
// label so the cursor and the colour wave never notice the grouping. A word
// carries the space that ends it, which is what keeps that space from being
// dropped at a line end and closing the gap between two words.
function wordsOf(text) {
  const words = [];
  let word = null;
  Array.from(text || '').forEach((ch, i) => {
    if (!word) words.push((word = []));
    word.push({ ch, i });
    // A space ends the word it follows; the next character opens a new one.
    if (ch === ' ') word = null;
  });
  return words;
}

// What used to be a stationary dot. While the agent is working it throws a small
// firework — a core that flashes and eight sparks flying out — and every burst
// picks a new neon hue, so the colour is never the same twice running. At rest
// it is just a lit pip in the tone colour, because a calm agent should look calm.
// Long-exposure light trails across the empty half of the row, on while the
// agent is working and nowhere else. Nine of them rather than the dozens in a
// real photograph — this is a 90px status row, not a wallpaper.
//
// Every duration divides 2600ms, the phrase clock in agentPhrase.js, so the
// whole field realigns each time the word changes instead of drifting against
// it. `y` is the vertical position as a percentage, `w` the trail length and `h`
// its thickness, `dur` the crossing time and `lag` the stagger.
const STREAKS = [
  { y: 14, w: 150, h: 2, c: 'var(--streak-magenta)', dur: 1300, lag: -180, o: 0.85 },
  { y: 27, w: 96, h: 1, c: 'var(--streak-cyan)', dur: 650, lag: -520, o: 0.7 },
  { y: 36, w: 210, h: 3, c: 'var(--streak-violet)', dur: 2600, lag: -900, o: 0.9 },
  { y: 48, w: 128, h: 1, c: 'var(--streak-amber)', dur: 867, lag: -60, o: 0.6 },
  { y: 57, w: 176, h: 2, c: 'var(--streak-blue)', dur: 1300, lag: -740, o: 0.8 },
  { y: 66, w: 88, h: 1, c: 'var(--streak-white)', dur: 650, lag: -300, o: 0.55 },
  { y: 74, w: 196, h: 2, c: 'var(--streak-orange)', dur: 2600, lag: -1600, o: 0.75 },
  { y: 83, w: 116, h: 1, c: 'var(--streak-rose)', dur: 867, lag: -430, o: 0.65 },
  { y: 92, w: 160, h: 2, c: 'var(--streak-cyan)', dur: 1300, lag: -1080, o: 0.7 },
];

function SpeedStreaks({ active }) {
  const reduced = useReducedMotion();
  // Taken out of the DOM rather than paused: the global reduced-motion rule
  // stops animations where they stand, which would leave nine coloured bars
  // parked across the row.
  if (!active || reduced) return null;

  return (
    <span className="agent-streaks" aria-hidden="true">
      {STREAKS.map((s, i) => (
        <i
          key={i}
          className="agent-streak"
          style={{
            '--y': `${s.y}%`,
            '--w': `${s.w}px`,
            '--h': `${s.h}px`,
            '--c': s.c,
            '--o': s.o,
            animationDuration: `${s.dur}ms`,
            animationDelay: `${s.lag}ms`,
          }}
        />
      ))}
    </span>
  );
}

// Angle and throw distance per spark, off the compass on purpose: eight evenly
// spaced rays at one radius draw a sun, and this is meant to look thrown.
const SPARKS = [
  [8, 11],
  [56, 8],
  [97, 12],
  [141, 9],
  [186, 10],
  [228, 13],
  [271, 8],
  [319, 11],
];

function SparkPip({ active }) {
  const reduced = useReducedMotion();
  const live = active && !reduced;
  const hue = useBurstHue(live);

  return (
    <span
      className={live ? 'agent-spark is-live' : 'agent-spark'}
      style={live ? { '--spark-h': hue } : undefined}
      aria-hidden="true"
    >
      <span className="agent-spark-core" />
      {live &&
        SPARKS.map(([a, d], i) => (
          <i key={a} className="agent-spark-ray" style={{ '--a': `${a}deg`, '--d': `${d}px`, '--i': i }} />
        ))}
    </span>
  );
}

// ---- The finish ----
// One firework, thrown from the middle of the row the moment the agent has
// finished and the word "Ready" has finished typing itself in. Rays leave the
// centre, spread outward, and fade to nothing, which leaves the row in exactly
// the Ready state it was already in — the burst adds a moment, not a mode.
//
// The row is far wider than it is tall, so the rays reach along an ellipse
// rather than a circle: 300px sideways, where a trail has room to run out under
// the layer's edge mask, and 38px up and down, which stops just inside the
// border rather than being sliced off by it.
const BURST_RX = 300;
const BURST_RY = 38;

// Angle, reach (as a fraction of the ellipse), comet length and thickness, and
// the launch lag. Lengths are uneven on purpose — a firework is a spray, and
// rays that all stop at the same radius draw a wheel. The lags deliberately do
// *not* follow the angles: staggering in angle order would sweep the burst
// round like a second hand instead of opening it all at once.
const RAYS = [
  { a: 4, s: 1.0, w: 52, h: 2, lag: 0, c: 'var(--streak-magenta)' },
  { a: 17, s: 0.72, w: 34, h: 1, lag: 64, c: 'var(--streak-blue)' },
  { a: 29, s: 0.88, w: 44, h: 2, lag: 22, c: 'var(--streak-violet)' },
  { a: 44, s: 0.6, w: 28, h: 1, lag: 96, c: 'var(--streak-magenta)' },
  { a: 53, s: 0.95, w: 40, h: 3, lag: 8, c: 'var(--streak-blue)' },
  { a: 68, s: 0.78, w: 30, h: 2, lag: 52, c: 'var(--streak-violet)' },
  { a: 79, s: 1.0, w: 34, h: 2, lag: 30, c: 'var(--streak-magenta)' },
  { a: 92, s: 0.66, w: 24, h: 1, lag: 84, c: 'var(--streak-blue)' },
  { a: 103, s: 0.9, w: 32, h: 2, lag: 12, c: 'var(--streak-violet)' },
  { a: 118, s: 0.74, w: 30, h: 1, lag: 70, c: 'var(--streak-magenta)' },
  { a: 127, s: 1.0, w: 46, h: 3, lag: 40, c: 'var(--streak-blue)' },
  { a: 141, s: 0.62, w: 26, h: 1, lag: 104, c: 'var(--streak-violet)' },
  { a: 152, s: 0.85, w: 42, h: 2, lag: 18, c: 'var(--streak-magenta)' },
  { a: 166, s: 0.97, w: 50, h: 2, lag: 58, c: 'var(--streak-blue)' },
  { a: 176, s: 0.7, w: 38, h: 1, lag: 26, c: 'var(--streak-violet)' },
  { a: 189, s: 1.0, w: 54, h: 3, lag: 0, c: 'var(--streak-magenta)' },
  { a: 199, s: 0.8, w: 40, h: 2, lag: 76, c: 'var(--streak-blue)' },
  { a: 213, s: 0.68, w: 30, h: 1, lag: 34, c: 'var(--streak-violet)' },
  { a: 224, s: 0.92, w: 36, h: 2, lag: 90, c: 'var(--streak-magenta)' },
  { a: 236, s: 0.75, w: 28, h: 1, lag: 14, c: 'var(--streak-blue)' },
  { a: 248, s: 1.0, w: 34, h: 2, lag: 62, c: 'var(--streak-violet)' },
  { a: 259, s: 0.64, w: 24, h: 1, lag: 44, c: 'var(--streak-magenta)' },
  { a: 271, s: 0.87, w: 30, h: 2, lag: 100, c: 'var(--streak-blue)' },
  { a: 284, s: 0.79, w: 32, h: 1, lag: 20, c: 'var(--streak-violet)' },
  { a: 293, s: 0.96, w: 44, h: 3, lag: 68, c: 'var(--streak-magenta)' },
  { a: 307, s: 0.7, w: 30, h: 1, lag: 36, c: 'var(--streak-blue)' },
  { a: 318, s: 1.0, w: 48, h: 2, lag: 6, c: 'var(--streak-violet)' },
  { a: 331, s: 0.83, w: 40, h: 2, lag: 80, c: 'var(--streak-magenta)' },
  { a: 342, s: 0.66, w: 32, h: 1, lag: 48, c: 'var(--streak-blue)' },
  { a: 354, s: 0.9, w: 50, h: 2, lag: 28, c: 'var(--streak-violet)' },
];

function ReadyBurst() {
  const reduced = useReducedMotion();
  // Nothing to freeze and nothing to see: a burst is motion or it is a handful
  // of coloured bars parked across the row.
  if (reduced) return null;

  return (
    <span className="ready-burst" aria-hidden="true">
      <span className="ready-burst-core" />
      {RAYS.map((r) => {
        const d = Math.round(rayReach(r.a, BURST_RX, BURST_RY) * r.s);
        return (
          <i
            key={r.a}
            className="ready-ray"
            style={{
              '--a': `${r.a}deg`,
              '--d': `${d}px`,
              // A comet longer than its own flight would have its tail still
              // crossing the centre when its head arrives, so the short rays
              // above and below get short comets to match.
              '--w': `${Math.min(r.w, Math.round(d * 0.8))}px`,
              '--h': `${r.h}px`,
              '--c': r.c,
              // Read by the comet inside, which is where the animation lives.
              '--lag': `${r.lag}ms`,
            }}
          />
        );
      })}
    </span>
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
