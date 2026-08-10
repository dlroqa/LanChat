import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Avatar from './Avatar.jsx';
import EmptyState from './EmptyState.jsx';
import { Sessions, Play, Pause, SkipBack, SkipForward } from '../lib/icons.jsx';
import { useCountdown } from '../lib/useCountdown.js';
import { useAgentPhrase } from '../lib/agentPhrase.js';
import { turnStanding, turnStandingLabel } from '../lib/turnStanding.js';
import { sessionStanding, sessionStandingLabel } from '../lib/sessionStanding.js';
import { counselNames } from '../lib/counselCopy.js';
import { useSweep, useBurstHue, useReadyBurst, useReducedMotion, boxReach } from '../lib/statusMotion.js';
import {
  barCount,
  barColors,
  barDips,
  barValue,
  binRanges,
  decay,
  paint,
  readTokens,
  stillLevels,
  syntheticLevels,
} from '../lib/speechMeter.js';

// Live connection quality for the selected peer, drawn from real round-trip
// measurements taken over the peer WebSocket (see src/main/linkStats.js) — the
// animation reflects actual latency rather than being decorative.
//
// Agents get a different panel entirely. There is no network path to an agent to
// measure — a local one rides a virtual socket, and a shared one is reached
// through its owner — so latency, jitter and packet loss are meaningless for it.
// What matters instead is what the agent is doing and whose turn it is.
//
// A session gets a third. It is a workspace in this window with no socket of any
// kind, and it used to fall through to the panel above and claim a "Good"
// connection, a latency graph measuring nothing, and a round-trip time it had no
// way to have. It borrows the agent's row and boxes instead, and fills them with
// the two things that are true of it: what its agent is doing, and how many
// questions have been committed to it.

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

export default function ConnectionPanel({
  peer,
  stats,
  agentStatus,
  awaiting,
  typing,
  streaming,
  commits,
  approvalClaim,
  onClaimApprovals,
  // The session read-aloud transport: its state and its three handles. Absent
  // wherever reading aloud is switched off, and the bar is not rendered at all
  // then — a session panel without it looks exactly as it always has.
  speech,
}) {
  if (!peer) {
    return (
      <EmptyState title="No conversation selected">
        Pick someone on the left to see their connection and start a call.
      </EmptyState>
    );
  }

  if (peer.kind === 'agent')
    return (
      <AgentPanel
        peer={peer}
        status={agentStatus}
        awaiting={awaiting}
        approvalClaim={approvalClaim}
        onClaimApprovals={onClaimApprovals}
      />
    );

  if (peer.kind === 'session') {
    return (
      <SessionPanel
        peer={peer}
        streaming={streaming}
        awaiting={awaiting}
        typing={typing}
        commits={commits}
        speech={speech}
      />
    );
  }

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

function AgentPanel({ peer, status, awaiting, approvalClaim, onClaimApprovals }) {
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
            {peer.delegate
              ? `${peer.viaName}'s conversation`
              : peer.remote
                ? `Shared by ${peer.viaName}`
                : 'Your agent'}
          </div>
        </div>
      </div>

      {/* Where a human peer gets a latency graph, an agent says what it is
          doing. Same slot, information that actually applies. */}
      <StatusRow tone={state.tone} label={state.label} />

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
            ? `Reached through ${peer.viaName}, on their machine. Everyone sharing it takes turns.`
            : 'Runs on this machine. Every tool call it wants to make is yours to approve, unless you have handed that on.'}
      </div>

      {/* Answering for somebody else's machine. Offered only for an agent that
          is actually somebody else's, and it does nothing on its own: the
          passcode is checked at their end, by them, and a refusal here says only
          that it was refused. */}
      {peer.remote && <ApprovalClaim peer={peer} claim={approvalClaim} onClaim={onClaimApprovals} />}

      {/* The one thing worth saying to somebody standing in a queue: you do not
          have to watch it. Only shown while it is true, and it stops being true
          the moment the question is read. */}
      {peer.queueHeld && (
        <div className="conn-note conn-note-held">
          Your question is held — it will be read the moment your turn comes, and it does not spend one of
          your queries.
        </div>
      )}
    </div>
  );
}

