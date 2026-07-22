import React, { useState } from 'react';
import Avatar from './Avatar.jsx';
import { PhoneOff, Video, Users, Mic, MicOff, VideoOff } from '../lib/icons.jsx';

// Incoming group-call invite toast, with pre-answer mute / camera-off toggles.
export default function GroupInvite({ invite, onAccept, onDecline }) {
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const others = Math.max(0, (invite.roster ? invite.roster.length : 1) - 1);

  return (
    <div className="incoming" role="alertdialog" aria-label="Group call invite">
      <Avatar name={invite.hostName} id={invite.from} />
      <div className="meta">
        <div className="name">{invite.hostName || 'Someone'}</div>
        <div className="sub">
          Group {invite.withVideo ? 'video' : 'voice'} call
          {others > 0 ? ` · ${others} other${others === 1 ? '' : 's'}` : ''}
        </div>
      </div>

      <div className="pre-toggles">
        <button
          className={`pre-toggle ${muted ? 'off' : ''}`}
          onClick={() => setMuted((v) => !v)}
          title={muted ? 'Will join muted' : 'Mute before joining'}
          aria-pressed={muted}
        >
          {muted ? <MicOff size={16} /> : <Mic size={16} />}
        </button>
        {invite.withVideo && (
          <button
            className={`pre-toggle ${cameraOff ? 'off' : ''}`}
            onClick={() => setCameraOff((v) => !v)}
            title={cameraOff ? 'Camera will be off' : 'Turn camera off before joining'}
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
        <button className="round-btn accept pulse" onClick={() => onAccept({ muted, cameraOff })} title="Join">
          {invite.withVideo ? <Video size={20} /> : <Users size={20} />}
        </button>
      </div>
    </div>
  );
}
