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
import IdeaShelf from './IdeaShelf.jsx';
import FloorRequest from './FloorRequest.jsx';
import FolderPicker from './FolderPicker.jsx';
import {
  Phone,
  Video,
  Trash,
  Download,
  Upload,
  Sessions,
  Alert,
  Search,
  Stop,
  Pause,
  Play,
} from '../lib/icons.jsx';
import { useQueueLabel } from './QueueBadge.jsx';
import { folderOf } from '../lib/sessionFolders.js';
import { useAgentPhrase } from '../lib/agentPhrase.js';
import { threadHits } from '../lib/findInThread.js';
import { askPlaceholder, thinkingLine, roundSummary } from '../lib/counselCopy.js';
import { paletteFor } from '../lib/agentColor.js';
import { formatDay, platformLabel } from '../lib/util.js';

const GROUP_WINDOW = 4 * 60 * 1000; // group consecutive messages within 4 min

export default function ChatPane({
  peer,
  // What this session's observers have noticed, and the online people who could
  // be invited into it. Both are empty for every thread that is not an observed
  // or Human Like session, and the two surfaces that read them draw nothing at
  // all when they are.
  shelf = [],
  roomPeers = [],
  onDismissIdea,
  onAskIdea,
  // An observer asking to say something, and the three answers to it. Null
  // whenever nothing is asking, which is nearly always.
  floor = null,
  onFloorAction,
  onAnswerInvite,
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
  // Where sessions are filed, and the two ways this one moves between folders.
  // Which folder it is in is derived from the list rather than carried on the
  // session card, so there is one answer to that question rather than two.
  folders = [],
  onPlaceSession = () => {},
  onNewFolderFor = () => {},
  onFork,
  // Putting a question that failed back into the composer. Given on the same
  // threads as onFork, since both only mean anything where a question can be
  // asked.
  onResend,
  // Reading the session aloud from a given turn. Given only by a session with
  // the voice switched on; every other thread passes nothing and the button is
  // not rendered at all.
  onSpeak,
  // Which message is being read, and whether it is stopped on. Narrowed to one
  // bubble below rather than handed to all of them, so exactly one can be lit.
  speakingId,
  speechPaused,
  // Which word of that message is being spoken, or -1. Handed only to the
  // speaking bubble, so the trace never lights a word in the wrong one.
  speakWord,
  approval,
  // Live output, per agent: `[{ agentId, name, text }]`. One string was enough
  // while one agent answered at a time; a counsel has several typing into the
  // same conversation at once, and one string would interleave them into
  // nonsense.
  agentStreams = [],
  // What the session currently has out with its agents: who was asked, who is
  // still thinking, and who is yet to be asked. Null when nothing is in flight.
  round = null,
  // The one that just finished, until the next question replaces it. Separate
  // from `round` because they are different moments and only one is ever set:
  // this is the only view that carries why a discussion stopped, and a round
  // still running has not stopped.
  lastRound = null,
  // Calling off what a session has out. Mainly for a discussion between agents,
  // which is the one thing here that carries on without anybody typing.
  onStopRound,
  // Holding one, and giving the turn back. Different from stopping in the way
  // that matters: the round stays open and keeps the turns it has not spent, so
  // a person can say something into it and let it carry on.
  onPauseRound,
  onResumeRound,
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
  // A room another machine runs. Nothing in it is this window's to change, and
  // nothing in it is this window's to resolve either: its agents are the host's.
  //
  // Every read of the card here is optional-chained. This component is rendered
  // with no thread selected — `peer` is null on the empty state — and a
  // dependency array is evaluated on every render whatever the memo body says.
  const guestRoom = isSession && Boolean(peer?.hostPeerId);

  // Who the host asks, as the host named them. Names with an id beside them, so
  // the chip, the menu, the placeholder and the colours all read the same list —
  // and the id is the same string the host colours by, which is what makes one
  // discussion look like one discussion on both screens.
  const roomCast = useMemo(() => {
    if (!guestRoom) return [];
    const ids = peer.counselIds || [];
    return (peer.agentNames || []).map((name, i) => ({ id: ids[i] || `voice:${name}`, name }));
  }, [guestRoom, peer?.agentNames, peer?.counselIds]);

  // An invitation nobody has answered. The one state in this window where the
  // conversation is not the thing to look at.
  const invited = guestRoom && peer.accepted === false;
  const inviteFrom = useMemo(() => {
    const host = (roomPeers || []).find((p) => p.id === peer?.hostPeerId);
    return (host && (host.name || host.hostname)) || 'Someone';
  }, [roomPeers, peer?.hostPeerId]);

  const counsel = useMemo(() => {
    if (!isSession) return [];
    if (guestRoom) return roomCast;
    if (peer.allAgents) return agents;
    const ids = peer.agentIds || (peer.agentId ? [peer.agentId] : []);
    return ids.map((id) => agents.find((a) => a.id === id)).filter(Boolean);
  }, [isSession, guestRoom, roomCast, peer, agents]);
  const counselNamesList = counsel.map((a) => a.name);
  const thinkerName = isSession ? counselNamesList[0] || 'The agent' : peer?.name || 'The agent';

  // Whether this conversation can be typed into, and whether a document may be
  // staged against what is typed. Two questions, and a room is the one place
  // they have different answers.
  //
  // A session with nobody to ask has nothing to ask; an agent that is off is the
  // same case reached a different way. "Nobody" counts a session set to ask
  // everybody when there is no everybody yet — the standing instruction is fine,
  // there is simply no one here to carry it out. But a room is people as well as
  // agents, so what closes the box there is not an empty counsel: it is an
  // invitation nobody has answered yet.
  //
  // The paper is the other way round. A document staged in a session rides with
  // the question to the agents; a guest's words go to the host and are relayed
  // as text, and that path carries no attachments at all — see the guest branch
  // of send() in main/sessions/index.js. Offering the button would be offering
  // to send something that would be dropped on the way out, silently, after the
  // chips had already been cleared.
  //
  // Both are worked out above the empty-thread return below, so both read the
  // card the way everything else up here does — optional-chained. `peer` is null
  // when no conversation is open, and a const at the top of a component is
  // evaluated on that render too.
  const composerShut = isSession
    ? guestRoom
      ? peer.accepted === false
      : counsel.length === 0
    : isAgent && !peer?.online;
  const canAttach = isSession ? !guestRoom && counsel.length > 0 : peer?.online && !peer?.delegate;

  // A discussion, and whether it is standing still. Both read off the round main
  // publishes rather than worked out here — the round is the only thing that
  // knows, and a window keeping its own answer would disagree with it on exactly
  // the turn where it mattered.
  const discussing = Boolean(round && round.mode === 'dialogue');
  const held = Boolean(discussing && round.paused);

  // A colour for each agent that speaks in this conversation.
  //
  // Built from the counsel *and* from whoever actually answered, because the two
  // are not the same set: an agent taken out of a session, or a peer's that
  // stopped being shared, is no longer in the counsel but its words are still in
  // the transcript, and a reply that loses its colour when its agent leaves is a
  // reply that changes appearance for a reason the reader cannot see.
  //
  // Only in a session. An agent's own thread is one agent's answers, and
  // colouring them says nothing that the thread does not already say.
  //
  // A room somebody else is hosting has no counsel here and never will — its
  // agents are theirs — so its voices are known only from what they have said.
  // `speakerId` is what the host relays instead of an agent id, and it is the
  // same string on both machines, which is what makes one discussion read as the
  // same four colours on every screen watching it.
  const palette = useMemo(() => {
    if (!isSession) return new Map();
    const ids = counsel.map((a) => a.id);
    for (const m of messages) {
      const voice = m.agentId || m.speakerId;
      if (voice && !ids.includes(voice)) ids.push(voice);
    }
    return paletteFor(ids);
  }, [isSession, counsel, messages]);

  // What the round has to say about itself, in the order it said it.
  //
  // While one is running that is only the agents who have dropped out of it —
  // said as they go, because three agents carrying on without a fourth is
  // something to see happen rather than to be told about afterwards. Once it is
  // over, the same lines plus the reason it ended.
  //
  // Only one of the two is ever set: `round` is cleared the moment it closes and
  // `lastRound` is set by the same event, so this never shows a live round's
  // notices above a finished round's ending.
  const roundNotes = useMemo(() => {
    if (round) return (round.notices || []).filter(Boolean);
    if (!lastRound) return [];
    return [...(lastRound.notices || []), roundSummary(lastRound)].filter(Boolean);
  }, [round, lastRound]);

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

  // Keeping the word being read in view, gently. Not by re-centring the bubble on
  // every turn — that moved the conversation out from under the reader — but by
  // nudging only when the spoken word (or, before the first word lands, the
  // bubble) would be off-screen, and then only to the nearest edge. A reading
  // whose word is already visible does not move at all, so a long turn scrolls a
  // line at a time rather than jumping. Keyed on the word as well as the turn, so
  // it follows the trace down the bubble. A search in progress owns the view.
  useEffect(() => {
    if (!speakingId || searchingRef.current) return;
    const scroller = scrollRef.current;
    const bubble = scroller?.querySelector(`[data-speaking-id="${speakingId}"]`);
    if (!scroller || !bubble) return;
    const target = bubble.querySelector('.speak-word') || bubble;
    const box = scroller.getBoundingClientRect();
    const seen = target.getBoundingClientRect();
    const margin = 24;
    if (seen.top < box.top + margin) scroller.scrollTop -= box.top + margin - seen.top;
    else if (seen.bottom > box.bottom - margin) scroller.scrollTop += seen.bottom - (box.bottom - margin);
    // Already comfortably in view: leave it exactly where it is.
  }, [speakingId, speakWord]);

  // Whether a reading is centred on a turn that is not the newest one. While it
  // is, the bottom-pinning below stands down: an agent answering during a
  // read-through of the back catalogue must not yank the view off turn 2 of 6.
  // In a live dialogue the spoken turn *is* the newest, so this is false and
  // pinning behaves exactly as it always did.
  const readingBack =
    Boolean(speakingId) && messages.length > 0 && messages[messages.length - 1]?.id !== speakingId;
  const readingBackRef = useRef(false);
  useEffect(() => {
    readingBackRef.current = readingBack;
  }, [readingBack]);

  useEffect(() => {
    const el = scrollRef.current;
    // Nothing may move the view while a search is walking it, or while a reading
    // is centred on an earlier turn: either would pull the conversation out from
    // under what is being read.
    if (el && !searchingRef.current && !readingBackRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, typing, awaiting]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  // Stable, so a card is not handed a new callback on every render of the pane.
  const keepAtBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el && atBottom.current && !searchingRef.current && !readingBackRef.current)
      el.scrollTop = el.scrollHeight;
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
              <SessionTitle
                title={peer.name}
                guest={guestRoom}
                onRename={(title) => onRenameSession(peer.id, title)}
              />
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
                // A guest is shown the host's cast rather than this machine's:
                // the settings of a shared session are one thing, and a header
                // that read "choose agents…" beside a discussion between three
                // of them was this window describing its own emptiness.
                agents={guestRoom ? roomCast : agents}
                // The same one-agent fallback the counsel above reads, so the
                // ticks in the menu and the name on the chip can never come from
                // two different readings of the same card.
                agentIds={
                  guestRoom
                    ? roomCast.map((a) => a.id)
                    : peer.agentIds || (peer.agentId ? [peer.agentId] : [])
                }
                allAgents={Boolean(peer.allAgents)}
                mode={peer.mode || 'parallel'}
                turns={peer.turns}
                peers={roomPeers}
                members={peer.members || []}
                observer={peer.observer || null}
                guest={Boolean(peer.hostPeerId)}
                onChange={(patch) => onSetCounsel(peer.id, patch)}
              />
              {/* Beside the chip rather than above the composer, because it is
                  not a thing to answer — it is a thing to notice, and the header
                  is where this session's standing facts already live. It draws
                  nothing at all when the shelf is empty, which is most of the
                  time. */}
              <IdeaShelf cards={shelf} onDismiss={onDismissIdea} onAsk={onAskIdea} />
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
          {/* Where this session is filed. First of the session's own actions,
              because it is the one that is about the session rather than about
              its contents — the three after it write the conversation out, bring
              one in, or take it away. */}
          {isSession && (
            <FolderPicker
              folders={folders}
              current={folderOf(folders, peer.id)}
              onPlace={(folderId) => onPlaceSession(peer.id, folderId, null)}
              onNewFolder={() => onNewFolderFor(peer.id)}
            />
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
        {/* An invitation to somebody else's session, waiting to be answered.
            In the middle of the conversation rather than tucked above the
            composer, and drawn as a card that keeps flashing until it is
            answered: an invitation is the one thing in this window that expires
            if nobody notices it, and it was sitting in the quietest strip of the
            screen. It is over the transcript rather than in it — the words of a
            room you have not joined are not yours to scroll through yet. */}
        {invited && (
          <div className="invite-veil">
            <div className="invite-card" role="alertdialog" aria-label="Session invitation">
              <div className="invite-card-mark" aria-hidden="true">
                <Sessions size={22} />
              </div>
              <div className="invite-card-text">
                <strong>{peer.name}</strong>
                <span>{inviteFrom} has invited you to this session.</span>
              </div>
              <div className="invite-card-acts">
                <button type="button" className="floor-act" onClick={() => onAnswerInvite(peer.id, true)}>
                  Join
                </button>
                <button
                  type="button"
                  className="floor-act quiet"
                  onClick={() => onAnswerInvite(peer.id, false)}
                >
                  Decline
                </button>
              </div>
            </div>
          </div>
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
                  color={palette.get(m.agentId || m.speakerId) || null}
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
                  onSpeak={onSpeak}
                  speakState={
                    speakingId && m.id === speakingId ? (speechPaused ? 'paused' : 'playing') : undefined
                  }
                  speakWord={speakingId && m.id === speakingId ? speakWord : undefined}
                  find={searching ? { query, base: bases.get(m.id) || 0, current } : undefined}
                />
              </React.Fragment>
            );
          })}

          {/* Live agent output, replaced by the stored message once the run ends.
              One block per agent, each labelled the way its finished answer will
              be, so a counsel thinking out loud does not arrive as one paragraph
              written by three hands. */}
          {agentStreams.map((s) => {
            // The colour it will finish in, so an agent that is still typing is
            // already identifiable as itself rather than becoming so at the end.
            const colour = palette.get(s.agentId) || null;
            return (
              <div
                className={`agent-stream ${colour ? 'agent' : ''}`}
                key={s.agentId}
                style={colour ? { '--agent-color': colour } : undefined}
              >
                {agentStreams.length > 1 && <div className="bubble-speaker">{s.name}</div>}
                {s.text}
              </div>
            );
          })}

          {/* What the round said about itself: who dropped out of a discussion
              while it ran, and why the whole thing stopped once it had.

              Not messages. Nothing here is written down — it is true about this
              round and noise above the next question — which is the same rule
              the missed-agent notice has always followed. They sit at the foot of
              the conversation because that is where the thing they describe just
              happened. */}
          {roundNotes.length > 0 && (
            <div className="round-notes">
              {roundNotes.map((note, i) => (
                <div className="round-note" key={i}>
                  {note}
                </div>
              ))}
            </div>
          )}

          <AgentApproval request={approval} agentName={thinkerName} onAnswer={onApprove} />
        </div>

        {/* Inside the wrapper, so the light behind it reaches the composer instead
            of stopping short and leaving a black band across the bottom. This row
            reserves its height whether or not anything is in it, and a reader sees
            it as part of the conversation rather than as a separate strip. */}
        <div className="typing">
          {working && (
            <>
              {held
                ? // Held. Nobody is thinking, so saying they are would be the one
                  // thing this row must never do — and the sentence says whose
                  // move it is, because a discussion that stopped with no
                  // explanation is what this whole seam was rebuilt to avoid.
                  'The discussion is holding — say something, or pick it back up'
                : thinks
                  ? // Who is thinking, which in a session may be several at once
                    // and, in relay mode, several more still to be asked. The verb
                    // is the rotating one either way — both this and the round read
                    // the same clock, so they never disagree.
                    thinkingLine(round, phrase.toLowerCase(), thinkerName)
                  : `${peer.name || 'Peer'} is typing`}
              {/* Three staggered dots. The container keeps its height whether or
                  not this is showing, so the message list never jumps. Not while
                  it is held: dots are the sign of something happening, and
                  nothing is. */}
              {!held && (
                <span className="typing-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              )}
              {/* Holding a discussion, and giving it back.
                  Only on a dialogue: it is the only mode that keeps asking after
                  the first lap, and so the only one where waiting is a decision
                  rather than simply what happens next. Subordinate to everything
                  around it — these are escape hatches, not the thing to do. */}
              {discussing && (held ? onResumeRound : onPauseRound) && (
                <button
                  type="button"
                  className="round-stop"
                  onClick={() => (held ? onResumeRound : onPauseRound)(peer.id)}
                  title={
                    held
                      ? 'Give the turn back to the agents'
                      : 'Hold the discussion after this turn — its remaining turns are kept'
                  }
                >
                  {held ? <Play size={11} /> : <Pause size={11} />}
                  {held ? 'Resume' : 'Hold'}
                </button>
              )}
              {/* And the way out of one that is going nowhere. Unlike holding,
                  this spends whatever budget was left. */}
              {discussing && onStopRound && (
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

      {/* An observer asking for the floor. Directly above the composer, because
          it is a decision and the composer is where decisions are made in this
          window — and below the transcript, because nothing it says has been
          said yet. */}
      <FloorRequest
        floor={floor}
        onHear={() => onFloorAction && onFloorAction('hear')}
        onShelf={() => onFloorAction && onFloorAction('shelf')}
        onDismiss={() => onFloorAction && onFloorAction('dismiss')}
      />

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
        // Both worked out above, where there is room to say why each is what it
        // is — see composerShut and canAttach.
        disabled={composerShut}
        offline={!isSession && !peer.online}
        canAttach={canAttach}
        attachTitle={thinks ? 'Attach a document for the agent to read' : 'Send file, photo or video'}
        placeholder={
          isSession
            ? askPlaceholder({
                allAgents: peer.allAgents,
                names: counselNamesList,
                mode: peer.mode,
                discussing,
                held,
                guest: guestRoom,
              })
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
