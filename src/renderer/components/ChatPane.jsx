import React, { useEffect, useRef } from 'react';
import Avatar from './Avatar.jsx';
import MessageBubble from './MessageBubble.jsx';
import Composer from './Composer.jsx';
import { Phone, Video } from '../lib/icons.jsx';
import { formatDay, platformLabel } from '../lib/util.js';

const GROUP_WINDOW = 4 * 60 * 1000; // group consecutive messages within 4 min

export default function ChatPane({
  peer,
  messages,
  typing,
  progress,
  previewUrl,
  onSend,
  onAttach,
  onTyping,
  onOpenFile,
  onRevealFile,
  onVoiceCall,
  onVideoCall,
}) {
  const scrollRef = useRef(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, typing]);

  if (!peer) {
    return (
      <div className="chat">
        <div className="center-pane">
          <Avatar name="LanChat" id="lanchat" size="lg" />
          <h2>Welcome to LanChat</h2>
          <p>
            Select someone on the left to start chatting. People on your Tailscale mesh or local network who run
            LanChat appear automatically — no servers, no accounts, everything stays on your own devices.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="chat">
      <div className="chat-header">
        <Avatar name={peer.name} id={peer.id} avatar={peer.avatar} online={peer.online} />
        <div className="meta">
          <div className="name">{peer.name || peer.hostname}</div>
          <div className="sub">
            {peer.online ? `Online · ${platformLabel(peer.platform)}` : 'Offline'}
            {peer.address ? ` · ${peer.address}` : ''}
          </div>
        </div>
        <div className="chat-actions">
          <button className="icon-btn" onClick={onVoiceCall} disabled={!peer.online} title="Voice call">
            <Phone size={19} />
          </button>
          <button className="icon-btn" onClick={onVideoCall} disabled={!peer.online} title="Video call">
            <Video size={19} />
          </button>
        </div>
      </div>

      <div className="messages" ref={scrollRef}>
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const newDay = !prev || formatDay(prev.ts) !== formatDay(m.ts);
          const grouped =
            prev && prev.direction === m.direction && !newDay && m.ts - prev.ts < GROUP_WINDOW && m.kind === 'text';
          return (
            <React.Fragment key={m.id}>
              {newDay && <div className="day-sep">{formatDay(m.ts)}</div>}
              <MessageBubble
                msg={m}
                grouped={grouped}
                previewUrl={previewUrl}
                progress={progress[m.id]}
                onOpen={onOpenFile}
                onReveal={onRevealFile}
              />
            </React.Fragment>
          );
        })}
      </div>

      <div className="typing">{typing ? `${peer.name || 'Peer'} is typing…` : ''}</div>

      <Composer onSend={onSend} onAttach={onAttach} onTyping={onTyping} disabled={!peer.online} />
    </div>
  );
}
