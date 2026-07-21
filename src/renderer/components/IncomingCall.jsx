import React from 'react';
import Avatar from './Avatar.jsx';
import { Phone, PhoneOff, Video } from '../lib/icons.jsx';

// Incoming-call toast with accept / decline actions.
export default function IncomingCall({ call, onAccept, onDecline }) {
  return (
    <div className="incoming" role="alertdialog" aria-label="Incoming call">
      <Avatar name={call.peerName} id={call.peerId} />
      <div className="meta">
        <div className="name">{call.peerName || 'Peer'}</div>
        <div className="sub">Incoming {call.withVideo ? 'video' : 'voice'} call…</div>
      </div>
      <div className="acts">
        <button className="round-btn decline" onClick={onDecline} title="Decline">
          <PhoneOff size={20} />
        </button>
        <button className="round-btn accept pulse" onClick={onAccept} title="Accept">
          {call.withVideo ? <Video size={20} /> : <Phone size={20} />}
        </button>
      </div>
    </div>
  );
}
