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
// listen, so this renders as DictateBar instead — where the same key dictates,
// and the button is tapped rather than held.
export default function PttBar({
  peer,
  state,
  keyName,
  customCode,
  dictateKeyName,
  dictateCustomCode,
  dictation,
  cliReady,
  onHoldStart,
  onHoldEnd,
  onDictateToggle,
}) {
  if (!peer) return null;
  if (dictation) {
    return (
      <DictateBar
        // The key the card names is the one that dictates: its own, once it has
        // one, and otherwise the push-to-talk key it borrows.
        keyName={dictateKeyName || keyName}
        customCode={dictateKeyName ? dictateCustomCode : customCode}
        dictation={dictation}
        cliReady={cliReady}
        onToggle={onDictateToggle}
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

// Dictate. The words land in the message box rather than being sent, so what
// goes to the agent is always something that was read first.
//
// Two gestures reach the same place. The key is held, because that is what the
// push-to-talk key has always done and the muscle memory is worth keeping. The
// button is tapped — start, speak, tap again — because a button you have to hold
// down while you talk is a button you cannot look away from, and dictating into
// a message box is exactly when you want to be reading the message box.
function DictateBar({ keyName, customCode, dictation, cliReady, onToggle }) {
  const keyLabel = keyLabelFor(keyName, customCode);
  const arming = dictation.phase === 'arming';
  const recording = dictation.phase === 'recording' || arming;
  const working = dictation.phase === 'transcribing';
  const failed = dictation.phase === 'error';
  // `null` means the check has not come back yet — treated as reachable, so the
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

  // "Recording", not "Listening": the session card directly below this one says
  // "Listening" to mean the agents are free, and two unrelated senses of the word
  // stacked on top of each other read as one status contradicting itself.
  const status = missing
    ? "FluidVoice isn't reachable"
    : failed
      ? dictation.error
      : working
        ? 'Transcribing…'
        : recording
          ? `Recording… ${formatDuration(elapsed)}`
          : `Tap to dictate`;

  return (
    <div
      className={`ptt-bar ${recording ? 'live' : ''} ${working ? 'working' : ''} ${failed ? 'error' : ''}`}
    >
      <button
        // Not disabled when unreachable: tapping it checks again. FluidVoice is
        // another application, so "not reachable" is usually a thing the user is
        // in the middle of fixing, and a dead control is how that reads as broken.
        className={`ptt-btn ${recording ? 'live' : ''}`}
        disabled={working}
        title={
          missing
            ? 'Tap to check again — set it up in Settings → Push to talk'
            : recording
              ? 'Tap to stop'
              : `Tap to dictate, or hold ${keyLabel}`
        }
        aria-label={missing ? 'Check for FluidVoice again' : recording ? 'Stop dictating' : 'Dictate'}
        aria-pressed={recording}
        onClick={onToggle}
      >
        <Mic size={20} />
      </button>
      <div className="ptt-meta">
        <div className={`ptt-status ${failed ? 'error' : ''}`}>{status}</div>
        <div className="ptt-hint">
          {missing ? (
            'Tap to retry · Settings → Push to talk'
          ) : recording ? (
            'Tap to stop'
          ) : (
            <>
              FluidVoice · <kbd>{keyLabel}</kbd>
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
