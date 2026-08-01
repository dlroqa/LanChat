import React, { useEffect, useState } from 'react';
import { Radio, Mic } from '../lib/icons.jsx';
import { resolvePttKey } from '../lib/ptt.js';
import { formatDuration } from '../lib/voice.js';

// The same resolver attachPttKey binds with, so the key named on the card is
// always the key that actually works. Reading the table directly would answer
// "custom" with Command, which is what it used to say while F13 was bound.
function keyLabelFor(keyName, customCode) {
  return resolvePttKey(keyName, customCode).label;
}

// Push-to-talk control. Hold the key (or hold the button) to transmit; there is
// no ringing on either side — just a short radio-style cue (a "go ahead" beep as
// you key up, an "incoming" beep for the listener) before the audio streams.
//
// In a thread with an agent or a session at the far end there is nothing to
// listen, so the same gesture dictates instead and this renders as DictateBar.
export default function PttBar({
  peer,
  state,
  keyName,
  customCode,
  dictation,
  cliReady,
  onHoldStart,
  onHoldEnd,
}) {
  if (!peer) return null;
  if (dictation) {
    return (
      <DictateBar
        keyName={keyName}
        customCode={customCode}
        dictation={dictation}
        cliReady={cliReady}
        onHoldStart={onHoldStart}
        onHoldEnd={onHoldEnd}
      />
    );
  }

  const keyLabel = keyLabelFor(keyName, customCode);
  const talkingAtUs = state.talkers.includes(peer.id);
  const disabled = !peer.online;

  const status = state.transmitting
    ? 'Transmitting…'
    : state.connecting
      ? 'Opening channel…'
      : talkingAtUs
        ? `${peer.name || 'Peer'} is talking`
        : disabled
          ? 'Peer is offline'
          : `Hold ${keyLabel} to talk`;

  return (
    <div className={`ptt-bar ${state.transmitting ? 'live' : ''} ${talkingAtUs ? 'incoming' : ''}`}>
      <button
        className={`ptt-btn ${state.transmitting ? 'live' : ''}`}
        disabled={disabled}
        title={`Push to talk — hold ${keyLabel}`}
        aria-label="Push to talk"
        aria-pressed={state.transmitting}
        onMouseDown={onHoldStart}
        onMouseUp={onHoldEnd}
        onMouseLeave={onHoldEnd}
        onTouchStart={(e) => (e.preventDefault(), onHoldStart())}
        onTouchEnd={onHoldEnd}
      >
        <Radio size={20} />
      </button>
      <div className="ptt-meta">
        <div className="ptt-status">{status}</div>
        <div className="ptt-hint">
          Push to talk · <kbd>{keyLabel}</kbd>
        </div>
      </div>
      {(state.transmitting || talkingAtUs) && (
        <span className={`ptt-wave ${talkingAtUs ? 'in' : 'out'}`} aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </span>
      )}
    </div>
  );
}

// Hold to dictate. The words land in the message box rather than being sent, so
// what goes to the agent is always something that was read first.
function DictateBar({ keyName, customCode, dictation, cliReady, onHoldStart, onHoldEnd }) {
  const keyLabel = keyLabelFor(keyName, customCode);
  const recording = dictation.phase === 'recording';
  const working = dictation.phase === 'transcribing';
  const failed = dictation.phase === 'error';
  // `null` means the check has not come back yet — treated as ready, so the
  // control is not briefly dead on every launch.
  const missing = cliReady === false;
  const [elapsed, setElapsed] = useState(0);

  // Ticks only while recording; a timer running behind an idle card would
  // re-render the panel forever for nothing.
  useEffect(() => {
    if (!recording || !dictation.startedAt) {
      setElapsed(0);
      return undefined;
    }
    const started = dictation.startedAt;
    setElapsed(Date.now() - started);
    const t = setInterval(() => setElapsed(Date.now() - started), 200);
    return () => clearInterval(t);
  }, [recording, dictation.startedAt]);

  const status = missing
    ? 'Dictation is not set up'
    : failed
      ? dictation.error
      : working
        ? 'Transcribing…'
        : recording
          ? `Listening… ${formatDuration(elapsed)}`
          : // 'arming' shows as idle: a quarter of a second of its own state
            // would only ever be seen as a flicker.
            `Hold ${keyLabel} to dictate`;

  return (
    <div
      className={`ptt-bar ${recording ? 'live' : ''} ${working ? 'working' : ''} ${failed ? 'error' : ''}`}
    >
      <button
        className={`ptt-btn ${recording ? 'live' : ''}`}
        disabled={missing || working}
        title={missing ? 'Set up dictation in Settings → Push to talk' : `Hold ${keyLabel} to dictate`}
        aria-label="Hold to dictate"
        aria-pressed={recording}
        onMouseDown={onHoldStart}
        onMouseUp={onHoldEnd}
        onMouseLeave={onHoldEnd}
        onTouchStart={(e) => (e.preventDefault(), onHoldStart())}
        onTouchEnd={onHoldEnd}
      >
        <Mic size={20} />
      </button>
      <div className="ptt-meta">
        <div className={`ptt-status ${failed ? 'error' : ''}`}>{status}</div>
        <div className="ptt-hint">
          {missing ? (
            'Settings → Push to talk'
          ) : (
            <>
              Dictate · <kbd>{keyLabel}</kbd>
            </>
          )}
        </div>
      </div>
      {recording && (
        <span className="ptt-wave out" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </span>
      )}
    </div>
  );
}
