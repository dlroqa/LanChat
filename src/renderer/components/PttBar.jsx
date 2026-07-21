import React from 'react';
import { Radio } from '../lib/icons.jsx';
import { PTT_KEYS } from '../lib/ptt.js';

// Push-to-talk control. Hold the key (or hold the button) to transmit; there is
// no ringing on either side — audio starts the moment the channel is up.
export default function PttBar({ peer, state, keyName, onHoldStart, onHoldEnd }) {
  if (!peer) return null;
  const keyLabel = (PTT_KEYS[keyName] || PTT_KEYS.meta).label;
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
