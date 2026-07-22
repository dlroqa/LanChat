import React, { useState } from 'react';
import Avatar from './Avatar.jsx';
import { Phone, PhoneOff, Video, Mic, MicOff, VideoOff } from '../lib/icons.jsx';

// Incoming-call toast. Before answering you can pre-choose to join muted and/or
// with the camera off; those choices are passed to onAccept.
export default function IncomingCall({ call, onAccept, onDecline }) {
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);

  return (
    <div className="incoming" role="alertdialog" aria-label="Incoming call">
      <Avatar name={call.peerName} id={call.peerId} />
      <div className="meta">
        <div className="name">{call.peerName || 'Peer'}</div>
        <div className="sub">Incoming {call.withVideo ? 'video' : 'voice'} call…</div>
      </div>

      <div className="pre-toggles">
        <button
          className={`pre-toggle ${muted ? 'off' : ''}`}
          onClick={() => setMuted((v) => !v)}
          title={muted ? 'Will join muted' : 'Mute before answering'}
          aria-pressed={muted}
        >
          {muted ? <MicOff size={16} /> : <Mic size={16} />}
        </button>
        {call.withVideo && (
          <button
            className={`pre-toggle ${cameraOff ? 'off' : ''}`}
            onClick={() => setCameraOff((v) => !v)}
            title={cameraOff ? 'Camera will be off' : 'Turn camera off before answering'}
            aria-pressed={cameraOff}
          >
            {cameraOff ? <VideoOff size={16} /> : <Video size={16} />}
          </button>
        )}
      </div>

      <div className="acts">
        <button className="round-btn decline" onClick={onDecline} title="Decline">
          <PhoneOff size={20} />
        </button>
        <button className="round-btn accept pulse" onClick={() => onAccept({ muted, cameraOff })} title="Accept">
          {call.withVideo ? <Video size={20} /> : <Phone size={20} />}
        </button>
      </div>
    </div>
  );
}
