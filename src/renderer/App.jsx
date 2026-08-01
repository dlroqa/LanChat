import React, { useEffect, useMemo, useRef, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import ChatPane from './components/ChatPane.jsx';
import SearchResults from './components/SearchResults.jsx';
import CallOverlay from './components/CallOverlay.jsx';
import IncomingCall from './components/IncomingCall.jsx';
import ProfileModal from './components/ProfileModal.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import KeyChangeModal from './components/KeyChangeModal.jsx';
import DevPasswordModal from './components/DevPasswordModal.jsx';
import DevPanel from './components/DevPanel.jsx';
import AddPeerModal from './components/AddPeerModal.jsx';
import UpdatePrompt from './components/UpdatePrompt.jsx';
import UpdateBanner from './components/UpdateBanner.jsx';
import ErrorSweepModal, { findKeptErrors, findSummonLeftovers } from './components/ErrorSweepModal.jsx';
import { CallManager } from './lib/rtc.js';
import { Ringer, playNotification, playCallEvent, playPttCue, playRejectCue } from './lib/sounds.js';
import ConnectionPanel from './components/ConnectionPanel.jsx';
import PttBar from './components/PttBar.jsx';
import { PttManager, attachPttKey, defaultPttKey } from './lib/ptt.js';
import GroupCallView from './components/GroupCallView.jsx';
import GroupInvite from './components/GroupInvite.jsx';
import NewGroupCallModal from './components/NewGroupCallModal.jsx';
import { GroupCallManager } from './lib/groupCall.js';
import { listDevices, labelFor } from './lib/devices.js';
import { isSessionThread, isThinkingThread } from './lib/sessionIds.js';
import { isAgentThread } from './lib/agentPhrase.js';
import { commitCount } from './lib/sessionStanding.js';
import { flashDuration, prefersReducedMotion } from './lib/connectFlash.js';
import { useAgentMusic } from './lib/agentMusic.js';
import { trackUrl, DEFAULT_TRACK } from './lib/agentMusicTrack.js';

const api = window.lanchat;

// How long a turn-queue notice stays on screen. It is never written to history,
// so this is only about when the bubble goes — a saved conversation is clean
// either way, even if the app is closed while one is still showing.
const NOTICE_TTL_MS = 60000;

// How long a refused message stays on screen before it is taken away.
//
// Long enough to see it appear and be removed — the point is that you watch it
// go, so it is unmistakably your message that was refused and not some general
// complaint about the queue. Any shorter and it reads as a send that failed to
// render at all.
const REJECT_LINGER_MS = 900;

// How long a failed run stays on screen before it erases itself.
//
// Shorter than a queue notice, and counted down in the open rather than swept
// quietly, because this one is worth reading and then worth losing: a timeout
// kept in the thread becomes a permanent line of noise in the context of every
// question asked below it. Ten seconds is long enough to read the sentence and
// press re-send, and the question itself stays either way.
const ERROR_TTL_MS = 10000;

// How long the bubble takes to come apart once the count reaches zero. Removal
// is driven by this timer and never by `animationend`: reduced motion disables
// the animation outright (styles.css), and an event that never fires would leave
// the error on screen forever — the one outcome this whole feature exists to
// prevent.
const DISSOLVE_MS = 620;

// One shared empty list for threads with nothing attached, so the composer is
// not handed a brand-new array on every render of a conversation.
const EMPTY_DOCS = [];
// The same trick for live agent output: one shared empty array, so a thread with
// nothing streaming into it hands the pane the same reference every render.
const EMPTY_STREAMS = [];

// Ids for bubbles that only ever exist in this window. Counted rather than
// randomised because nothing outside this process will ever see one, and a
// counter cannot collide with itself the way two calls in the same millisecond
// can.
let localId = 0;
const nextLocalId = () => `local-${(localId += 1)}`;

export default function App() {
  const [self, setSelf] = useState(null);
  const [, setConfigured] = useState(true);
  const [config, setConfig] = useState({ iceServers: [], enableTailscale: true, enableLan: true });
  const [peers, setPeers] = useState([]);
  // Which agents each peer is sharing with us: `ownerPeerId -> [{ id, name }]`.
  //
  // Deliberately not derived from `peers`. An agent shared without direct chat is
  // routable by `@name` and is *not* a contact, so the roster holds a strict
  // subset of what a mention can reach — reading it left the `@` menu empty until
  // the agent had been summoned once. Main publishes the real set; see
  // sharedBy() in agents/remote.js.
  const [peerAgents, setPeerAgents] = useState({});
  const [tailnet, setTailnet] = useState([]);
  const [tailnetStatus, setTailnetStatus] = useState({ ok: true, reason: null });
  const [selectedId, setSelectedId] = useState(null);
  const [messages, setMessages] = useState({}); // peerId -> [msg]
  const [typing, setTyping] = useState({});
  const [unread, setUnread] = useState({});
  // Agents summoned and not yet opened: `threadId -> true`. Separate from
  // `unread`, which counts messages — a summon produces none, so an unread count
  // would stay at nought and the row would say nothing happened.
  const [summoned, setSummoned] = useState({});
  // A session found to be holding errors an older version kept:
  // `{ threadId, ids }` while the offer to remove them is on screen.
  const [sweep, setSweep] = useState(null);
  const [progress, setProgress] = useState({});
  const [toasts, setToasts] = useState([]);
  const [modal, setModal] = useState(null); // 'profile' | 'devgate' | 'devpanel' | 'settings' | 'addpeer'
  // A pinned peer arriving with a different key, and the reasons peers were
  // turned away. Neither is acted on automatically.
  const [keyAlarm, setKeyAlarm] = useState(null);
  const [authFailures, setAuthFailures] = useState({});
  const [firstRun, setFirstRun] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [call, setCall] = useState({ status: 'idle' });
  const [linkStats, setLinkStats] = useState({}); // peerId -> stats
  const [callFullscreen, setCallFullscreen] = useState(false);
  const [pipMode, setPipMode] = useState(false);
  const [ptt, setPtt] = useState({ transmitting: false, connecting: false, talkers: [], inboundStreams: [] });
  const [group, setGroup] = useState({ status: 'idle', participants: [], count: 0 });
  const [agentStatus, setAgentStatus] = useState({}); // agentId -> {status, detail}
  const [approvals, setApprovals] = useState({}); // agentId -> pending approval request
  const [awaiting, setAwaiting] = useState({}); // agent thread -> we asked and have not heard back
  // What a session currently has out with its agents, keyed by session id.
  //
  // Pushed from main, which is the only place that knows: it decides who is
  // asked and when, and a window that reassembled this out of typing, delta,
  // chat and empty events would be a second implementation of the same
  // bookkeeping — wrong in exactly the moments that matter, which is three
  // agents thinking at once and one of them going quiet.
  const [rounds, setRounds] = useState({}); // sessionId -> round view
  // Live output while it is being written, per thread and then per agent.
  //
  // One string per thread was enough while one agent answered at a time. A
  // counsel has several writing into the same conversation at once, and one
  // string would splice them into a paragraph none of them wrote.
  const [streams, setStreams] = useState({}); // threadId -> { agentId: text }
  const [update, setUpdate] = useState(null); // full modal: download/install flow
  const [updateBanner, setUpdateBanner] = useState(null); // subtle top-centre notice
  const [queued, setQueued] = useState({}); // peerId -> messages waiting to send
  // Text handed back to the composer after a refused send, so a refusal never
  // costs somebody the sentence they wrote. The nonce is what makes asking twice
  // with the same words restore twice.
  const [draft, setDraft] = useState(null); // { threadId, text, nonce }
  // Documents staged against the next message to an agent. Keyed by thread, so
  // switching away and back finds what you had queued up still waiting — and so
  // a file dropped on one agent never goes to another.
  const [attachments, setAttachments] = useState({}); // threadId -> [{ path, name, bytes }]
  // Sessions: local workspaces, each with a title, an agent and a conversation.
  // The list comes from main and is republished whenever it changes there, so
  // this window never has to guess at it.
  const [sessions, setSessions] = useState([]);
  // The search box: what was typed, and which category it is aimed at. It lives
  // here rather than in the sidebar because what it finds is shown in the middle
  // panel — one search, read in two places.
  //
  // Deliberately not saved: the arrangement of the panel is a setting, a search
  // is a moment. Opening the app into a filter set days ago, with most of the
  // roster missing and no memory of why, is a trap.
  const [search, setSearch] = useState({ q: '', scope: 'all' });
  // What a fork pinned, per thread: the excerpt the next question carries. Kept
  // beside the documents because it is the same kind of thing — something staged
  // against a message that has not been written yet.
  const [contexts, setContexts] = useState({}); // threadId -> { text, speaker, ts }
  // The connection light, per thread: { nonce, mode, ms }. The nonce is what makes
  // summoning twice play it twice, and what makes the second play replace the
  // first rather than run alongside it. `ms` is resolved once, when the trigger
  // fires — resolving it while rendering would hand the component a different
  // number on every re-render and the light would end at an unpredictable moment.
  const [flash, setFlash] = useState({}); // threadId -> { nonce, mode, ms }

  const configRef = useRef(config);
  const laterDismissedRef = useRef(null); // update version dismissed with "Later" this session
  const selectedRef = useRef(selectedId);
  const knownPeers = useRef({});
  const peersRef = useRef([]);
  const typingTimers = useRef({});
  const noticeTimers = useRef({}); // message id -> removal timer for a transient notice
  const callRef = useRef(null);
  const ringerRef = useRef(null);
  const pttRef = useRef(null);
  const groupRef = useRef(null);
  const inCallRef = useRef(false);
  const groupActiveRef = useRef(false);
  const selectedPeerRef = useRef(null);
  const selfRef = useRef(null);
  const loadedPeers = useRef(new Set());
  // Sessions whose history has already been scanned for errors an older version
  // kept. Asked once per session per run: declining is an answer, and re-asking
  // it every time the conversation is reopened would make it a nag.
  const sweepOffered = useRef(new Set());
  // Agent threads whose summon leftovers have already been counted down this run.
  // Once per thread: the countdown is a thing you watch happen, not something to
  // start again every time you come back to the conversation.
  const erasedThreads = useRef(new Set());

  configRef.current = config;
  selectedRef.current = selectedId;
  selfRef.current = self;

  // --- Call manager + ringer (created once) ---
  if (!callRef.current) {
    callRef.current = new CallManager({
      sendSignal: (peerId, signal) => api.sendSignal(peerId, signal),
      onState: (s) => setCall(s),
      getIceServers: () => configRef.current.iceServers || [],
      getSelfName: () => selfRef.current?.name || null,
      onError: (msg) => toast(msg, 'error'),
      onPeerLeft: (name) => announceLeft(name),
      getDevices: () => ({
        audioInputId: configRef.current.audioInputId || null,
        videoInputId: configRef.current.videoInputId || null,
      }),
      // Only read for a support session's answer (see rtc.js accept()) — a
      // read-only label readout for the developer, never a way to change the
      // other side's settings remotely.
      getDeviceLabels: async () => {
        const { audioInputs, videoInputs } = await listDevices();
        const mic = audioInputs.find((d) => d.deviceId === configRef.current.audioInputId) || audioInputs[0];
        const camera = videoInputs.find((d) => d.deviceId === configRef.current.videoInputId) || videoInputs[0];
        return {
          mic: mic ? labelFor(mic, audioInputs.indexOf(mic), 'Microphone') : null,
          camera: camera ? labelFor(camera, videoInputs.indexOf(camera), 'Camera') : null,
        };
      },
    });
  }
  if (!ringerRef.current) ringerRef.current = new Ringer();
  if (!groupRef.current) {
    groupRef.current = new GroupCallManager({
      sendSignal: (peerId, signal) => api.sendSignal(peerId, signal),
      onState: (s) => setGroup(s),
      getIceServers: () => configRef.current.iceServers || [],
      getDevices: () => ({
        audioInputId: configRef.current.audioInputId || null,
        videoInputId: configRef.current.videoInputId || null,
      }),
      getSelf: () => ({ id: selfRef.current?.id || null, name: selfRef.current?.name || null }),
      isBusy: () => inCallRef.current, // a 1:1 call is in progress
      onError: (msg) => toast(msg, 'error'),
      onPeerLeft: (name) => announceLeft(name),
    });
  }
  if (!pttRef.current) {
    pttRef.current = new PttManager({
      sendSignal: (peerId, signal) => api.sendSignal(peerId, signal),
      onState: (s) => setPtt(s),
      getIceServers: () => configRef.current.iceServers || [],
      getDevices: () => ({ audioInputId: configRef.current.audioInputId || null }),
      onError: (msg) => toast(msg, 'error'),
      // Radio-style beeps: a local "go ahead" tone when we key up, a short
      // "incoming" tone when a peer starts talking at us.
      onCue: (kind) => playPttCue(kind, { volume: configRef.current.notificationVolume ?? 0.6 }),
    });
  }

  // Ring while a call is pending; stop the moment it connects or ends.
  useEffect(() => {
    const ringer = ringerRef.current;
    const opts = {
      ringtone: configRef.current.ringtone || 'classic',
      volume: configRef.current.ringtoneVolume ?? 0.8,
      customUrl: soundUrl(configRef.current.customRingtonePath),
    };
    if (call.status === 'incoming' || group.status === 'invited') ringer.start('incoming', opts);
    else if (call.status === 'outgoing' || group.status === 'inviting') ringer.start('outgoing', opts);
    else ringer.stop();
    // Keyed on the two statuses and nothing else, deliberately. Everything the
    // ringer needs is read from a ref at the moment it starts, so there is
    // nothing stale to capture — and adding `soundUrl` would re-run this on
    // every render, restarting the ring tone under the person answering.
    // (It is also declared below this point, so naming it here would be a
    // temporal-dead-zone error during render, not merely noisy.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call.status, group.status]);

  useEffect(() => {
    if (call.status === 'idle') setCallFullscreen(false);
  }, [call.status]);

  // Never leave a tone playing if the window closes mid-ring.
  useEffect(() => () => ringerRef.current?.stop(), []);

  // Hold-to-talk. Disabled during a normal call so the two cannot fight over
  // the microphone.
  useEffect(() => {
    const keyName = config.pttKey || defaultPttKey();
    return attachPttKey({
      keyName,
      customCode: config.pttCustomCode,
      isEnabled: () =>
        config.pttEnabled !== false &&
        call.status === 'idle' &&
        Boolean(selectedPeerRef.current && selectedPeerRef.current.online),
      onDown: () => pttRef.current.setTransmitting(true, selectedPeerRef.current),
      onUp: () => pttRef.current.setTransmitting(false),
    });
  }, [config.pttKey, config.pttCustomCode, config.pttEnabled, call.status]);

  useEffect(() => () => pttRef.current?.closeAll(), []);
  useEffect(() => () => groupRef.current?.leave(), []);

  function announceLeft(name) {
    playCallEvent('leave', { volume: configRef.current.notificationVolume ?? 0.6 });
    if (name) toast(`${name} left the call`);
  }

  function toast(text, level = 'info') {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, text, level }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }

  function removeMessage(peerId, id) {
    setMessages((prev) => ({ ...prev, [peerId]: (prev[peerId] || []).filter((m) => m.id !== id) }));
  }

  // Changes one bubble in place. A message with no matching id is left alone
  // rather than appended: this is only ever used to say something more about a
  // message already on screen.
  function patchMessage(peerId, id, patch) {
    setMessages((prev) => {
      const list = prev[peerId];
      if (!list) return prev;
      const idx = list.findIndex((m) => m.id === id);
      if (idx < 0) return prev;
      const next = [...list];
      next[idx] = { ...next[idx], ...patch };
      return { ...prev, [peerId]: next };
    });
  }

  // Play the light on a thread. Every call plays it — there is no dedupe, because
  // summoning an agent twice is asking twice and both times deserve an answer.
  function showFlash(threadId, mode) {
    if (!threadId) return;
    const ms = flashDuration(mode, prefersReducedMotion());
    setFlash((f) => ({ ...f, [threadId]: { nonce: nextLocalId(), mode, ms } }));
  }

  function clearFlash(threadId) {
    setFlash((f) => (f[threadId] ? { ...f, [threadId]: null } : f));
  }

  // The streamed preview one agent was writing, once its finished answer has
  // arrived — or once it has finished with nothing to show.
  //
  // One agent's, not the thread's. In a session the others may still be writing,
  // and clearing the thread would blank two live previews because a third one
  // ended. An event with no agent on it is from before this was per-agent, so it
  // clears the lot: that is the old behaviour, which is right for a thread that
  // only ever has one writer in it.
  function clearStream(threadId, agentId) {
    if (!threadId) return;
    setStreams((s) => {
      if (!s[threadId]) return s;
      if (!agentId) return { ...s, [threadId]: {} };
      if (!s[threadId][agentId]) return s;
      const { [agentId]: _done, ...rest } = s[threadId];
      return { ...s, [threadId]: rest };
    });
  }

  function appendMessage(peerId, msg) {
    setMessages((prev) => {
      const list = prev[peerId] ? [...prev[peerId]] : [];
      const idx = list.findIndex((m) => m.id === msg.id);
      if (idx >= 0) list[idx] = { ...list[idx], ...msg };
      else list.push(msg);
      return { ...prev, [peerId]: list };
    });
    // The turn system's own messages — "your turn", "you are #2 in line" — are
    // worth reading once and nothing afterwards. They are shown like any other
    // message and then taken away, so the thread keeps only what was really
    // said. Nothing to undo on disk: main never stored them.
    //
    // A failed run is swept the same way, but sooner and in the open: the bubble
    // says how long it has left, and then comes apart rather than blinking out.
    // Main never stored it either, so there is nothing to undo here — and the
    // question it failed is marked in the same breath, so the commit box stops
    // counting it the moment the error appears rather than after a reload.
    //
    // Except in a session, where the question may have been put to several agents
    // and one of them failing says nothing about whether it was answered. There
    // the mark is main's to make, once the whole round is in — see closeRound in
    // sessions/index.js — and it arrives on the closing round rather than here.
    if (msg.error) {
      if (!noticeTimers.current[msg.id]) {
        if (msg.failedRef && !isSessionThread(peerId)) patchMessage(peerId, msg.failedRef, { failed: true });
        noticeTimers.current[msg.id] = setTimeout(() => {
          patchMessage(peerId, msg.id, { dissolving: true });
          noticeTimers.current[msg.id] = setTimeout(
            () => {
              delete noticeTimers.current[msg.id];
              removeMessage(peerId, msg.id);
            },
            prefersReducedMotion() ? 0 : DISSOLVE_MS
          );
        }, ERROR_TTL_MS);
      }
      // An error also arrives flagged as a notice, because main stores neither.
      // It must not pick up the 60-second sweep as well: the countdown on screen
      // would then be promising something a second timer had already done.
      return;
    }
    if (msg.notice && !noticeTimers.current[msg.id]) {
      noticeTimers.current[msg.id] = setTimeout(() => {
        delete noticeTimers.current[msg.id];
        removeMessage(peerId, msg.id);
      }, NOTICE_TTL_MS);
    }
  }

  // --- Initial load ---
  useEffect(() => {
    (async () => {
      const state = await api.getState();
      setSelf(state.identity);
      setConfigured(state.configured);
      setConfig(state.config);
      setPeers(state.presence || []);
      setPeerAgents(state.peerAgents || {});
      // Sessions are local and always there, so the list is read once at start
      // and kept current by the `sessions` event rather than polled.
      api.listSessions().then((list) => setSessions(list || []));
      // Windows only: start from whatever has already been measured, rather than
      // an empty panel until the next round trip lands. A window opened from the
      // tray after hours of uptime should not look like a link that has never
      // been measured. Elsewhere the panel fills from live events as it always
      // has.
      if (state.identity?.platform === 'win32') {
        try {
          const stats = await api.linkStats();
          if (Array.isArray(stats) && stats.length) {
            setLinkStats(Object.fromEntries(stats.filter(Boolean).map((s) => [s.peerId, s])));
          }
        } catch {
          // Nothing measured yet — the live events fill this in.
        }
      }
      if (!state.configured) {
        setFirstRun(true);
        setModal('profile');
      }
    })();
  }, []);

  // --- Event stream from main ---
  useEffect(() => {
    const off = api.onEvent((evt) => {
      const { type, payload } = evt;
      switch (type) {
        case 'presence': {
          // An agent thread you are looking at coming alive — switched on, or its
          // owner reappearing. The summon path has its own trigger; this is the
          // same moment arrived at some other way.
          //
          // Only for the thread on screen, and never queued for later: a light
          // replayed on a thread opened an hour afterwards would be claiming a
          // connection happened just now.
          const before = peersRef.current;
          const open = selectedRef.current;
          if (open) {
            const was = before.find((p) => p.id === open);
            const now = payload.find((p) => p.id === open);
            if (now && now.kind === 'agent' && now.online && !(was && was.online)) {
              showFlash(open, 'connected');
            }
          }
          setPeers(payload);
          peersRef.current = payload;
          payload.forEach((p) => (knownPeers.current[p.id] = p));
          break;
        }
        case 'tailnet-peers':
          setTailnet(payload);
          break;
        // Sent whenever a peer advertises or withdraws an agent, or goes away
        // taking theirs with them. The whole map each time, so there is no
        // incremental state here to fall out of step with main's.
        case 'peer-agents':
          setPeerAgents(payload || {});
          break;
        case 'outbox-counts':
          setQueued(payload);
          break;
        case 'tailnet-status':
          setTailnetStatus(payload);
          break;
        case 'pip':
          setPipMode(Boolean(payload));
          break;
        case 'link-stats':
          setLinkStats((m) => ({ ...m, [payload.peerId]: payload }));
          break;
        case 'identity':
          setSelf(payload);
          break;
        case 'select-peer':
          // Opened from the status-menu item.
          setSelectedId(payload);
          break;
        case 'start-call': {
          // Call shortcut from the status menu.
          const target =
            peersRef.current.find((p) => p.id === payload.peerId) || knownPeers.current[payload.peerId];
          if (!target || !target.online) {
            toast('That person is offline', 'error');
            break;
          }
          setSelectedId(payload.peerId);
          callRef.current
            .start(target, Boolean(payload.withVideo))
            .catch((err) => toast(`Cannot start call: ${err.message}`, 'error'));
          break;
        }
        case 'peer-hello':
          if (payload.identity) knownPeers.current[payload.peerId] = payload.identity;
          break;
        case 'chat':
          appendMessage(payload.peerId, payload);
          // The finished reply supersedes the streamed preview. A session gets
          // the stream under its own id, so it ends the same way — but only the
          // stream belonging to the agent that just answered: the others in the
          // counsel are still writing.
          if (payload.peerId.startsWith('agent:') || isSessionThread(payload.peerId)) {
            clearStream(payload.peerId, payload.agentId);
            setApprovals((a) => (a[payload.peerId] ? { ...a, [payload.peerId]: null } : a));
          }
          // An answer — or a refusal explaining the queue — ends the wait. Not in
          // a session, where the wait is the whole round and one answer of three
          // does not end it; there it is the closing round that says so.
          if (payload.direction === 'in' && isThinkingThread(payload.peerId) && !isSessionThread(payload.peerId)) {
            setAwaiting((a) => (a[payload.peerId] ? { ...a, [payload.peerId]: false } : a));
          }
          if (payload.direction === 'in') {
            const cfg = configRef.current;
            if (!cfg.muteNotifications) {
              playNotification(cfg.notificationSound || 'ping', {
                volume: cfg.notificationVolume ?? 0.7,
                customUrl: soundUrl(cfg.customNotificationPath),
              });
            }
            // A notice still pings — being told your turn came round is the
            // whole point — but it does not raise the unread count, which
            // would otherwise end up pointing at a message that has since
            // taken itself away.
            if (payload.peerId !== selectedRef.current && !payload.notice) {
              setUnread((u) => ({ ...u, [payload.peerId]: (u[payload.peerId] || 0) + 1 }));
            }
          }
          break;
        case 'typing':
          setTyping((t) => ({ ...t, [payload.peerId]: payload.isTyping }));
          clearTimeout(typingTimers.current[payload.peerId]);
          // A person types in bursts and keeps re-sending, so their indicator is
          // expired if the frames stop. An agent says "working" once and may
          // then think for a minute, and says "done" explicitly — expiring that
          // made the indicator vanish seconds into every reply.
          if (payload.isTyping && !isThinkingThread(payload.peerId)) {
            typingTimers.current[payload.peerId] = setTimeout(
              () => setTyping((t) => ({ ...t, [payload.peerId]: false })),
              4000
            );
          }
          break;
        case 'signal': {
          const sig = payload.signal;
          // Each real-time feature rides its own channel so they never collide.
          if (sig && sig.channel === 'ptt') {
            if (configRef.current.pttAllowIncoming !== false) {
              pttRef.current.handleSignal(payload.peerId, sig);
            }
          } else if (sig && sig.channel === 'group') {
            // Refuse a group invite while a 1:1 call is active.
            if (inCallRef.current && sig.kind === 'invite') {
              api.sendSignal(payload.peerId, { channel: 'group', roomId: sig.roomId, kind: 'decline' });
            } else {
              groupRef.current.handleSignal(payload.peerId, sig);
            }
          } else if (groupActiveRef.current && sig && sig.kind === 'offer') {
            // Busy: a group call is running, so refuse an incoming 1:1 call.
            api.sendSignal(payload.peerId, { kind: 'busy', callId: sig.callId });
          } else {
            callRef.current.handleSignal(payload.peerId, sig);
          }
          break;
        }
        case 'file-offer':
          // Placeholder bubble so incoming transfers show up with progress.
          appendMessage(payload.peerId, {
            id: payload.transferId,
            peerId: payload.peerId,
            direction: 'in',
            kind: 'file',
            file: { name: payload.name, size: payload.size, mime: payload.mime, path: null },
            ts: Date.now(),
            pending: true,
          });
          break;
        case 'file-progress': {
          const key = payload.transferId;
          const frac = payload.total ? payload.received / payload.total : 0;
          setProgress((p) => ({ ...p, [key]: frac }));
          break;
        }
        case 'agent-status':
          setAgentStatus((s) => ({ ...s, [payload.agentId]: payload }));
          if (payload.status === 'error') toast(`Agent: ${payload.detail}`, 'error');
          break;
        case 'peer-key-alarm':
          // Held, never acted on. Accepting a changed key is a separate,
          // deliberate step — see KeyChangeModal for why this is not a prompt
          // that can be dismissed into acceptance.
          if (payload.reason === 'key-changed') setKeyAlarm(payload);
          break;
        case 'peer-auth-failed':
          // The roster explains itself rather than the peer simply vanishing.
          // Both cases below were refused identically; only the wording differs.
          setAuthFailures((f) => ({ ...f, [payload.peerId || payload.address]: payload.reason }));
          break;
        case 'agent-approval':
          // Never auto-answered — it sits until the local user decides.
          setApprovals((a) => ({ ...a, [payload.agentId]: payload }));
          setSelectedId(payload.agentId);
          break;
        case 'agent-delta': {
          // Live typing; the authoritative reply arrives as a normal 'chat' event.
          // Filed under the thread that asked, which is the agent's own id unless
          // a session did — see deliver() in main's agents/index.js — and under
          // the agent within it, so several of them writing at once stay apart.
          const into = payload.threadId || payload.agentId;
          const who = payload.agentId || into;
          setStreams((s) => ({
            ...s,
            [into]: { ...s[into], [who]: (s[into]?.[who] || '') + payload.delta },
          }));
          break;
        }
        // The list of sessions changed — one was started, renamed, pointed at
        // other agents, or deleted.
        case 'sessions':
          setSessions(payload || []);
          break;
        // Where a session's question stands. Arrives whenever anything about the
        // round changes and once more as it closes; the closed one is what ends
        // the wait, because one answer out of three does not.
        case 'session-round':
          setRounds((r) => {
            if (!payload.open) {
              const { [payload.sessionId]: _gone, ...rest } = r;
              return rest;
            }
            return { ...r, [payload.sessionId]: payload };
          });
          if (!payload.open) {
            setAwaiting((a) => (a[payload.sessionId] ? { ...a, [payload.sessionId]: false } : a));
            setStreams((s) => (s[payload.sessionId] ? { ...s, [payload.sessionId]: {} } : s));
            // Nobody had anything to say. The light stands where the answers
            // would have been — once for the round, not once per silent agent.
            if (!payload.answered.length && !payload.failed.length) showFlash(payload.sessionId, 'empty');
            // A question the whole counsel failed to answer stops counting as one.
            // Main decides that, at the end, and names the question it decided
            // about; the window is told rather than working it out from an error
            // that only ever knew about one agent.
            if (payload.failedRef) patchMessage(payload.sessionId, payload.failedRef, { failed: true });
          }
          break;
        // A run came back with nothing in it. There is no message, so the light is
        // the whole of what is shown — and because no 'chat' event is coming, the
        // clears that event normally does have to happen here instead. Without
        // them the thread would sit saying the agent was still thinking, forever.
        //
        // In a session the round owns both: the wait ends when the round does,
        // and the light is shown once for a round nobody answered rather than
        // once for each agent that had nothing to say.
        case 'agent-empty':
          clearStream(payload.peerId, payload.agentId);
          if (!isSessionThread(payload.peerId)) {
            setAwaiting((a) => (a[payload.peerId] ? { ...a, [payload.peerId]: false } : a));
            showFlash(payload.peerId, 'empty');
          }
          break;
        case 'update-available':
          // A subtle top-centre banner rather than a blocking modal, so it can
          // appear at any time while the app is open without interrupting.
          // Suppressed for a release the user explicitly skipped, or dismissed
          // with "Later" this session; first-run setup hides it in the render.
          if (
            payload.latest !== configRef.current.skippedUpdateVersion &&
            payload.latest !== laterDismissedRef.current
          ) {
            setUpdateBanner(payload);
          }
          break;
        case 'toast':
          toast(payload.text, payload.level);
          break;
        default:
          break;
      }
    });
    return () => {
      off();
      for (const timer of Object.values(noticeTimers.current)) clearTimeout(timer);
      noticeTimers.current = {};
    };
    // Subscribed once, for the life of the window. The handlers reach state
    // through setters and refs rather than closing over it, so there is nothing
    // to refresh; listing them would tear down and re-establish the whole event
    // subscription on every render, and events arriving in that gap would be
    // dropped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror total unread onto the status-menu item and app badge.
  useEffect(() => {
    const total = Object.values(unread).reduce((a, b) => a + (b || 0), 0);
    api.setUnread(total);
  }, [unread]);

  // --- Load history when selecting a peer ---
  useEffect(() => {
    if (!selectedId) return;
    // A refused message was handed back to the composer; leaving the offer
    // standing would push it in again on the way back to this thread, over
    // whatever had been typed since.
    setDraft(null);
    setUnread((u) => ({ ...u, [selectedId]: 0 }));
    // Opening the thread is what the pulse was asking for, so it stops here.
    // Cleared on selection rather than on a timer: it is not an announcement that
    // expires, it is a thing waiting to be looked at.
    setSummoned((s) => (s[selectedId] ? { ...s, [selectedId]: false } : s));
    if (loadedPeers.current.has(selectedId)) return;
    loadedPeers.current.add(selectedId);
    const thread = selectedId;
    api.getHistory(thread).then((hist) => {
      setMessages((prev) => ({ ...prev, [thread]: mergeHistory(hist, prev[thread]) }));
      // The summon lines and greetings older builds left in an agent thread. Not
      // offered the way errors are — there is nothing in them to read and decide
      // about — so they are shown once, counted down in the open, and gone.
      if (isAgentThread(thread)) eraseSummonLeftovers(thread, hist);
      // Errors an older version kept. Only in sessions — the commit correction
      // that goes with removing them has nowhere to live on any other thread —
      // and only once per session per run, so declining is not asked again every
      // time the conversation is reopened.
      if (!isSessionThread(thread) || sweepOffered.current.has(thread)) return;
      sweepOffered.current.add(thread);
      const found = findKeptErrors(hist);
      if (found.length) setSweep({ threadId: thread, ids: found.map((m) => m.id) });
    });
  }, [selectedId]);

  // A question this session already has out, for a window that missed it being
  // asked.
  //
  // Round state is pushed as it changes, which is enough for a window that was
  // open when the question went. It is not enough for one that was reloaded
  // while three agents were thinking: main is still running, the answers are
  // still coming, and a pane that knew nothing about the round would sit there
  // claiming nothing was happening until they landed. Asked for once, on opening
  // a session that has no round in hand.
  useEffect(() => {
    if (!isSessionThread(selectedId) || rounds[selectedId]) return undefined;
    let live = true;
    api.sessionRound(selectedId).then((round) => {
      if (!live || !round || !round.open) return;
      setRounds((r) => ({ ...r, [round.sessionId]: round }));
      setAwaiting((a) => ({ ...a, [round.sessionId]: true }));
    });
    return () => {
      live = false;
    };
    // `rounds` is deliberately not a dependency: this fills a gap when a session
    // is opened, and re-running it every time the round changes would ask main
    // about a round the window is already being told about.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Machinery an older build wrote into an agent thread, taken back out.
  //
  // The same treatment a failed run gets, because it is the same idea and the app
  // now has one way of saying it: shown once so nothing disappears behind your
  // back, counted down where you can see it, then it comes apart and leaves the
  // disk. One countdown for the batch rather than one per bubble — four summons
  // leave four greetings, and four captions saying the same thing would be its
  // own kind of clutter.
  function eraseSummonLeftovers(thread, hist) {
    if (erasedThreads.current.has(thread)) return;
    erasedThreads.current.add(thread);
    const found = findSummonLeftovers(hist);
    if (!found.length) return;
    const ids = found.map((m) => m.id);
    const last = ids[ids.length - 1];
    setMessages((prev) => ({
      ...prev,
      [thread]: (prev[thread] || []).map((m) =>
        ids.includes(m.id) ? { ...m, erasing: true, eraseLast: m.id === last } : m
      ),
    }));
    const key = `erase:${thread}`;
    noticeTimers.current[key] = setTimeout(() => {
      setMessages((prev) => ({
        ...prev,
        [thread]: (prev[thread] || []).map((m) => (ids.includes(m.id) ? { ...m, dissolving: true } : m)),
      }));
      noticeTimers.current[key] = setTimeout(
        () => {
          delete noticeTimers.current[key];
          // Off the disk and out of the window together. If the app closes in
          // between, the next open finds them again and counts them down again —
          // which is the right failure: nothing is lost, and nothing is deleted
          // that was not seen going.
          api.purgeMessages(thread, ids);
          setMessages((prev) => ({
            ...prev,
            [thread]: (prev[thread] || []).filter((m) => !ids.includes(m.id)),
          }));
        },
        prefersReducedMotion() ? 0 : DISSOLVE_MS
      );
    }, ERROR_TTL_MS);
  }

  // Removing them. Both halves happen together or neither does: main takes the
  // messages out of the file and the same number off what the session claims to
  // have asked, and only what it really removed is counted.
  async function sweepErrors() {
    if (!sweep) return;
    const { threadId, ids } = sweep;
    setSweep(null);
    const res = await api.sweepSessionErrors(threadId, ids);
    if (!res?.ok) {
      toast('Could not clean up this history.', 'error');
      return;
    }
    const gone = new Set(ids);
    setMessages((prev) => ({ ...prev, [threadId]: (prev[threadId] || []).filter((m) => !gone.has(m.id)) }));
    toast(`Removed ${res.removed} error message${res.removed === 1 ? '' : 's'}.`);
  }

  // Deleting a conversation is irreversible and there is no undo, so it asks
  // first and names what goes. The in-memory copy is dropped alongside the file,
  // and the peer is un-marked as loaded so a later visit re-reads from disk
  // rather than resurrecting the cleared thread from state.
  async function clearHistory() {
    if (!selectedId) return;
    const who = selectedPeer?.name || 'this conversation';
    const ok = window.confirm(
      `Delete your chat history with ${who}?\n\n` +
        'Every message in this conversation is removed from this device, along with anything still ' +
        'waiting to send. This cannot be undone, and it does not delete their copy.'
    );
    if (!ok) return;
    const res = await api.clearHistory(selectedId);
    if (!res?.ok) {
      toast('Could not delete the chat history.', 'error');
      return;
    }
    loadedPeers.current.delete(selectedId);
    setMessages((prev) => ({ ...prev, [selectedId]: [] }));
    toast('Chat history deleted.');
  }

  // Saves the conversation as readable text. The main process owns the file
  // dialog and the writing; the renderer only reports how it went.
  async function exportHistory() {
    if (!selectedId) return;
    const res = await api.exportHistory(selectedId, selectedPeer?.name || '');
    if (res?.canceled) return;
    if (!res?.ok) {
      toast(res?.error || 'Could not save the chat history.', 'error');
      return;
    }
    toast(`Saved ${res.count} message${res.count === 1 ? '' : 's'}.`);
  }

  // Agents this machine can point a session at: our own, and the ones peers have
  // shared with us.
  //
  // Straight off what main says, for the same reason `mentionables` below is
  // taken straight off `byOwner`: the roster is not this set. An agent shared
  // without direct chat is reachable and deliberately not a contact, so a picker
  // built by filtering the roster would offer a strict subset of who a session
  // actually asks — and "All agents" would then quietly include somebody the
  // person choosing it never saw on the list.
  //
  // Main decides reachability in exactly one place (askable() in
  // sessions/index.js); this is that place, read rather than guessed at a second
  // time. Refreshed whenever the roster or the set of shared agents changes,
  // which is every event that could alter the answer.
  const [askableAgents, setAskableAgents] = useState([]);
  useEffect(() => {
    let live = true;
    api.askableAgents().then((list) => live && setAskableAgents(list || []));
    return () => {
      live = false;
    };
  }, [peers, peerAgents, agentStatus]);

  // Agents the person whose chat is open is sharing, for `@` in the composer.
  //
  // Straight off what main published, which is `byOwner` — the exact map
  // `matchMention` walks. That equality is the whole contract: anything else on
  // this list would complete to something that lands in the human's chat instead,
  // and anything missing from it is an agent you can reach but cannot be offered.
  //
  // This used to filter the roster, which is a strict subset: an agent shared
  // without direct chat is routable and deliberately not a contact, so the menu
  // stayed empty until a summon revealed it — the bug this replaces. There is no
  // `online` filter for the same reason: an owner going offline empties this map
  // through dropOwner, and a second guess at reachability is how the two sets
  // drifted apart in the first place.
  //
  // Empty in an agent thread or a session: `@name` is routed out of a *person's*
  // chat, and nowhere else. `viaName` is the open peer, since that is whose
  // agents these are.
  const mentionables = useMemo(() => {
    const offered = peerAgents[selectedId];
    if (!offered?.length) return [];
    const owner = peers.find((p) => p.id === selectedId);
    const viaName = owner?.name || owner?.hostname || 'a peer';
    return offered.map((a) => ({ ...a, viaName }));
  }, [peerAgents, peers, selectedId]);

  const selectedPeer = useMemo(() => {
    if (!selectedId) return null;
    // A session is not a contact and never appears in the roster: it is a
    // workspace in this window. It is given the same shape as a peer here so the
    // conversation pane can render it without knowing what it is looking at —
    // the same trick already used for an id nobody has seen before.
    if (isSessionThread(selectedId)) {
      const record = sessions.find((s) => s.id === selectedId);
      if (!record) return null;
      // The counsel is resolved once, here, so every surface reading this card
      // agrees on who this session asks. An id that no longer answers to an agent
      // resolves to nothing, which is the same state as never having chosen it —
      // in both cases there is nobody there to ask. A session set to ask whoever
      // is available resolves to whoever is available, which is the whole of what
      // that setting means.
      const counsel = record.allAgents
        ? askableAgents
        : (record.agentIds || []).map((id) => askableAgents.find((a) => a.id === id)).filter(Boolean);
      return {
        id: record.id,
        kind: 'session',
        name: record.title,
        // The counsel, and the one-agent view of it that everything written
        // before counsels existed still reads.
        agentIds: record.agentIds || [],
        allAgents: Boolean(record.allAgents),
        mode: record.mode || 'parallel',
        agentNames: counsel.map((a) => a.name),
        agentId: counsel[0]?.id || null,
        agentName: counsel[0]?.name || null,
        online: true,
        // This session lost questions it cannot put back — see sweepErrors in
        // sessions/index.js. Carried on the card so the pane can say so without
        // having to know what a session record is.
        needsContext: Boolean(record.needsContext),
      };
    }
    const live = peers.find((p) => p.id === selectedId);
    const base = live || knownPeers.current[selectedId] || { id: selectedId, name: 'Unknown' };
    return { ...base, online: live ? live.online : false };
  }, [selectedId, peers, sessions, askableAgents]);

  // How many questions this session has been asked. Derived from the thread the
  // window already holds rather than stored on the record: the messages are the
  // only place it is ever true, and a stored number would be one restart away
  // from disagreeing with them.
  //
  // Less the corrections for questions that failed before a failure named the
  // question it belonged to. Those cannot be marked individually — nothing links
  // them — but each swept error was one run that did not answer, so the count of
  // them comes off the total. Subtracted here rather than inside commitCount:
  // that function counts a list of messages, and this is a fact about the session
  // record, not about the messages left in it.
  const selectedCommits = useMemo(() => {
    if (!isSessionThread(selectedId)) return 0;
    const record = sessions.find((s) => s.id === selectedId);
    return Math.max(0, commitCount(messages[selectedId]) - (record?.unlinkedFailures || 0));
  }, [selectedId, messages, sessions]);

  // What is being written into this thread right now, one entry per agent.
  //
  // Named here rather than in the pane, from the same roster the picker reads, so
  // a live preview and the finished bubble it turns into are labelled with the
  // same name. Sorted by agent id rather than by arrival, so a preview does not
  // jump up the pane every time a different agent emits a word.
  const selectedStreams = useMemo(() => {
    const live = streams[selectedId];
    if (!live) return EMPTY_STREAMS;
    const out = [];
    for (const [agentId, text] of Object.entries(live)) {
      if (!text) continue;
      const agent = askableAgents.find((a) => a.id === agentId);
      out.push({ agentId, name: agent?.name || 'an agent', text });
    }
    return out.length ? out.sort((a, b) => a.agentId.localeCompare(b.agentId)) : EMPTY_STREAMS;
  }, [streams, selectedId, askableAgents]);

  // Windows asks for the loopback address itself rather than the name for it:
  // there "localhost" resolves to ::1 first, while the service listens on
  // 0.0.0.0 — IPv4 only — so a thumbnail was one failed name resolution away
  // from never loading. It is the same endpoint either way; macOS and Linux,
  // where this has always worked, keep asking for it by name.
  const localHost = (identity) => (identity?.platform === 'win32' ? '127.0.0.1' : 'localhost');
  const localFile = (identity, path) =>
    `http://${localHost(identity)}:${identity.servicePort}/lanchat/preview?path=${encodeURIComponent(path)}`;

  const soundUrl = (path) => (path && selfRef.current ? localFile(selfRef.current, path) : null);

  selectedPeerRef.current = selectedPeer;

  const previewUrl = (path) => (path && self ? localFile(self, path) : null);

  // Links in messages. Opening one always goes through main (which refuses
  // anything that is not http(s)); unfurling one is a setting, and passing
  // `undefined` when it is off is what keeps the bubbles from ever asking.
  const openLink = (url) => url && api.openExternal(url);
  const fetchLinkPreview = useMemo(
    () => (config.linkPreviews === false ? undefined : (url) => api.linkPreview(url)),
    [config.linkPreviews]
  );

  // --- Actions ---
  async function saveProfile(profile) {
    const id = await api.setProfile(profile);
    setSelf(id);
    setConfigured(true);
    setFirstRun(false);
    setModal(null);
  }

  // An agent chosen from the composer's `@` menu.
  //
  // Deliberately not routed through sendText. Nothing is being sent: a summon is
  // not a message, so there is no draft to clear, no documents to attach and no
  // quoted context to carry — and going through the send path would take all
  // three away from a chat where somebody may have been part-way through
  // composing something.
  //
  // By id, so the agent that was picked is the agent that is reached. Turning the
  // choice back into `@Name` for main to re-parse is the version of this that can
  // miss and leave a bare mention in a conversation with a person.
  async function summonAgent(item) {
    const res = await api.summonAgent(item.id);
    if (res?.summoned) {
      setSummoned((s) => ({ ...s, [res.threadId]: true }));
      return;
    }
    // Its owner went offline, or stopped sharing it, between the menu being drawn
    // and the key being pressed. Said out loud: a summon that produced no bubble
    // and no light would otherwise look exactly like one that worked.
    toast(`${item.name} could not be reached — its owner is offline.`, 'error');
  }

  async function sendText(text) {
    if (!selectedId) return;
    // Asking an agent means waiting on it, and that is knowable here without a
    // round trip. Relying only on the owner's relay left the far side reading
    // "Ready" while it was plainly working.
    if (isThinkingThread(selectedId)) setAwaiting((a) => ({ ...a, [selectedId]: true }));
    // Cleared before the round trip, so the chips go the moment Send is pressed
    // rather than lingering while a slow agent is reached. A refusal puts them
    // back below, alongside the words.
    const staged = attachments[selectedId] || [];
    if (staged.length) setAttachments((a) => ({ ...a, [selectedId]: [] }));
    // The quoted excerpt goes the same way the documents do, and comes back the
    // same way if the send is refused.
    const quoted = contexts[selectedId] || null;
    if (quoted) setContexts((c) => ({ ...c, [selectedId]: null }));
    const msg = await api.sendChat(
      selectedId,
      text,
      staged.map((d) => d.path),
      quoted
    );
    // Refused: a question of ours is already waiting to be read, and this one
    // would not be answered any sooner. Shown and then taken away rather than
    // never shown, so what is refused is visibly *this* message — and the words
    // go back to the composer, because being told to wait should not cost you
    // what you wrote.
    if (msg.rejected) {
      setAwaiting((a) => ({ ...a, [selectedId]: false }));
      const ghost = {
        id: nextLocalId(),
        peerId: selectedId,
        direction: 'out',
        kind: 'text',
        text: msg.text,
        ts: Date.now(),
        rejected: true,
      };
      appendMessage(selectedId, ghost);
      appendMessage(selectedId, msg.notice);
      if (!configRef.current.muteNotifications) {
        playRejectCue({ volume: Math.min(1, (configRef.current.notificationVolume ?? 0.7) + 0.2) });
      }
      setTimeout(() => removeMessage(selectedId, ghost.id), REJECT_LINGER_MS);
      setDraft({ threadId: selectedId, text: msg.text, nonce: Date.now() });
      // The documents come back with the words. Being told to wait should not
      // cost somebody the file they went and found.
      if (msg.docs?.length || staged.length) {
        setAttachments((a) => ({ ...a, [selectedId]: msg.docs?.length ? msg.docs : staged }));
      }
      // And so does what the fork was asking about, for the same reason: it was
      // pinned by a gesture on a bubble that may now be a long way up the page.
      if (quoted) setContexts((c) => ({ ...c, [selectedId]: quoted }));
      return;
    }
    // A bare `@name` was a summon rather than a question. There is no message:
    // nothing was said, and nothing is written down on either machine — so this
    // returns before appendMessage rather than after it.
    //
    // The agent's row is marked instead, and stays marked until it is opened. The
    // conversation is not switched to: being taken somewhere else the instant you
    // type is startling, and it would leave nothing to click. `summoned` is only
    // true when the frame actually reached the owner, so a row that is pulsing is
    // an agent that really was summoned.
    if (msg.summoned) {
      setSummoned((s) => ({ ...s, [msg.threadId]: true }));
      return;
    }
    // Refused before it was sent: the owner was not reachable. Said out loud,
    // because a summon that produced no bubble and no light would otherwise look
    // exactly like one that worked.
    if (msg.summoned === false && msg.threadId) {
      toast('That agent could not be reached — its owner is offline.', 'error');
      return;
    }
    appendMessage(msg.peerId || selectedId, msg);
    // Held locally and retried on reconnect. This machine has to still be
    // running for that to happen — there is no server to hold it for us.
    if (!msg.delivered) toast('Saved — it will send when they are back online', 'info');
  }

  // --- Sessions ---

  // A new session opens straight away rather than waiting to be clicked in the
  // list: pressing the button is already the decision to work in one.
  //
  // It starts pointed at the only agent there is, when there is only one. That
  // is not a guess — with a single candidate there is nothing to choose, and
  // making somebody pick from a list of one before they can ask anything is
  // ceremony. With two or more it stays unset and the header asks.
  async function newSession(seed = {}) {
    const only = askableAgents.length === 1 ? askableAgents[0].id : null;
    const record = await api.createSession({ agentId: seed.agentId || only, title: seed.title });
    if (!record) {
      toast('Could not start a session.', 'error');
      return null;
    }
    setSessions((list) => [record, ...list.filter((s) => s.id !== record.id)]);
    setSelectedId(record.id);
    return record;
  }

  async function renameSession(id, title) {
    const record = await api.renameSession(id, title);
    if (record) setSessions((list) => list.map((s) => (s.id === record.id ? record : s)));
  }

  // Who a session asks: a list of agents, or whoever is available, and whether
  // they answer all at once or one after another. One call for the lot, because
  // they are one decision — un-ticking an agent while the session was set to ask
  // everybody changes both halves at once, and two calls would leave a moment
  // where the record said something nobody chose.
  async function setSessionCounsel(id, patch) {
    const record = await api.setSessionCounsel(id, patch);
    if (record) setSessions((list) => list.map((s) => (s.id === record.id ? record : s)));
  }

  // Loading a saved conversation in. The messages are written in main, so the
  // thread is re-read rather than patched here — one source for what is in it,
  // whether it arrived by import or by being said.
  async function importSessionText(id) {
    const res = await api.importSessionText(id);
    if (res?.canceled) return;
    if (!res?.ok) {
      toast(res?.error || 'Could not read that file.', 'error');
      return;
    }
    const hist = await api.getHistory(id);
    setMessages((prev) => ({ ...prev, [id]: mergeHistory(hist, prev[id]) }));
    loadedPeers.current.add(id);
    toast(
      res.mode === 'lanchat'
        ? `Loaded ${res.count} message${res.count === 1 ? '' : 's'}.`
        : `Loaded ${res.count} block${res.count === 1 ? '' : 's'} of text.`
    );
  }

  // Deleting a session takes the conversation in it with the record, so it asks
  // first and names what goes — the same bargain as clearing a chat, and the
  // same button.
  async function deleteSession(id) {
    const record = sessions.find((s) => s.id === id);
    const ok = window.confirm(
      `Delete the session “${record?.title || 'this session'}”?\n\n` +
        'Everything in it goes with it, including anything imported into it. This cannot be undone.'
    );
    if (!ok) return;
    const res = await api.deleteSession(id);
    if (!res?.ok) {
      toast('Could not delete the session.', 'error');
      return;
    }
    setSessions((list) => list.filter((s) => s.id !== id));
    setMessages((prev) => ({ ...prev, [id]: [] }));
    loadedPeers.current.delete(id);
    if (selectedRef.current === id) setSelectedId(null);
    toast('Session deleted.');
  }

  // Carrying one bubble into a new question.
  //
  // Inside a session, the excerpt is pinned to the composer and the conversation
  // carries on where it is. From an agent's own thread there is nowhere to
  // branch to yet, so a session is started for it — bound to that agent, seeded
  // with the excerpt, and named after nothing until somebody names it.
  async function forkFrom(msg) {
    const from = msg.peerId || selectedRef.current;
    const quoted = {
      text: msg.text,
      speaker: msg.speaker || speakerFor(msg, from),
      ts: msg.ts,
    };
    if (isSessionThread(from)) {
      setContexts((c) => ({ ...c, [from]: quoted }));
      return;
    }
    // A delegate thread is a transcript of somebody else's conversation with one
    // of our agents. Branching off it asks *the agent*, so the session is bound
    // to the agent rather than to the transcript, which nothing can be asked of.
    const agentId = from.includes('#') ? from.slice(0, from.indexOf('#')) : from;
    const record = await newSession({ agentId });
    if (record) setContexts((c) => ({ ...c, [record.id]: quoted }));
  }

  // Putting a failed question back the way it was, the instant before it was
  // sent.
  //
  // A restore rather than a re-send: the words go back into the composer instead
  // of straight onto the wire. The same question failing twice in a row is
  // likely enough that the useful next move is often to change it, and a button
  // that fired immediately would take that away — as well as sending something
  // the moment it was clicked, with nothing readable in between.
  //
  // This is the path a refused send already takes, reached from a different
  // direction, so it uses the same two setters rather than a second mechanism.
  function resendFrom(msg) {
    const from = msg.peerId || selectedRef.current;
    // Keyed on a fresh nonce, so pressing it twice restores twice — the composer
    // effect deliberately ignores an unchanged draft.
    setDraft({ threadId: from, text: msg.text, nonce: Date.now() });
    // What the question was asking about comes back with it. Nothing to re-pin
    // by hand: the excerpt may be a long way up a thread that has since moved on.
    if (msg.context) setContexts((c) => ({ ...c, [from]: msg.context }));
    // Documents are the one thing that cannot come back. History keeps their
    // names and sizes so the bubble can still say what was sent, but never their
    // paths — so they have to be found again, and saying so is better than a
    // silent re-ask that the agent answers without them.
    if (msg.docs?.length) {
      toast(
        msg.docs.length === 1
          ? 'Attach the document again before sending'
          : 'Attach the documents again before sending'
      );
    }
  }

  // Who said the thing being quoted, in the words the agent will read. Worked
  // out from the thread rather than stored on the message, because a message
  // knows its direction and its thread knows the rest.
  function speakerFor(msg, threadId) {
    if (msg.direction === 'out') return selfRef.current?.name || 'Me';
    const peer = peersRef.current.find((p) => p.id === threadId);
    return peer?.name || null;
  }

  // The attach button. To a person it sends a file; to an agent it stages a
  // document for the agent to read, which goes with whatever you type next.
  async function attach() {
    if (!selectedId) return;
    if (!isThinkingThread(selectedId)) {
      await api.pickAndSendFile(selectedId);
      return;
    }
    stageDocuments(selectedId, await api.pickDocuments());
  }

  // Files chosen or dropped have already been checked in main, so each arrives
  // either readable or with the reason it is not. The reasons are said out loud
  // once each; the readable ones become chips.
  function stageDocuments(threadId, results) {
    if (!results || !results.length) return;
    const good = results.filter((r) => r.ok);
    for (const bad of results.filter((r) => !r.ok)) toast(bad.error, 'error');
    if (!good.length) return;
    setAttachments((a) => {
      const existing = a[threadId] || [];
      // Attaching the same file twice would send it twice; the second time is
      // almost always somebody making sure the first one landed.
      const seen = new Set(existing.map((d) => d.path));
      const added = good.filter((d) => !seen.has(d.path)).map((d) => ({ path: d.path, name: d.name, bytes: d.bytes }));
      return added.length ? { ...a, [threadId]: [...existing, ...added] } : a;
    });
  }

  function removeAttachment(threadId, docPath) {
    setAttachments((a) => ({ ...a, [threadId]: (a[threadId] || []).filter((d) => d.path !== docPath) }));
  }

  // A recorded voice message travels as bytes; main writes it to disk and then
  // sends it through the ordinary file-transfer path.
  async function sendVoice(result, err) {
    if (err) {
      toast(`Cannot record: ${err.message}`, 'error');
      return;
    }
    if (!result || !selectedId) return;
    const buf = await result.blob.arrayBuffer();
    await api.sendVoice(selectedId, new Uint8Array(buf), result.ext);
  }

  function onTyping(active) {
    if (selectedId) api.sendTyping(selectedId, active);
  }

  async function addPeer(ip, port) {
    await api.addManualPeer(ip, port);
    toast(`Looking for LanChat at ${ip}:${port}…`);
  }

  async function saveSettings(patch) {
    const c = await api.setConfig(patch);
    setConfig(c);
    toast('Settings saved');
  }

  // How the sidebar's categories are stacked, and which are pinned open.
  //
  // Optimistic and quiet, like a device change: the panel has already moved by
  // the time this runs — dragging a heading somewhere and then watching it snap
  // back while a write completes would be the panel arguing with the hand — and
  // a toast for every drag would be three toasts for three tries.
  function saveSectionPrefs(patch) {
    setConfig((c) => ({ ...c, ...patch }));
    api.setConfig(patch);
  }

  // Change mic/camera mid-call and remember it for future calls.
  async function switchDevice(key, deviceId) {
    setConfig((c) => ({ ...c, [key]: deviceId }));
    api.setConfig({ [key]: deviceId });
    if (!deviceId) return; // "System default" applies to the next call
    try {
      await callRef.current.switchDevice(key === 'videoInputId' ? 'video' : 'audio', deviceId);
    } catch (err) {
      toast(`Could not switch device: ${err.message}`, 'error');
    }
  }

  function startCall(withVideo) {
    if (!selectedPeer || !selectedPeer.online) return;
    callRef.current.start(selectedPeer, withVideo).catch((err) => toast(`Cannot start call: ${err.message}`, 'error'));
  }

  // Developer panel → "Request support session". This is not a silent path to
  // a peer's camera/mic: it starts an ordinary outgoing call tagged
  // `support: true`, which the peer sees as an explicit accept/decline prompt
  // in IncomingCall.jsx — exactly the same consent gate any other call goes
  // through.
  function requestSupportSession(peer) {
    setModal(null);
    if (call.status !== 'idle') {
      toast('Finish your current call first', 'error');
      return;
    }
    callRef.current
      .start(peer, true, { support: true })
      .catch((err) => toast(`Cannot start session: ${err.message}`, 'error'));
  }

  // --- Drag & drop files ---
  //
  // Where a dropped file goes depends on who is on the other side. A person
  // receives it: same file transfer as the paperclip. An agent reads it: the
  // drop stages it as a document, so you can say what you want done with it
  // before it goes, rather than handing over a file with no question attached.
  async function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    if (!selectedId) return;
    // `file.path` was removed in Electron 32; main resolves it now. The old
    // property is still read as a fallback so a drop cannot silently do
    // nothing if this ever runs somewhere that still has it.
    const paths = [...e.dataTransfer.files].map((f) => api.getPathForFile?.(f) || f.path).filter(Boolean);
    if (!paths.length) return;
    if (!isThinkingThread(selectedId)) {
      api.sendFilePaths(selectedId, paths);
      return;
    }
    // A session with no agent has nowhere to put a document either.
    if (isSessionThread(selectedId) && !selectedPeer?.agentId) {
      toast('Choose an agent for this session first', 'error');
      return;
    }
    if (!isSessionThread(selectedId) && !selectedPeer?.online) {
      toast('That agent is off — turn it on to give it something to read', 'error');
      return;
    }
    if (selectedPeer.delegate) return; // somebody else's conversation
    stageDocuments(selectedId, await api.readDocuments(paths));
  }

  const inCall = ['outgoing', 'connecting', 'in-call'].includes(call.status);
  const groupActive = ['inviting', 'in-call'].includes(group.status);
  const groupInvited = group.status === 'invited';
  inCallRef.current = inCall;
  groupActiveRef.current = groupActive;

  // Main needs to know a video call is live to intercept minimise.
  useEffect(() => {
    api.setCallActive(inCall && Boolean(call.withVideo));
  }, [inCall, call.withVideo]);
  const incoming = call.status === 'incoming';

  // Is anything on this machine actually running right now?
  //
  // `typing` is the honest bracket for a local agent: main raises it once when a
  // run starts and drops it once when the run ends, and App deliberately does
  // not expire it the way it expires a person's (see the 'typing' case above).
  // `awaiting` covers the other direction — a question sent to somebody else's
  // agent, where all we know is that we asked and have not heard back.
  //
  // Pointedly not `agentStatus`: that is a tool-by-tool caption, not a bracket.
  // It flips to 'ready' between every pair of tool calls and is never reset when
  // a run finishes, so music driven from it would strobe and then never stop.
  // Nor `peer.agentBusy`, which for a shared agent means somebody else's
  // question is running on somebody else's machine.
  const agentWorking = useMemo(() => {
    for (const [id, on] of Object.entries(typing)) if (on && isThinkingThread(id)) return true;
    for (const [id, on] of Object.entries(awaiting)) if (on && isThinkingThread(id)) return true;
    return false;
  }, [typing, awaiting]);

  // A call owns the speakers. The bed comes back, from where it left off, when
  // the call ends.
  useAgentMusic(agentWorking && !inCall && !groupActive && !incoming && !groupInvited, {
    enabled: config.agentMusicEnabled === true,
    volume: config.agentMusicVolume ?? 0.5,
    // A bundled track by name, or the user's own file served by the same local
    // endpoint the custom ringtone plays from.
    url: trackUrl(config.agentMusic || DEFAULT_TRACK, soundUrl(config.customAgentMusicPath)),
  });

  function startGroupCall(chosenPeers, withVideo) {
    if (inCall) return toast('Finish your current call first', 'error');
    groupRef.current.host(chosenPeers, withVideo);
  }

  // Docked picture-in-picture: only the video, nothing else.
  if (pipMode && inCall) {
    return (
      <CallOverlay
        call={call}
        pip
        onExitPip={() => api.exitPip()}
        onHangup={() => {
          callRef.current.hangup();
          api.exitPip();
        }}
        onAudioStats={() => callRef.current.getAudioStats()}
      />
    );
  }

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault();
        // Files only. Everything dragged anywhere in the window arrives here,
        // including a sidebar category on its way to a new place in the list,
        // and the sheet that says "drop to send" has nothing to do with that.
        if (selectedId && Array.from(e.dataTransfer?.types || []).includes('Files')) setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      <Sidebar
        self={self}
        peers={peers}
        tailnet={tailnet}
        tailnetStatus={tailnetStatus}
        selectedId={selectedId}
        unread={unread}
        summoned={summoned}
        queued={queued}
        authFailures={authFailures}
        showAddresses={config.showAddresses}
        sessions={sessions}
        askableAgents={askableAgents}
        sectionOrder={config.sidebarOrder}
        lockedSections={config.sidebarLocked}
        onSectionPrefs={saveSectionPrefs}
        search={search}
        onSearch={(patch) => setSearch((s) => ({ ...s, ...patch }))}
        onSelect={setSelectedId}
        onOpenProfile={() => setModal('profile')}
        onOpenDev={() => setModal('devgate')}
        onOpenSettings={() => setModal('settings')}
        onNewSession={() => newSession()}
        onAddPeer={() => setModal('addpeer')}
        onNewGroupCall={() => setModal('newgroup')}
        onRefresh={() => (api.refresh(), toast('Refreshing…'))}
      />

      <div className="chat-wrap">
        <ChatPane
          peer={selectedPeer}
          messages={messages[selectedId] || []}
          typing={typing[selectedId]}
          awaiting={Boolean(awaiting[selectedId])}
          progress={progress}
          approval={approvals[selectedId]}
          agentStreams={selectedStreams}
          round={rounds[selectedId] || null}
          flash={flash[selectedId]}
          onFlashDone={() => clearFlash(selectedId)}
          onApprove={(choice) => {
            const req = approvals[selectedId];
            if (!req) return;
            setApprovals((a) => ({ ...a, [selectedId]: null }));
            api.answerAgentApproval(selectedId, req.runId, choice);
          }}
          previewUrl={previewUrl}
          previewFallback={self?.platform === 'win32'}
          showAddresses={config.showAddresses}
          canFind={config.findSessionsOnly ? selectedPeer?.kind === 'session' : true}
          onOpenLink={openLink}
          linkPreview={fetchLinkPreview}
          draft={draft && draft.threadId === selectedId ? draft : null}
          docs={attachments[selectedId] || EMPTY_DOCS}
          onRemoveDoc={(docPath) => removeAttachment(selectedId, docPath)}
          context={contexts[selectedId] || null}
          onRemoveContext={() => setContexts((c) => ({ ...c, [selectedId]: null }))}
          agents={askableAgents}
          mentionables={mentionables}
          onSummon={summonAgent}
          onRenameSession={renameSession}
          onSetCounsel={setSessionCounsel}
          onImportText={() => importSessionText(selectedId)}
          // Branching is offered where a question can be asked from: inside a
          // session, and in the agent threads a session can be started from.
          onFork={isThinkingThread(selectedId) ? forkFrom : undefined}
          // Offered on the same threads, and for the same reason: only somewhere
          // that can answer a question is there any point putting one back.
          onResend={isThinkingThread(selectedId) ? resendFrom : undefined}
          onSend={sendText}
          onAttach={attach}
          onVoice={sendVoice}
          onTyping={onTyping}
          // In a session the same button means the same thing it always did —
          // "this conversation goes" — and the session is the conversation.
          onClearHistory={isSessionThread(selectedId) ? () => deleteSession(selectedId) : clearHistory}
          onExportHistory={exportHistory}
          onOpenFile={(p) => p && api.openFile(p)}
          onRevealFile={(p) => p && api.revealFile(p)}
          onVoiceCall={() => startCall(false)}
          onVideoCall={() => startCall(true)}
        />
        {dragOver && (
          <div className="drop-overlay">
            {isThinkingThread(selectedId)
              ? `Drop to give ${selectedPeer?.name || 'the agent'} a document`
              : 'Drop to send'}
          </div>
        )}

        {/* What the search found, in the room with space to read it. It lies
            *over* the conversation rather than instead of it: the composer keeps
            what was being typed in its own state, so a pane swapped out for
            results and back would take a half-written message with it. Closing
            this returns to the same draft at the same scroll position. */}
        {search.q.trim() && (
          <SearchResults
            search={search}
            sessions={sessions}
            askableAgents={askableAgents}
            peers={peers}
            tailnet={tailnet}
            unread={unread}
            order={config.sidebarOrder}
            onSelect={setSelectedId}
            onClose={() => setSearch((s) => ({ ...s, q: '' }))}
          />
        )}
      </div>

      {/* Incoming push-to-talk audio. Hidden: playback only, no controls. */}
      {ptt.inboundStreams.map(({ peerId, stream }) => (
        <PttAudio key={peerId} stream={stream} />
      ))}

      <aside className="side-panel">
        {inCall ? (
          <CallOverlay
            call={call}
            devices={{ audioInputId: config.audioInputId, videoInputId: config.videoInputId }}
            fullscreen={false}
            onToggleFullscreen={() => setCallFullscreen(true)}
            onHangup={() => callRef.current.hangup()}
            onToggleMute={() => callRef.current.toggleMute()}
            onToggleCamera={() => callRef.current.toggleCamera()}
            onSwitchDevice={switchDevice}
            onAudioStats={() => callRef.current.getAudioStats()}
          />
        ) : (
          <>
            {config.pttEnabled !== false && (
              <PttBar
                peer={selectedPeer}
                state={ptt}
                keyName={config.pttKey || defaultPttKey()}
                onHoldStart={() => pttRef.current.setTransmitting(true, selectedPeerRef.current)}
                onHoldEnd={() => pttRef.current.setTransmitting(false)}
              />
            )}
            <ConnectionPanel
              peer={selectedPeer}
              stats={linkStats[selectedId]}
              agentStatus={agentStatus[selectedId]}
              awaiting={Boolean(awaiting[selectedId])}
              // A session has no presence to read a state off, so the panel is
              // told the same things the conversation is: main's bracket around
              // the run, whether any of its agents is mid-sentence, and the count
              // of what has been asked.
              typing={Boolean(typing[selectedId])}
              streaming={selectedStreams.length > 0}
              commits={selectedCommits}
            />
          </>
        )}
      </aside>

      {modal === 'profile' && (
        <ProfileModal self={self} firstRun={firstRun} onSave={saveProfile} onClose={() => setModal(null)} />
      )}
      {modal === 'devgate' && (
        <DevPasswordModal onUnlock={() => setModal('devpanel')} onClose={() => setModal(null)} />
      )}
      {modal === 'devpanel' && (
        <DevPanel peers={peers} onRequestSupport={requestSupportSession} onClose={() => setModal(null)} />
      )}
      {modal === 'settings' && (
        <SettingsModal
          config={config}
          self={self}
          peers={peers}
          soundUrl={soundUrl}
          onSave={saveSettings}
          onClose={() => setModal(null)}
        />
      )}
      {/* Only while that session is the one on screen. A history scan finishes
          whenever it finishes, and a dialog about a conversation somebody has
          already navigated away from would be asking about the wrong thing. */}
      {sweep && sweep.threadId === selectedId && (
        <ErrorSweepModal count={sweep.ids.length} onKeep={() => setSweep(null)} onRemove={sweepErrors} />
      )}
      {updateBanner && !firstRun && !update && (
        <UpdateBanner
          info={updateBanner}
          onUpdateNow={() => {
            setUpdate(updateBanner);
            setUpdateBanner(null);
          }}
          onLater={() => {
            laterDismissedRef.current = updateBanner.latest;
            setUpdateBanner(null);
          }}
        />
      )}
      {update && !firstRun && (
        <UpdatePrompt
          info={update}
          autoStart
          onClose={() => setUpdate(null)}
          onSkip={async () => {
            const version = update.latest;
            setUpdate(null);
            setConfig(await api.setConfig({ skippedUpdateVersion: version }));
            toast(`You will not be reminded about ${version} again`);
          }}
        />
      )}
      {keyAlarm && (
        <KeyChangeModal
          alarm={keyAlarm}
          onClose={() => setKeyAlarm(null)}
          onForget={async () => {
            await api.forgetPeer(keyAlarm.peerId);
            setKeyAlarm(null);
            toast('That device was forgotten. It will be treated as new if it connects again.');
          }}
          onAccept={async () => {
            const result = await api.repinPeer(keyAlarm.peerId);
            setKeyAlarm(null);
            const revoked = (result && result.revoked) || [];
            toast(
              revoked.length
                ? `New key trusted. ${revoked.length} agent grant${revoked.length === 1 ? '' : 's'} were taken back.`
                : 'New key trusted.'
            );
          }}
        />
      )}

      {modal === 'addpeer' && (
        <AddPeerModal
          defaultPort={self?.servicePort}
          tailnet={tailnet}
          peers={peers}
          onAdd={addPeer}
          onClose={() => setModal(null)}
        />
      )}

      {incoming && (
        <IncomingCall
          call={call}
          onAccept={(prefs) => callRef.current.accept(prefs).catch((err) => toast(`Cannot answer: ${err.message}`, 'error'))}
          onDecline={() => callRef.current.decline()}
        />
      )}

      {groupInvited && group.invite && (
        <GroupInvite
          invite={group.invite}
          onAccept={(prefs) => groupRef.current.accept(prefs)}
          onDecline={() => groupRef.current.decline()}
        />
      )}
      {groupActive && (
        <GroupCallView
          call={group}
          self={self}
          onLeave={() => groupRef.current.leave()}
          onToggleMute={() => groupRef.current.toggleMute()}
          onToggleCamera={() => groupRef.current.toggleCamera()}
        />
      )}
      {modal === 'newgroup' && (
        <NewGroupCallModal peers={peers} onStart={startGroupCall} onClose={() => setModal(null)} />
      )}
      {inCall && callFullscreen && (
        <CallOverlay
          call={call}
          devices={{ audioInputId: config.audioInputId, videoInputId: config.videoInputId }}
          fullscreen
          onToggleFullscreen={() => setCallFullscreen(false)}
          onHangup={() => callRef.current.hangup()}
          onToggleMute={() => callRef.current.toggleMute()}
          onToggleCamera={() => callRef.current.toggleCamera()}
          onSwitchDevice={switchDevice}
          onAudioStats={() => callRef.current.getAudioStats()}
        />
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

// Plays an incoming push-to-talk stream. Mounted per talking peer.
function PttAudio({ stream }) {
  const ref = React.useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !stream) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    const p = el.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }, [stream]);
  return <audio ref={ref} autoPlay style={{ display: 'none' }} />;
}

// Merge persisted history with any live messages already received, dedup by id.
function mergeHistory(hist, live) {
  const map = new Map();
  for (const m of hist || []) map.set(m.id, m);
  for (const m of live || []) map.set(m.id, { ...map.get(m.id), ...m });
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}
