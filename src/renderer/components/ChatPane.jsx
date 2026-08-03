import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Avatar from './Avatar.jsx';
import Logo from './Logo.jsx';
import MessageBubble from './MessageBubble.jsx';
import Composer from './Composer.jsx';
import AgentApproval from './AgentApproval.jsx';
import AgentFlash from './AgentFlash.jsx';
import SessionTitle from './SessionTitle.jsx';
import FindBar from './FindBar.jsx';
import AgentPicker from './AgentPicker.jsx';
import { Phone, Video, Trash, Download, Upload, Sessions, Alert, Search, Stop } from '../lib/icons.jsx';
import { useQueueLabel } from './QueueBadge.jsx';
import { useAgentPhrase } from '../lib/agentPhrase.js';
import { threadHits } from '../lib/findInThread.js';
import { askPlaceholder, thinkingLine } from '../lib/counselCopy.js';
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
  // A link that is itself a picture: fetched in main, and saved into the
  // downloads folder from the button under it.
  previewImage,
  onSaveImage,
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
  onSetCounsel,
  onImportText,
  onFork,
  // Putting a question that failed back into the composer. Given on the same
  // threads as onFork, since both only mean anything where a question can be
  // asked.
  onResend,
  approval,
  // Live output, per agent: `[{ agentId, name, text }]`. One string was enough
  // while one agent answered at a time; a counsel has several typing into the
  // same conversation at once, and one string would interleave them into
  // nonsense.
  agentStreams = [],
  // What the session currently has out with its agents: who was asked, who is
  // still thinking, and who is yet to be asked. Null when nothing is in flight.
  round = null,
  // Calling off what a session has out. Mainly for a discussion between agents,
  // which is the one thing here that carries on without anybody typing.
  onStopRound,
  onApprove,
  // The connection light: `{ nonce, mode, ms }` while one should be playing, and
  // null the rest of the time. The nonce is what makes a second summon restart it
  // rather than stack a second light on top of the first.
  flash,
  onFlashDone,
  // Whether this conversation can be searched. Settings decides: every thread,
  // or sessions only — the ones long enough that scrolling back through them is
  // the problem this solves.
  canFind = true,
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
  // The agents a session asks, by name, for the indicator and the placeholder.
  // Resolved against the roster rather than read off the record, so an agent that
  // has been removed or is no longer shared drops out of every sentence about
  // this session at once.
  //
  // A card carrying only the single `agentId` is read as a counsel of one. That
  // is the shape everything used before a session could ask more than one, and a
  // pane that understood only the new field would answer an old card by disabling
  // its composer — which is to say, by deciding somebody had no agent because
  // they had exactly one.
  const counsel = useMemo(() => {
    if (!isSession) return [];
    if (peer.allAgents) return agents;
    const ids = peer.agentIds || (peer.agentId ? [peer.agentId] : []);
    return ids.map((id) => agents.find((a) => a.id === id)).filter(Boolean);
  }, [isSession, peer, agents]);
  const counselNamesList = counsel.map((a) => a.name);
  const thinkerName = isSession ? counselNamesList[0] || 'The agent' : peer?.name || 'The agent';

  // ---- find in this conversation ----
  // What is being looked for, and which occurrence of it is being pointed at.
  // All of it lives here rather than in App: a search is a way of reading one
  // conversation, and it ends when you leave.
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const findInput = useRef(null);
  const composerFocus = useRef(null);
  const searching = findOpen && query.trim().length > 0;

  // How many times the word occurs in the whole thread, and where each message's
  // numbering starts. The bubbles work out their own ranges from that, so a
  // message arriving does not re-slice the ones above it.
  const { total, bases } = useMemo(
    () => threadHits(messages, searching ? query : ''),
    [messages, searching, query]
  );
  // Which hit the arrows are on, kept inside the range whatever happens to the
  // conversation underneath — a match can be erased while it is being read.
  const current = total > 0 ? ((index % total) + total) % total : -1;

  const openFind = useCallback(() => {
    setFindOpen(true);
    // The input does not exist yet on the frame the bar opens, so the focus goes
    // in after it lands. Selected rather than merely focused: reaching for find
    // again means looking for something else more often than adding to it.
    requestAnimationFrame(() => {
      const el = findInput.current;
      if (el) {
        el.focus();
        el.select();
      }
    });
  }, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setQuery('');
    // Back to where typing happens. Escape out of a search is nearly always
    // followed by saying something, and leaving the focus on a button that is no
    // longer on screen is leaving it nowhere.
    composerFocus.current?.();
  }, []);

  // A search belongs to the conversation it was made in.
  useEffect(() => {
    setFindOpen(false);
    setQuery('');
    setIndex(0);
  }, [peer?.id]);

  useEffect(() => {
    if (!canFind) return undefined;
    // Command on macOS, Control everywhere else — and only that one. Ctrl+F on a
    // Mac moves the cursor forward a character in a text field, and taking it
    // would break typing in the composer to save a keystroke here.
    const mac = navigator.platform.toLowerCase().includes('mac');
    const onKey = (e) => {
      if (e.altKey || e.key.toLowerCase() !== 'f') return;
      if (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return;
      // The window has its own find, which searches a page that is not this
      // conversation and cannot see the messages that have scrolled away.
      e.preventDefault();
      openFind();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canFind, openFind]);

  // A fresh word starts at the last occurrence, not the first: a conversation is
  // read from the bottom, so the arrows walk back through it from where the
  // reader already is.
  useEffect(() => {
    setIndex(Math.max(0, total - 1));
    // `total` is deliberately not a dependency. It also changes when a message
    // arrives mid-search, and being thrown back to the end of the conversation
    // in the middle of a walk through it is the thing this must not do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, peer?.id]);

  const step = useCallback(
    (by) => setIndex((i) => (total > 0 ? (((i + by) % total) + total) % total : 0)),
    [total]
  );

  // Bringing the current occurrence into view. Centred by measuring rather than
  // with scrollIntoView, which would also scroll whatever contains the pane.
  useEffect(() => {
    if (!searching || current < 0) return;
    const scroller = scrollRef.current;
    const hit = scroller?.querySelector(`[data-hit="${current}"]`);
    if (!scroller || !hit) return;
    const box = scroller.getBoundingClientRect();
    const seen = hit.getBoundingClientRect();
    scroller.scrollTop += seen.top - box.top - (box.height - seen.height) / 2;
  }, [searching, current, total]);

  // Read by the effect below without waking it: closing the bar should leave the
  // reader where they found something, not throw them back to the newest message.
  const searchingRef = useRef(false);
  useEffect(() => {
    searchingRef.current = searching;
  }, [searching]);

  useEffect(() => {
    const el = scrollRef.current;
    // Nothing may move the view while a search is walking it: an agent answering
    // mid-search would otherwise pull the conversation out from under the hit
    // being read.
    if (el && !searchingRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, typing, awaiting]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  // Stable, so a card is not handed a new callback on every render of the pane.
  const keepAtBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el && atBottom.current && !searchingRef.current) el.scrollTop = el.scrollHeight;
  }, []);

  if (!peer) {
    return (
      <div className="chat">
        <div className="center-pane">
          <Logo size={84} />
          <h2>Welcome to LanChat</h2>
          <p>
            Select someone on the left to start chatting. People on your Tailscale mesh or local network who
            run LanChat appear automatically — no servers, no accounts, everything stays on your own devices.
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
              // In an element of its own, so a long name ellipsises instead of
              // squeezing what sits beside it out of the header.
              <span className="peer-name">{peer.name || peer.hostname}</span>
            )}
            {peer.shared && (
              <span className="tag" title="Shared with you from another tailnet">
                shared
              </span>
            )}
            {/* Beside the name of the thing being searched, rather than in the
                row of actions on the right: everything over there does something
                to the whole conversation — writes it out, brings one in, deletes
                it — and this only changes how it is being read. */}
            {canFind && (
              <button
                className={`find-btn ${findOpen ? 'on' : ''}`}
                onClick={() => (findOpen ? closeFind() : openFind())}
                title="Find in this conversation"
                aria-label="Find in this conversation"
                aria-expanded={findOpen}
              >
                <Search size={15} />
              </button>
            )}
          </div>
          {/* Which agent this session asks — the one thing a session has to be
              told, and the only thing that stops it being able to ask. Kept in
              the header rather than behind a dialog because it is read as often
              as it is set. */}
          {isSession ? (
            <div className="sub session-sub">
              <span>Session ·</span>
              <AgentPicker
                agents={agents}
                // The same one-agent fallback the counsel above reads, so the
                // ticks in the menu and the name on the chip can never come from
                // two different readings of the same card.
                agentIds={peer.agentIds || (peer.agentId ? [peer.agentId] : [])}
                allAgents={Boolean(peer.allAgents)}
                mode={peer.mode || 'parallel'}
                turns={peer.turns}
                onChange={(patch) => onSetCounsel(peer.id, patch)}
              />
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
            Errors were removed from this conversation, and the questions they belonged to could not be
            recovered. Reconnect the context before forking from it — ask {thinkerName} something to pick the
            thread back up.
          </span>
        </div>
      )}

      {/* The light lives beside the scroller rather than inside it. Inside, its
          `inset: 0` would resolve against the scrolled content: it would be as
          tall as the whole conversation and would slide away as you read. */}
      <div className="messages-wrap">
        {/* Over the top of the conversation, not above it: the header keeps its
            height, nothing below moves, and the messages stay exactly where the
            reader left them while the bar comes and goes. */}
        {findOpen && (
          <FindBar
            query={query}
            count={total}
            index={current}
            onQuery={setQuery}
            onNext={() => step(1)}
            onPrev={() => step(-1)}
            onClose={closeFind}
            inputRef={findInput}
          />
        )}
        <div className="messages" ref={scrollRef} onScroll={onScroll}>
          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const newDay = !prev || formatDay(prev.ts) !== formatDay(m.ts);
            // Consecutive messages from the same side, close together in time,
            // are drawn as one run with one timestamp. Same *speaker* as well as
            // same side: in a session that asked three agents, two of them
            // answering within four minutes are two answers, and merging them
            // would produce one block with one name on it saying something
            // neither of them said.
            const grouped =
              prev &&
              prev.direction === m.direction &&
              (prev.speaker || null) === (m.speaker || null) &&
              !newDay &&
              m.ts - prev.ts < GROUP_WINDOW &&
              m.kind === 'text';
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
                  previewImage={previewImage}
                  onSaveImage={onSaveImage}
                  onPreviewShown={keepAtBottom}
                  // Branching off a bubble is offered where there is something
                  // that can answer: a session, and the agent threads a session
                  // can be started from. Never in a chat with a person — there
                  // is nothing there to carry a context to.
                  onFork={onFork}
                  onResend={onResend}
                  find={searching ? { query, base: bases.get(m.id) || 0, current } : undefined}
                />
              </React.Fragment>
            );
          })}

          {/* Live agent output, replaced by the stored message once the run ends.
              One block per agent, each labelled the way its finished answer will
              be, so a counsel thinking out loud does not arrive as one paragraph
              written by three hands. */}
          {agentStreams.map((s) => (
            <div className="agent-stream" key={s.agentId}>
              {agentStreams.length > 1 && <div className="bubble-speaker">{s.name}</div>}
              {s.text}
            </div>
          ))}

          <AgentApproval request={approval} agentName={thinkerName} onAnswer={onApprove} />
        </div>

        {/* Inside the wrapper, so the light behind it reaches the composer instead
            of stopping short and leaving a black band across the bottom. This row
            reserves its height whether or not anything is in it, and a reader sees
            it as part of the conversation rather than as a separate strip. */}
        <div className="typing">
          {working && (
            <>
              {thinks
                ? // Who is thinking, which in a session may be several at once
                  // and, in relay mode, several more still to be asked. The verb
                  // is the rotating one either way — both this and the round read
                  // the same clock, so they never disagree.
                  thinkingLine(round, phrase.toLowerCase(), thinkerName)
                : `${peer.name || 'Peer'} is typing`}
              {/* Three staggered dots. The container keeps its height whether or
                  not this is showing, so the message list never jumps. */}
              <span className="typing-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              {/* The way out of a discussion that is going nowhere.
                  Only on a dialogue: it is the only mode that keeps asking after
                  the first lap, and so the only one where waiting is a decision
                  rather than simply what happens next. Subordinate to everything
                  around it — this is an escape hatch, not the thing to do. */}
              {round && round.mode === 'dialogue' && onStopRound && (
                <button
                  type="button"
                  className="round-stop"
                  onClick={() => onStopRound(peer.id)}
                  title="End the discussion after this turn"
                >
                  <Stop size={11} />
                  Stop
                </button>
              )}
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
        // A session with nobody to ask has nothing to ask; an agent that is off
        // is the same case reached a different way. "Nobody" counts a session set
        // to ask everybody when there is no everybody yet — the standing
        // instruction is fine, there is simply no one here to carry it out.
        disabled={isSession ? counsel.length === 0 : isAgent && !peer.online}
        offline={!isSession && !peer.online}
        canAttach={isSession ? counsel.length > 0 : peer.online && !peer.delegate}
        attachTitle={thinks ? 'Attach a document for the agent to read' : 'Send file, photo or video'}
        placeholder={
          isSession
            ? askPlaceholder({ allAgents: peer.allAgents, names: counselNamesList, mode: peer.mode })
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
        focusRef={composerFocus}
      />
    </div>
  );
}
