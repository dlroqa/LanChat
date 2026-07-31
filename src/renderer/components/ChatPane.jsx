import React, { useCallback, useEffect, useRef } from 'react';
import Avatar from './Avatar.jsx';
import Logo from './Logo.jsx';
import MessageBubble from './MessageBubble.jsx';
import Composer from './Composer.jsx';
import AgentApproval from './AgentApproval.jsx';
import AgentFlash from './AgentFlash.jsx';
import SessionTitle from './SessionTitle.jsx';
import { Phone, Video, Trash, Download, Upload, Sessions, Alert } from '../lib/icons.jsx';
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
  // The excerpt a fork pinned, travelling with the next message as context.
  context,
  onRemoveContext,
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
  // Sessions: the agents one can be pointed at, renaming it, loading a saved
  // conversation into it, and branching a new question off any bubble.
  agents = [],
  // Agents this peer is sharing, offered while an `@` is typed at them, and what
  // choosing one does.
  mentionables = [],
  onSummon,
  onRenameSession,
  onSetSessionAgent,
  onImportText,
  onFork,
  // Putting a question that failed back into the composer. Given on the same
  // threads as onFork, since both only mean anything where a question can be
  // asked.
  onResend,
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
  // indicator is driven by whether we are actually waiting on it. A session asks
  // an agent, so it waits the same way.
  const isAgent = peer?.kind === 'agent';
  const isSession = peer?.kind === 'session';
  const thinks = isAgent || isSession;
  const working = thinks ? Boolean(typing || awaiting) : Boolean(typing);
  const phrase = useAgentPhrase(thinks && working);
  // The agent a session asks, by name, for the indicator and the placeholder.
  const sessionAgent = isSession && peer.agentId ? agents.find((a) => a.id === peer.agentId) : null;
  const thinkerName = isSession ? sessionAgent?.name || 'The agent' : peer?.name || 'The agent';

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
        {/* A session has no face and no presence: it is a workspace, and the
            mark says so where an avatar would otherwise imply somebody is
            there. */}
        {isSession ? (
          <span className="session-mark large" aria-hidden="true">
            <Sessions size={20} />
          </span>
        ) : (
          <Avatar name={peer.name} id={peer.id} avatar={peer.avatar} online={peer.online} />
        )}
        <div className="meta">
          <div className="name">
            {isSession ? (
              <SessionTitle title={peer.name} onRename={(title) => onRenameSession(peer.id, title)} />
            ) : (
              peer.name || peer.hostname
            )}
            {peer.shared && (
              <span className="tag" title="Shared with you from another tailnet">
                shared
              </span>
            )}
          </div>
          {/* Which agent this session asks — the one thing a session has to be
              told, and the only thing that stops it being able to ask. Kept in
              the header rather than behind a dialog because it is read as often
              as it is set. */}
          {isSession ? (
            <div className="sub session-sub">
              <span>Session ·</span>
              <select
                className="session-agent"
                aria-label="The agent this session asks"
                value={peer.agentId || ''}
                onChange={(e) => onSetSessionAgent(peer.id, e.target.value || null)}
              >
                <option value="">choose an agent…</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
                {/* The agent this session was pointed at has gone — switched
                    off, removed, or belonging to a peer who stopped sharing it.
                    Saying so is better than a picker that reads as though
                    nobody was ever chosen. */}
                {peer.agentId && !sessionAgent && <option value={peer.agentId}>an agent that is no longer here</option>}
              </select>
            </div>
          ) : (
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
          )}
        </div>
        <div className="chat-actions">
          {/* Agents and sessions are text-only; there is nothing to call. */}
          {!isAgent && !isSession && (
            <>
              <button className="icon-btn" onClick={onVoiceCall} disabled={!peer.online} title="Voice call">
                <Phone size={19} />
              </button>
              <button className="icon-btn" onClick={onVideoCall} disabled={!peer.online} title="Video call">
                <Video size={19} />
              </button>
            </>
          )}
          {/* The way back in. Everything else here writes a conversation out or
              takes it away; this is the one thing that brings one in, so it sits
              beside them. */}
          {isSession && (
            <button
              className="icon-btn"
              onClick={onImportText}
              title="Upload a saved conversation as text"
              aria-label="Upload a saved conversation as text"
            >
              <Upload size={19} />
            </button>
          )}
          {/* Available for every kind of thread, agents and transcripts too. */}
          <button
            className="icon-btn"
            onClick={onExportHistory}
            title="Save chat history as a text file"
            aria-label="Save chat history as a text file"
          >
            <Download size={19} />
          </button>
          <button
            className="icon-btn danger"
            onClick={onClearHistory}
            title={isSession ? 'Delete this session' : 'Delete chat history'}
            aria-label={isSession ? 'Delete this session' : 'Delete chat history'}
          >
            <Trash size={19} />
          </button>
        </div>
      </div>

      {/* This session had errors swept out of it that named no question, so the
          questions behind them are gone and cannot be put back. Said here rather
          than only in the dialog that removed them: the consequence turns up
          later, at the moment somebody forks from a conversation with holes in
          it, and by then the dialog is a memory.

          Not dismissable, and it does not need to be — asking anything new
          clears it, which is also the thing that fixes what it is warning about. */}
      {isSession && peer.needsContext && (
        <div className="context-warning" role="status">
          <span className="context-warning-mark" aria-hidden="true">
            <Alert size={15} />
          </span>
          <span>
            Errors were removed from this conversation, and the questions they belonged to could not
            be recovered. Reconnect the context before forking from it — ask {thinkerName} something
            to pick the thread back up.
          </span>
        </div>
      )}

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
                  // Branching off a bubble is offered where there is something
                  // that can answer: a session, and the agent threads a session
                  // can be started from. Never in a chat with a person — there
                  // is nothing there to carry a context to.
                  onFork={onFork}
                  onResend={onResend}
                />
              </React.Fragment>
            );
          })}

          {/* Live agent output, replaced by the stored message once the run ends. */}
          {agentStream && <div className="agent-stream">{agentStream}</div>}

          <AgentApproval request={approval} agentName={thinkerName} onAnswer={onApprove} />
        </div>

        {/* Inside the wrapper, so the light behind it reaches the composer instead
            of stopping short and leaving a black band across the bottom. This row
            reserves its height whether or not anything is in it, and a reader sees
            it as part of the conversation rather than as a separate strip. */}
        <div className="typing">
          {working && (
            <>
              {thinks ? `${thinkerName} is ${phrase.toLowerCase()}` : `${peer.name || 'Peer'} is typing`}
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
        onVoice={thinks || !peer.online ? undefined : onVoice}
        // A session with no agent yet has nothing to ask; an agent that is off
        // is the same case reached a different way.
        disabled={isSession ? !peer.agentId : isAgent && !peer.online}
        offline={!isSession && !peer.online}
        canAttach={isSession ? Boolean(peer.agentId) : peer.online && !peer.delegate}
        attachTitle={thinks ? 'Attach a document for the agent to read' : 'Send file, photo or video'}
        placeholder={
          isSession
            ? peer.agentId
              ? `Ask ${thinkerName}…  (Enter to send, Shift+Enter for newline)`
              : 'Choose an agent above to ask something'
            : isAgent
              ? 'Ask the agent…  (Enter to send, Shift+Enter for newline)'
              : undefined
        }
        mentionables={mentionables}
        onSummon={onSummon}
        docs={docs}
        onRemoveDoc={onRemoveDoc}
        // What a fork pinned: shown above the input until it is sent or
        // dismissed, in the same row the document chips use.
        context={context}
        onRemoveContext={onRemoveContext}
      />
    </div>
  );
}