// Asking an owner for the right to answer their agent's permission prompts.
//
// This exists for one situation: their machine is sharing an agent with nobody
// in front of it, and the agent stops to ask whether it may run something. The
// only person there to answer is whoever asked the question — here. So the owner
// sets a passcode, names who may use it, and this is where it is entered.
//
// The passcode is typed, sent and forgotten. It is never held in this component
// beyond the keystroke, never stored, and the answer that comes back says only
// whether it worked — the owner's end decides that, and deliberately gives no
// more away than the fact of a refusal.
function ApprovalClaim({ peer, claim, onClaim }) {
  const [open, setOpen] = useState(false);
  const [passcode, setPasscode] = useState('');
  const granted = claim && claim.ok === true;

  if (granted) {
    return (
      <div className="conn-note conn-note-held">
        You can answer this agent's approval prompts for {peer.viaName}. It ends when either of you
        disconnects.
      </div>
    );
  }

  if (!open) {
    return (
      <button className="btn conn-claim-btn" onClick={() => setOpen(true)}>
        Answer approvals for {peer.viaName}…
      </button>
    );
  }

  const submit = () => {
    if (!passcode) return;
    onClaim?.(peer.id, passcode);
    setPasscode('');
    setOpen(false);
  };

  return (
    <div className="conn-claim">
      <label className="hint" htmlFor="approval-passcode">
        {peer.viaName} can give you a passcode that lets you answer this agent's prompts while they are away.
      </label>
      <input
        id="approval-passcode"
        className="input"
        type="password"
        autoComplete="off"
        value={passcode}
        placeholder="Approval passcode"
        onChange={(e) => setPasscode(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      {claim && claim.ok === false && (
        <div className="hint conn-claim-refused" role="status">
          {claim.lockedMs
            ? `Refused. Try again in ${Math.ceil(claim.lockedMs / 1000)}s.`
            : 'Refused. Check the passcode, or ask them whether they have switched this on.'}
        </div>
      )}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" onClick={submit} disabled={!passcode}>
          Ask
        </button>
        <button className="btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function SessionPanel({ peer, streaming, awaiting, typing, commits, speech }) {
  // Three sources again, and none of them the peer card: a session has no
  // presence to read one off. `typing` is main's own bracket around a run — it
  // is raised on the session's id, not the agent's, the moment the question goes
  // and lowered when the answer lands. `awaiting` is having asked and not heard
  // back, which covers a whole round in a session that asked several agents at
  // once. `streaming` is text already arriving from any of them.
  //
  // The agent's own `status` is deliberately not one of them: it is published
  // keyed by agent id alone, so a session thread never receives `working` and a
  // row built on it would sit dead through the whole answer.
  const busy = typing === true || awaiting === true || streaming === true;

  // The same clock-derived phrase the chat indicator is showing under the
  // conversation at this instant, so the two never show different words.
  const phrase = useAgentPhrase(busy);

  // One derivation for the row and the Status box, so the word being typed and
  // the word in the box can never contradict each other.
  const standing = sessionStanding(peer, busy, phrase);

  // Who this session asks, from the one place that says it — a counsel of three
  // named here and counted in the header would be two answers to one question.
  const names = Array.isArray(peer.agentNames) ? peer.agentNames : peer.agentName ? [peer.agentName] : [];
  const who = counselNames(names);
  const many = names.length > 1;

  return (
    <div className="conn-panel">
      <div className="conn-head">
        {/* A session has no face and no presence: it is a workspace. The same
            mark the conversation header uses stands where an avatar would, so
            neither surface implies somebody is there. */}
        <span className="session-mark" aria-hidden="true">
          <Sessions size={20} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="conn-name">{peer.name}</div>
          <div className={`conn-sub agent-tone-${standing.tone}`}>{who ? `Asks ${who}` : 'No agent yet'}</div>
        </div>
      </div>

      {/* Same slot as the agent's, and the same row: what is being done with the
          question this session last asked. */}
      <StatusRow tone={standing.tone} label={standing.label} />

      {/* Where a shared agent's panel counts down the queries left in a turn,
          a session counts up. Nobody else is in here — a session is local, has
          no presence and takes no turns — so the number worth carrying is what
          this workspace has put in: the questions asked from it. */}
      <div className="conn-stats">
        <Stat
          label="Status"
          value={standing.word}
          tone={standing.key}
          title={sessionStandingLabel(peer, busy)}
        />
        <CommitStat commits={commits} />
        <Stat label="Via" value={who || '—'} />
      </div>

      {/* Reading the session out loud, straight through. Directly under the
          tiles because it is about this session as a whole rather than about any
          one message — the bubbles carry the per-turn button, and both move the
          same cursor, so the two can never disagree about what is speaking. */}
      {speech && <Transport {...speech} />}

      <div className="conn-note">
        {who
          ? `A workspace on this machine. Nothing in it goes over the wire — questions go to ${who}, and the answers are filed here rather than in ${many ? 'those agents’ own threads' : "that agent's own thread"}.`
          : 'A workspace on this machine, with no agent to ask yet. Choose one beside the title above and this session can start asking.'}
      </div>
    </div>
  );
}

// Reading the whole session aloud: back a turn, play or pause, on a turn.
//
// Three buttons rather than one, because a read-through of twenty turns is a
// thing you need to steer — a turn you missed is one press back, and one you do
// not care about is one press forward. Play and pause are the same button
// because they are the same decision, and two buttons where one of them is
// always wrong is how a transport gets misread.
//
// The position line is not decoration. A long turn is silent while it is being
// synthesised, and the loading bar below the buttons covers exactly that gap —
// so between the two, a reading that is working is never mistaken for one that
// has stalled.
// What to call the voice that spoke. "This computer" rather than the name of a
// platform speech engine nobody outside a browser has heard of.
function engineName(engine) {
  if (engine === 'gemini') return 'Gemini';
  if (engine === 'xai') return 'xAI';
  // Also on this computer, but a named model rather than the platform's own
  // voices — and worth naming, because the difference is audible and is the
  // whole reason somebody downloaded it.
  if (engine === 'kokoro') return 'Kokoro';
  if (engine === 'local') return 'This computer';
  return null;
}

// The equalizer that takes the loading bar's place once a voice is being heard.
//
// Everything it draws it reads straight off the player's tap, in its own
// animation frame, onto a canvas. It never sets state and never re-renders
// anything: the player's onChange redraws the whole panel, and a meter that went
// through it would do that sixty times a second to paint something React is not
// painting. The two booleans below are all React decides — whether there is
// anything to run at all, and which face — and both change a handful of times
// per reading rather than per frame.
//
// The arithmetic lives in lib/speechMeter.js so it can be read and tested
// without a canvas. What is left here is plumbing.
function TransportMeter({ meter, live, blind }) {
  const ref = useRef(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    // Nothing is being heard: no loop, no frames, no work at all. `live` is the
    // whole of the promise that an idle window burns nothing — the loop does not
    // exist unless there is something to draw.
    if (!live || !meter) return undefined;
    const cv = ref.current;
    // No canvas in a harness that renders without a DOM, and no 2d context in a
    // window that will not give one. Either way there is nothing to draw on, and
    // a meter is not worth an exception.
    const ctx = cv && typeof cv.getContext === 'function' ? cv.getContext('2d') : null;
    if (!ctx) return undefined;

    // One read of the theme, when the loop starts — which is once per turn, so a
    // token changed while the app is open is picked up within a turn.
    // getComputedStyle is a layout read and has no business in a frame.
    const tokens = readTokens(typeof getComputedStyle === 'function' ? getComputedStyle(cv) : null);

    // Size is measured on resize rather than per frame: a getBoundingClientRect
    // inside an animation frame forces a synchronous layout every frame, for a
    // number that changes only when the window does.
    let box = cv.getBoundingClientRect();
    const ro =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            box = cv.getBoundingClientRect();
          })
        : null;
    ro?.observe(cv);

    let freq = null;
    let level = null;
    let colors = null;
    let dips = null;
    let ranges = null;
    let bars = 0;
    let lastWord = -1;
    let wordAt = 0;
    let raf = 0;

    const draw = (t, still) => {
      const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
      const W = Math.max(1, Math.round(box.width * dpr));
      const H = Math.max(1, Math.round(box.height * dpr));
      // Assigning either dimension clears the canvas, so it is done only when one
      // has really changed — and it is the one place the per-bar tables are
      // rebuilt, because every one of them is sized by the bar count.
      //
      // `!level` is not belt and braces. The tables belong to this effect, and
      // the effect re-runs whenever the face changes — a reading that moves from
      // an online voice to the platform's, say. The canvas is already the right
      // size by then, so a check on the size alone left every table null and the
      // first frame after the change threw.
      if (cv.width !== W || cv.height !== H || !level) {
        cv.width = W;
        cv.height = H;
        // The blind face has no analyser and so answers zero to both of these.
        // One pair of fallbacks, used for every table, rather than a different
        // guess at each call — two guesses that disagree would size the buckets
        // against a spectrum that does not exist.
        const fft = meter.samples() || 2048;
        const bins = meter.bins() || fft / 2;
        bars = barCount(box.width, bins, meter.rate(), fft);
        level = new Float32Array(bars);
        colors = barColors(bars, tokens);
        dips = barDips(bars);
        ranges = binRanges(bars, meter.rate(), fft, bins);
      }
      const face = meter.face();
      // A frame or two of nothing, between the last sound of one turn and the
      // first of the next. Left as it was rather than cleared: the CSS is already
      // fading the canvas out, and a blank flash under a fade is worse than a
      // held frame.
      if (face === 'off') return;

      if (still) {
        stillLevels(level, bars);
        paint(ctx, W, H, dpr, { level, colors, dips, tokens });
        return;
      }

      if (face === 'signal') {
        // Only the spectrum is drawn, so only the spectrum is read. The
        // time-domain buffer went with the waveform lane it fed.
        const want = meter.bins();
        if (!freq || freq.length !== want) freq = new Uint8Array(want);
        meter.read(freq, null);
        for (let i = 0; i < bars; i += 1) {
          level[i] = decay(level[i], barValue(freq, ranges[i * 2], ranges[i * 2 + 1]));
        }
        paint(ctx, W, H, dpr, { level, colors, dips, tokens });
        return;
      }

      // Blind: the platform voice, with no node in the graph to read. Its
      // envelope still comes from a real signal — the word boundaries it fires.
      const w = meter.word();
      if (w !== lastWord) {
        lastWord = w;
        wordAt = t;
      }
      syntheticLevels(level, bars, t, t - wordAt);
      paint(ctx, W, H, dpr, { level, colors, dips, tokens });
    };

    if (reduced) {
      // One frame, painted once. The motion is gone and the state is not — the
      // same bargain .transport-load.on makes in the stylesheet.
      draw(0, true);
    } else {
      const frame = (t) => {
        draw(t, false);
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    }

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
    };
    // `meter` is the player's tap, built once with the player and never
    // replaced, so this list changes only when the reading does.
  }, [meter, live, blind, reduced]);

  return (
    // Decoration, and said so: what it shows is already in words in
    // .transport-pos, which is the role="status" a screen reader is listening to.
    <canvas
      ref={ref}
      className={`transport-meter ${live ? 'on' : ''} ${blind ? 'blind' : ''}`}
      aria-hidden="true"
    />
  );
}

