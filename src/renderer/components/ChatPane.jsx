import React, { useCallback, useEffect, useRef } from 'react';
import Avatar from './Avatar.jsx';
import Logo from './Logo.jsx';
import MessageBubble from './MessageBubble.jsx';
import Composer from './Composer.jsx';
import AgentApproval from './AgentApproval.jsx';
import AgentFlash from './AgentFlash.jsx';
import { Phone, Video, Trash, Download } from '../lib/icons.jsx';
import { useQueueLabel } from './QueueBadge.jsx';
import { useAgentPhrase } from '../lib/agentPhrase.js';
import { formatDay, platformLabel } from '../lib/util.js';

const GROUP_WINDOW = 4 * 60 * 1000; // group consecutive messages within 4 min

export default function ChatPane({
  peer,
  messages,
  typing,
  awaiting,
  progress,
  previewUrl,
  // Windows only: fall back to the file row when a thumbnail cannot be fetched.
  previewFallback,
  showAddresses,
  // Text handed back after a refused send, for the composer to pick up again.
  draft,
  // Documents staged against the next message to an agent.
  docs,
  onRemoveDoc,
  // Links in messages: how one is opened, and how one is unfurled (undefined
  // when the user has previews turned off).
  onOpenLink,
  linkPreview,
  onSend,
  onAttach,
  onTyping,
  onVoice,
  onOpenFile,
  onRevealFile,
  onVoiceCall,
  onVideoCall,
  onClearHistory,
  onExportHistory,
  approval,
  agentStream,
  onApprove,
  // The connection light: `{ nonce, mode, ms }` while one should be playing, and
  // null the rest of the time. The nonce is what makes a second summon restart it
  // rather than stack a second light on top of the first.
  flash,
  onFlashDone,
}) {
  const scrollRef = useRef(null);
  // Whether the reader is at the end of the conversation. A link card arriving
  // late grows a bubble, which would otherwise nudge the newest message out of
  // sight — so the bottom is held, but only for someone who was already there.
  const atBottom = useRef(true);
  // Live while a handover is counting down, so both sides see the same number.
  const queueLabel = useQueueLabel(peer);
  // An agent thinks rather than types, and it does not send keepalives — so its
  // indicator is driven by whether we are actually waiting on it.
  const isAgent = peer?.kind === 'agent';
  const working = isAgent ? Boolean(typing || awaiting) : Boolean(typing);
  const phrase = useAgentPhrase(isAgent && working);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, typing, awaiting]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  // Stable, so a card is not handed a new callback on every render of the pane.
  const keepAtBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, []);

  if (!peer) {
    return (
      <div className="chat">
        <div className="center-pane">
          <Logo size={84} />
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
          <div className="name">
            {peer.name || peer.hostname}
            {peer.shared && (
              <span className="tag" title="Shared with you from another tailnet">
                shared
              </span>
            )}
          </div>
          <div className="sub">
            {peer.kind === 'agent'
              ? // A delegate thread is a transcript of somebody else's
                // conversation with your agent, so it says whose it is rather
                // than claiming to be off.
                peer.delegate
                ? `${peer.viaName}'s conversation with this agent`
                : peer.remote
                  ? `Agent · shared by ${peer.viaName}`
                  : peer.online
                    ? `Agent · ${peer.agentKind}`
                    : 'Agent · off'
              : peer.online
                ? `Online · ${platformLabel(peer.platform)}`
                : 'Offline'}
            {queueLabel}
            {showAddresses && peer.address ? ` · ${peer.address}` : ''}
          </div>
        </div>
        <div className="chat-actions">
          {/* Agents are text-only participants; there is nothing to call. */}
          {peer.kind !== 'agent' && (
            <>
              <button className="icon-btn" onClick={onVoiceCall} disabled={!peer.online} title="Voice call">
                <Phone size={19} />
              </button>
              <button className="icon-btn" onClick={onVideoCall} disabled={!peer.online} title="Video call">
                <Video size={19} />
              </button>
            </>
          )}
          {/* Available for every kind of thread, agents and transcripts too. */}
          <button className="icon-btn" onClick={onExportHistory} title="Save chat history as a text file">
            <Download size={19} />
          </button>
          <button className="icon-btn danger" onClick={onClearHistory} title="Delete chat history">
            <Trash size={19} />
          </button>
        </div>
      </div>

      {/* The light lives beside the scroller rather than inside it. Inside, its
          `inset: 0` would resolve against the scrolled content: it would be as
          tall as the whole conversation and would slide away as you read. */}
      <div className="messages-wrap">
        <div className="messages" ref={scrollRef} onScroll={onScroll}>
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
                  previewFallback={previewFallback}
                  progress={progress[m.id]}
                  onOpen={onOpenFile}
                  onReveal={onRevealFile}
                  onOpenLink={onOpenLink}
                  linkPreview={linkPreview}
                  onPreviewShown={keepAtBottom}
                />
              </React.Fragment>
            );
          })}

          {/* Live agent output, replaced by the stored message once the run ends. */}
          {agentStream && <div className="agent-stream">{agentStream}</div>}

          <AgentApproval request={approval} agentName={peer.name || 'The agent'} onAnswer={onApprove} />
        </div>
        {flash && (
          <AgentFlash
            key={flash.nonce}
            mode={flash.mode}
            ms={flash.ms}
            name={peer.name || peer.hostname}
            onDone={onFlashDone}
          />
        )}
      </div>

      <div className="typing">
        {working && (
          <>
            {isAgent ? `${peer.name || 'The agent'} is ${phrase.toLowerCase()}` : `${peer.name || 'Peer'} is typing`}
            {/* Three staggered dots. The container keeps its height whether or
                not this is showing, so the message list never jumps. */}
            <span className="typing-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </>
        )}
      </div>

      {/* Text can be composed while a peer is offline and is queued until they
          return. Files and voice need a live connection, so those stay gated.
          The attach button means two different things either side of that line:
          to a person it sends a file, to an agent it hands over something to
          read — same gesture, and the tooltip says which. A delegate thread is
          somebody else's conversation, so nothing is attached there. */}
      <Composer
        draft={draft}
        onSend={onSend}
        onAttach={onAttach}
        onTyping={onTyping}
        onVoice={peer.kind === 'agent' || !peer.online ? undefined : onVoice}
        disabled={peer.kind === 'agent' && !peer.online}
        offline={!peer.online}
        canAttach={peer.online && !peer.delegate}
        attachTitle={isAgent ? 'Attach a document for the agent to read' : 'Send file, photo or video'}
        placeholder={isAgent ? 'Ask the agent…  (Enter to send, Shift+Enter for newline)' : undefined}
        docs={docs}
        onRemoveDoc={onRemoveDoc}
      />
    </div>
  );
}
