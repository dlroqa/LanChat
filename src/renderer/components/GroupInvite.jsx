import React from 'react';
import Avatar from './Avatar.jsx';
import { PhoneOff, Video, Users } from '../lib/icons.jsx';

// Incoming group-call invite toast with accept / decline.
export default function GroupInvite({ invite, onAccept, onDecline }) {
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
      <div className="acts">
        <button className="round-btn decline" onClick={onDecline} title="Decline">
          <PhoneOff size={20} />
        </button>
        <button className="round-btn accept pulse" onClick={onAccept} title="Join">
          {invite.withVideo ? <Video size={20} /> : <Users size={20} />}
        </button>
      </div>
    </div>
  );
}