function Transport({
  playing,
  paused,
  pending,
  prefetch,
  position,
  count,
  engine,
  meter,
  onToggle,
  onNext,
  onPrev,
}) {
  const empty = !count;
  // Why it is off, said on the control rather than left to be guessed at.
  const why = empty ? 'Nothing has been said in this session yet' : undefined;
  const label = playing ? 'Pause' : paused ? 'Continue reading aloud' : 'Read this session aloud';
  // Whether a voice is actually being heard, which is the whole of the rule
  // deciding which face has the row. A turn being synthesised belongs to the
  // bar; only the sound itself belongs to the meter, so the two can never be lit
  // at once. The player's tap gates on the same thing from the audio side, where
  // it cannot lag a tick behind what is making noise.
  const live = Boolean(playing && !pending && !prefetch);

  return (
    <div className="conn-transport">
      <div className="transport-row">
        <button
          className="transport-btn"
          onClick={onPrev}
          disabled={empty}
          title={why || 'Previous turn'}
          aria-label="Previous turn"
        >
          <SkipBack size={16} />
        </button>
        <button
          className={`transport-btn transport-play ${playing ? 'on' : ''}`}
          onClick={onToggle}
          disabled={empty}
          title={why || label}
          aria-label={label}
          aria-pressed={playing}
        >
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button
          className="transport-btn"
          onClick={onNext}
          disabled={empty}
          title={why || 'Next turn'}
          aria-label="Next turn"
        >
          <SkipForward size={16} />
        </button>
      </div>
      {/* The gap the position line cannot show. Two shapes on one bar: while the
          whole session is being synthesised ahead of play it fills to a known
          proportion; while an ordinary reading fetches its next turn it slides,
          the duration being unknown. Always in the layout so nothing below it
          moves when it lights, and a CSS delay keeps a cache hit from flashing
          it. A progressbar, not a bare colour, so the state is announced. */}
      <div
        className={`transport-load ${pending || prefetch ? 'on' : ''} ${prefetch ? 'filling' : ''}`}
        role="progressbar"
        aria-label={prefetch ? 'Synthesising the whole session' : 'Preparing the next turn'}
        aria-valuenow={prefetch ? Math.round((prefetch.done / Math.max(1, prefetch.total)) * 100) : undefined}
        aria-valuetext={
          prefetch
            ? `${prefetch.done} of ${prefetch.total} prepared`
            : pending
              ? 'Preparing the next turn'
              : 'Ready'
        }
      >
        <span
          style={prefetch ? { width: `${(prefetch.done / Math.max(1, prefetch.total)) * 100}%` } : undefined}
        />
      </div>
      {/* And the voice itself, behind all of it. Last in the markup and first in
          the paint order, because it is the backdrop the buttons sit on. */}
      <TransportMeter meter={meter} live={live} blind={engine === 'local'} />
      {/* Polite rather than assertive: worth hearing when it changes, not worth
          cutting into whatever a screen reader is already saying. */}
      <div className="transport-pos" role="status" aria-live="polite">
        {prefetch
          ? // Preparing the whole run before a word of it plays, so there is a
            // wait to account for and a count to show it moving.
            `Synthesising all · ${prefetch.done} of ${prefetch.total}`
          : empty
            ? 'Nothing to read yet'
            : playing || paused
              ? // The engine is named from what actually spoke, not from the
                // setting — Gemini switched on but unreachable reads locally, and
                // this is where that becomes visible without opening Settings.
                `${position} of ${count}${engineName(engine) ? ` · ${engineName(engine)}` : ''}${
                  paused ? ' · paused' : ''
                }`
              : `${count} turn${count === 1 ? '' : 's'}`}
      </div>
    </div>
  );
}

// The commit box. The number lands rather than blinks: a commit is an event, and
// the tile marks the moment one is made instead of pulsing at you afterwards. The
// key is the count itself, so a remount is what restarts the animation — the same
// trick the finish firework uses, for the same reason.
function CommitStat({ commits }) {
  const n = Number.isFinite(commits) ? commits : 0;
  return (
    <Stat
      label="Commit"
      value={n}
      tone="commit"
      pulse={n}
      title={`${n} question${n === 1 ? '' : 's'} asked in this session`}
    />
  );
}

// The status row: what is being done, said in the slot a peer uses for its
// latency graph. Shared by the agent panel and the session panel so there is one
// row rather than two that have to be kept looking alike.
function StatusRow({ tone, label }) {
  // Fires once, the moment the work has finished and the resting word has
  // finished typing itself in. Null the rest of the time.
  const burst = useReadyBurst(tone, label);

  return (
    <div
      className={`agent-state agent-tone-${tone}`}
      // A tool name long enough to be cut is the one case where the row
      // cannot say everything it knows, so it offers the rest on hover.
      title={label.length > CUT_RISK ? label : undefined}
    >
      {/* Behind everything, spanning the whole row. */}
      <SpeedStreaks active={tone === 'busy'} />
      {/* The finish. A new id is a new firework, and remounting is what makes
          the animation start over rather than picking up mid-flight. */}
      {burst != null && <ReadyBurst key={burst} />}
      {/* Pip and word travel together in a content-sized box, which is what
          lets the veil behind them size itself to the phrase. */}
      <span className="agent-state-front">
        <SparkPip active={tone === 'busy'} />
        {/* The row is a fixed size and the phrase is not, so the label is set
            from its own length: the type shrinks as the phrase grows, and the
            phrase fills the row instead of running out of it. One number is
            all CSS needs to do that — see --len in styles.css. */}
        <span className="agent-state-label" style={{ '--len': label.length }}>
          <TypedLabel text={label} sweeping={tone === 'busy'} />
          {tone === 'busy' && (
            <span className="agent-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          )}
        </span>
      </span>
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
// Angle, reach (as a fraction of the distance to the border at that angle),
// comet length (as a fraction of the ray's own reach), thickness, and the launch
// lag.
//
// The angles are not evenly spaced, and that is the whole of covering the box:
// the row is around six times wider than it is tall, so even spacing crowds most
// of the rays into the short vertical stubs and leaves the two wide ends of the
// rectangle dark. These are laid out by where they *land* instead — endpoints
// spread along the border — which is why the shallow angles come thick and fast
// and the steep ones are sparse.
//
// Reaches straddle 1: some rays stop short of the border and some overshoot it,
// so the field has depth rather than being a wheel with one radius. The lags
// deliberately do not follow the angles — staggering in angle order would sweep
// the burst round like a second hand instead of opening it all at once.
const RAYS = [
  { a: 0.8, s: 1.12, w: 0.28, h: 3, lag: 24, c: 'var(--streak-magenta)' },
  { a: 3.7, s: 0.78, w: 0.42, h: 1, lag: 80, c: 'var(--streak-blue)' },
  { a: 8.9, s: 0.97, w: 0.32, h: 3, lag: 68, c: 'var(--streak-violet)' },
  { a: 13.1, s: 0.92, w: 0.42, h: 1, lag: 8, c: 'var(--streak-violet)' },
  { a: 15.2, s: 1.0, w: 0.36, h: 1, lag: 44, c: 'var(--streak-magenta)' },
  { a: 22.7, s: 0.86, w: 0.36, h: 2, lag: 0, c: 'var(--streak-blue)' },
  { a: 31.9, s: 1.06, w: 0.24, h: 2, lag: 92, c: 'var(--streak-blue)' },
  { a: 44.0, s: 1.12, w: 0.32, h: 1, lag: 116, c: 'var(--streak-violet)' },
  { a: 55.6, s: 0.92, w: 0.42, h: 2, lag: 92, c: 'var(--streak-magenta)' },
  { a: 73.8, s: 1.12, w: 0.36, h: 1, lag: 8, c: 'var(--streak-magenta)' },
  { a: 88.1, s: 0.92, w: 0.36, h: 3, lag: 104, c: 'var(--streak-blue)' },
  { a: 96.5, s: 0.78, w: 0.24, h: 3, lag: 116, c: 'var(--streak-violet)' },
  { a: 105.1, s: 0.92, w: 0.42, h: 3, lag: 68, c: 'var(--streak-violet)' },
  { a: 121.2, s: 0.92, w: 0.36, h: 3, lag: 44, c: 'var(--streak-magenta)' },
  { a: 136.1, s: 0.78, w: 0.36, h: 1, lag: 16, c: 'var(--streak-blue)' },
  { a: 150.6, s: 1.0, w: 0.24, h: 2, lag: 0, c: 'var(--streak-blue)' },
  { a: 158.4, s: 0.86, w: 0.32, h: 1, lag: 116, c: 'var(--streak-violet)' },
  { a: 162.5, s: 0.86, w: 0.36, h: 2, lag: 68, c: 'var(--streak-magenta)' },
  { a: 166.4, s: 0.78, w: 0.28, h: 2, lag: 56, c: 'var(--streak-magenta)' },
  { a: 168.8, s: 1.0, w: 0.32, h: 1, lag: 56, c: 'var(--streak-blue)' },
  { a: 175.9, s: 1.12, w: 0.42, h: 1, lag: 116, c: 'var(--streak-violet)' },
  { a: 179.7, s: 0.97, w: 0.32, h: 3, lag: 56, c: 'var(--streak-violet)' },
  { a: 184.3, s: 0.86, w: 0.28, h: 1, lag: 16, c: 'var(--streak-magenta)' },
  { a: 190.3, s: 0.86, w: 0.28, h: 3, lag: 24, c: 'var(--streak-blue)' },
  { a: 195.3, s: 0.92, w: 0.32, h: 1, lag: 16, c: 'var(--streak-violet)' },
  { a: 201.4, s: 0.97, w: 0.42, h: 1, lag: 92, c: 'var(--streak-magenta)' },
  { a: 211.7, s: 1.0, w: 0.32, h: 1, lag: 116, c: 'var(--streak-magenta)' },
  { a: 216.9, s: 0.78, w: 0.36, h: 2, lag: 16, c: 'var(--streak-blue)' },
  { a: 223.5, s: 1.12, w: 0.42, h: 2, lag: 104, c: 'var(--streak-blue)' },
  { a: 236.3, s: 1.06, w: 0.24, h: 2, lag: 104, c: 'var(--streak-violet)' },
  { a: 255.8, s: 1.12, w: 0.42, h: 2, lag: 56, c: 'var(--streak-violet)' },
  { a: 268.1, s: 0.97, w: 0.36, h: 1, lag: 68, c: 'var(--streak-magenta)' },
  { a: 277.4, s: 1.06, w: 0.36, h: 1, lag: 24, c: 'var(--streak-blue)' },
  { a: 284.2, s: 0.78, w: 0.28, h: 2, lag: 16, c: 'var(--streak-blue)' },
  { a: 304.2, s: 0.78, w: 0.32, h: 2, lag: 0, c: 'var(--streak-violet)' },
  { a: 317.2, s: 0.78, w: 0.24, h: 2, lag: 16, c: 'var(--streak-magenta)' },
  { a: 328.2, s: 1.0, w: 0.24, h: 1, lag: 92, c: 'var(--streak-magenta)' },
  { a: 335.7, s: 0.78, w: 0.24, h: 1, lag: 92, c: 'var(--streak-blue)' },
  { a: 341.0, s: 0.97, w: 0.28, h: 3, lag: 34, c: 'var(--streak-violet)' },
  { a: 347.1, s: 0.92, w: 0.42, h: 1, lag: 68, c: 'var(--streak-violet)' },
  { a: 348.4, s: 0.78, w: 0.24, h: 2, lag: 68, c: 'var(--streak-magenta)' },
  { a: 354.6, s: 0.97, w: 0.36, h: 1, lag: 8, c: 'var(--streak-blue)' },
];

// The shortest comet worth drawing. Below this a ray is a dot, and a field of
// dots is not a firework.
const MIN_COMET = 12;

function ReadyBurst() {
  const reduced = useReducedMotion();
  const layer = useRef(null);
  // The row's own size, because the panel is not a fixed width — it is narrower
  // at the 1180px breakpoint and wider on a large window, and a burst sized for
  // one of those would fall short or overshoot in the other. Measured once, in a
  // layout effect, so the rays are laid out before the first paint rather than
  // flashing at the wrong length.
  const [box, setBox] = useState(null);
  useLayoutEffect(() => {
    const el = layer.current;
    if (el) setBox({ halfW: el.offsetWidth / 2, halfH: el.offsetHeight / 2 });
  }, []);

  // Nothing to freeze and nothing to see: a burst is motion or it is a handful
  // of coloured bars parked across the row.
  if (reduced) return null;

  return (
    <span className="ready-burst" ref={layer} aria-hidden="true">
      <span className="ready-burst-core" />
      {box &&
        RAYS.map((r) => {
          const d = Math.round(boxReach(r.a, box.halfW, box.halfH) * r.s);
          return (
            <i
              key={r.a}
              className="ready-ray"
              style={{
                '--a': `${r.a}deg`,
                '--d': `${d}px`,
                // Comets are cut from their own ray, so a long one across the
                // row is a streak and a short one over the pip is a spark.
                '--w': `${Math.max(MIN_COMET, Math.round(d * r.w))}px`,
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
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Connection latency over time"
      >
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
//
// `pulse` is for a box whose value is an event rather than a situation: change it
// and the tint layer remounts, which is what plays its animation from the first
// frame again. The tint lives in a child of its own so that remount cannot take
// the value with it and make the number flicker.
function Stat({ label, value, tone, title, pulse }) {
  return (
    <div className={tone ? `stat stat-tint stat-tint-${tone}` : 'stat'} title={title || undefined}>
      {tone && <span key={pulse} className="stat-tint-wash" aria-hidden="true" />}
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
