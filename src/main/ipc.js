'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ipcMain, dialog, shell } = require('electron');
const { guessMime } = require('./fileTransfer');
const { readDocument, composePrompt } = require('./documents');
const { LOCAL_ORIGIN: AGENT_LOCAL_ORIGIN } = require('./agents');
const { createRemoteAgents } = require('./agents/remote');
const { createSessions, isSessionId } = require('./sessions');
const { createDictation } = require('./dictation');
const { NoteStore } = require('./notes');
const { createTasks, isTaskId } = require('./tasks');
const { ScheduleRegistry } = require('./tasks/schedules');
const { createScheduler } = require('./tasks/scheduler');
const { parseSchedule, nextRuns, describeSchedule } = require('./tasks/cron');
const { normalizeWebUrl } = require('./webLinks');
const { createLinkPreview } = require('./linkPreview');
const { resolveMedia } = require('./media');
const { uniqueDest } = require('./server');
const { fingerprint } = require('./authProto');

// The three kinds of user-supplied audio, and where each one is remembered. The
// music an agent works to is offered a narrower choice than the other two on
// purpose: it plays for minutes at a time and ships inside the app's own data
// directory, and Ogg/Opus is both far the smallest at that length and the only
// pair that loops without a seam.
const SOUND_KINDS = Object.freeze({
  ringtone: {
    key: 'customRingtonePath',
    title: 'Choose a sound',
    filterName: 'Audio',
    extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'],
  },
  notification: {
    key: 'customNotificationPath',
    title: 'Choose a sound',
    filterName: 'Audio',
    extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'],
  },
  agentMusic: {
    key: 'customAgentMusicPath',
    title: 'Choose a music loop',
    filterName: 'Ogg Vorbis / Opus',
    extensions: ['opus', 'ogg', 'oga'],
  },
});

// The preferences the renderer may write through the bulk `setConfig` patch. An
// allowlist, so a patch can only carry what Settings actually offers.
const SETTABLE_KEYS = Object.freeze([
  'iceServers',
  'enableTailscale',
  'enableLan',
  'servicePort',
  'discoveryPort',
  'audioInputId',
  'videoInputId',
  'showAddresses',
  'linkPreviews',
  'findSessionsOnly',
  'sidebarOrder',
  'sidebarLocked',
  'ringtone',
  'ringtoneVolume',
  'customRingtonePath',
  'notificationSound',
  'notificationVolume',
  'customNotificationPath',
  'muteNotifications',
  'agentMusicEnabled',
  'agentMusic',
  'agentMusicVolume',
  'customAgentMusicPath',
  'pttEnabled',
  'pttKey',
  'pttCustomCode',
  'skippedUpdateVersion',
  'pttAllowIncoming',
  'dictationEnabled',
  'dictationPort',
  'dictationKey',
  'dictationCustomCode',
  'dictationEverywhere',
  'openAtLogin',
]);

// What a picture saved from the web is called.
//
// The name in the URL where there is one, because that is the name the person
// saving it has been looking at. Everything else — a bare host, a path ending in
// a slash, a query-string image service — falls back to something honest rather
// than to a guess, and the extension comes from what the server actually served
// rather than from what the URL claimed.
const IMAGE_EXT = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
});

function imageFilename(url, type) {
  // `image/png; charset=binary` is still image/png.
  const served = String(type || '').split(';')[0];
  const ext = IMAGE_EXT[served.trim()] || '';
  let stem = 'picture';
  try {
    const base = path.basename(decodeURIComponent(new URL(url).pathname));
    const named = base.slice(0, base.length - path.extname(base).length);
    if (named) stem = named;
  } catch {
    // A URL that will not parse cannot name anything; `picture` it is.
  }
  return `${stem}${ext}`;
}

// Bridges the main-process services to the renderer:
//   - ipcMain.handle(...)  : renderer -> main commands (request/response)
//   - bus events -> webContents 'lanchat:event' : main -> renderer notifications
// The renderer only ever sees the small, explicit surface exposed in preload.js.

function createIpc({
  config,
  getIdentity,
  hub,
  bus,
  store,
  fileSender,
  discovery,
  updater,
  linkStats,
  pip,
  agentHub,
  outbox,
  devGate,
  deviceKey,
  pins,
  netScope,
  userDataDir,
  downloadsDir,
  getWindow,
  revealWindow,
  applyLoginItem,
  onUnread,
}) {
  function emit(type, payload) {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('lanchat:event', { type, payload });
  }

  // Agents other peers have shared with us. Purely a receiver of adverts — it
  // never assumes a grant that was not sent.
  const remoteAgents = createRemoteAgents({ hub, store, bus });

  // Sessions: local workspaces that ask an agent — one of ours or one a peer
  // shared. Built here rather than in main.js because reaching a shared agent
  // means reaching `remoteAgents`, which lives here and nowhere else.
  const sessions = createSessions({ userDataDir, store, agentHub, remoteAgents, hub, bus });

  // Speech-to-text through the FluidVoice app on this machine. Nothing of it
  // crosses the wire.
  const dictation = createDictation({ config });

  // Notes: the Task Bar's own writing. Local to this machine, never sent, and
  // stored in halves — see src/main/notes.js for why the bodies are not in the
  // list.
  const notes = new NoteStore(userDataDir);

  // Agent tasks: one instruction, asked whenever it is wanted. Built here for
  // the reason sessions is — it needs `askable`, which is the sessions
  // service's and is the only implementation of agent liveness in this app.
  const tasks = createTasks({
    userDataDir,
    agentHub,
    remoteAgents,
    askable: () => sessions.askable(),
    bus,
  });

  // And the clock that runs them on their own. Not started here: startServices
  // starts it once the agents have been asked to come up, so the catch-up sweep
  // does not find every one of them switched off — see main.js.
  const schedules = new ScheduleRegistry(userDataDir);
  const scheduler = createScheduler({
    schedules,
    tasks,
    askable: () => sessions.askable(),
    bus,
  });

  // Threads that exist only on this machine. Nothing off the wire may claim one.
  //
  // Three namespaces now, and all three are checked here rather than at their
  // own call sites, so adding a fourth is one edit in one place. A task is the
  // newest of them and the one with the most to lose by being left out: its
  // thread id is what an answer comes back on, so a namespace missing from this
  // list is a namespace a peer can put a fabricated result into.
  function isLocalThreadId(id) {
    return Boolean((agentHub && agentHub.isAgent(id)) || isSessionId(id) || isTaskId(id));
  }

  // A peer's request to one of our agents. Stored under that agent's own thread
  // so the human chat with them stays clean, while still showing us in full what
  // they asked — the transparency this replaces, not removes.
  bus.on('agent-request', ({ threadId, peerId, text, ts }) => {
    const message = {
      id: crypto.randomUUID(),
      peerId: threadId,
      direction: 'in',
      kind: 'text',
      text,
      ts: ts || Date.now(),
      askedBy: peerId,
    };
    store.append(threadId, message);
    emit('chat', message);
  });

  // An agent's owner going offline takes their agents with them, rather than
  // leaving contacts behind that silently fail.
  let onlinePeers = new Set();
  bus.on('presence', (list) => {
    const nowOnline = new Set(list.filter((p) => p.online && p.kind !== 'agent').map((p) => p.id));
    const gone = [...onlinePeers].filter((id) => !nowOnline.has(id));
    // Recorded before the drops rather than after them: dropping emits presence
    // and re-enters this listener, and a record still naming the owner we are
    // part-way through dropping would ask for them to be dropped all over again.
    onlinePeers = nowOnline;
    for (const id of gone) remoteAgents.dropOwner(id);
  });

  // ---- main -> renderer event forwarding ----
  bus.on('presence', (list) => emit('presence', list));
  bus.on('tailnet-peers', (list) => emit('tailnet-peers', list));
  bus.on('tailnet-status', (s) => emit('tailnet-status', s));
  bus.on('file-progress', (p) => emit('file-progress', p));
  bus.on('update-progress', (p) => emit('update-progress', p));
  bus.on('link-stats', (s) => emit('link-stats', s));
  bus.on('pip', (on) => emit('pip', on));
  bus.on('update-log', (m) => emit('toast', { level: 'info', text: m }));
  bus.on('update-available', (info) => emit('update-available', info));
  bus.on('outbox-counts', (counts) => emit('outbox-counts', counts));
  // A queued message finally went out — update the bubble that was pending.
  bus.on('outbox-sent', (msg) => msg && emit('chat', msg));
  // Which agents each peer is sharing with us. Not the same set as the roster —
  // an agent shared without direct chat is routable by `@name` while
  // deliberately not being a contact — so the composer's menu is fed from here
  // rather than from presence. See sharedBy() in agents/remote.js.
  bus.on('agent-offers', (offers) => emit('peer-agents', offers));
  bus.on('agent-status', (s) => emit('agent-status', s));
  bus.on('agent-delta', (d) => emit('agent-delta', d));
  bus.on('agent-approval', (a) => emit('agent-approval', a));
  // The question is over, and not because this window answered it: a delegate
  // did, or it ran out of time, or the run ended underneath it. Either way the
  // card has to come down on its own — a prompt left on screen for something
  // already decided is a prompt somebody will click.
  bus.on('agent-approval-closed', (a) => emit('agent-approval-closed', a));
  // Addressed to the thread that is waiting on the run rather than to the agent,
  // which are the same id unless a session asked. See deliver() in agents/index.js.
  bus.on('agent-typing', ({ agentId, threadId, isTyping }) =>
    emit('typing', { peerId: threadId || agentId, isTyping })
  );
  // A run that finished with nothing in it. Carries a thread id rather than an
  // agent id because a peer's conversation with a local agent lives in its own
  // delegate thread, and that is the thread the window has to answer in.
  // Named as well as addressed, because a session may have put one question to
  // several agents and has to say which of them came back with nothing.
  bus.on('agent-empty', ({ threadId, agentId, agentName }) => {
    emit('agent-empty', { peerId: threadId, agentId, agentName });
    if (isSessionId(threadId)) sessions.noteOutcome({ threadId, agentId, kind: 'empty' });
    // A task's run that finished with nothing in it. Still an ending, so the
    // record stops saying "working" — the same funnel every other ending goes
    // through.
    if (isTaskId(threadId)) tasks.noteOutcome({ threadId, agentId, kind: 'empty' });
  });
  // The list of tasks changed: one was written, run, or has just answered.
  bus.on('tasks', (list) => emit('tasks', list));
  // And the schedules, when one fires and rolls on to its next moment — which
  // happens with nobody touching anything, so it has to be pushed.
  bus.on('schedules', (list) => emit('schedules', list));
  // Where a session's question stands: who was asked, who is still thinking, and
  // who was left out. Worked out in main, which is the only place that knows,
  // and pushed rather than reassembled in the window out of four kinds of event.
  bus.on('session-round', (round) => emit('session-round', round));

  // A refusal, for the roster to explain. An old build and an attacker are
  // refused identically — this only decides which sentence is shown, and it is
  // shown here rather than sent back over the wire, which is what makes it safe
  // to be helpful about it.
  bus.on('peer-auth-failed', (info) => emit('peer-auth-failed', info));

  // A pinned peer turned up with a different key. Held rather than acted on:
  // accepting it is a separate, deliberate step, the way SSH makes you remove
  // the old host key by hand. Nothing here auto-accepts and nothing times out
  // into accepting.
  const pendingKeyChange = new Map();
  bus.on('peer-key-alarm', (alarm) => {
    if (alarm.reason === 'key-changed' && alarm.offered) {
      pendingKeyChange.set(alarm.peerId, alarm.offered);
    }
    emit('peer-key-alarm', {
      ...alarm,
      knownFingerprint: alarm.known ? fingerprint(alarm.known) : null,
      offeredFingerprint: alarm.offered ? fingerprint(alarm.offered) : null,
      name: (hub.identities.get(alarm.peerId) || {}).name || (pins && pins.get(alarm.peerId)?.name) || null,
    });
  });

  bus.on('file-received', (info) => {
    const message = {
      id: info.transferId || crypto.randomUUID(),
      peerId: info.from,
      direction: 'in',
      kind: 'file',
      file: { name: info.name, path: info.path, size: info.size, mime: info.mime },
      ts: Date.now(),
      pending: false,
    };
    store.append(info.from, message);
    emit('chat', message);
  });

  bus.on('peer-hello', ({ peerId, identity }) => {
    emit('peer-hello', { peerId, identity });
  });

  bus.on('peer-message', (msg) => {
    const from = msg.from;
    if (!from) return;
    // Agent and session ids are namespaced and only ever originate locally: an
    // agent is a connector on this machine and a session is a workspace in this
    // window, and neither is reachable from the network by design. A frame off
    // the wire claiming one is a peer impersonating a local thread — drop it.
    // The marker is a Symbol, so JSON.parse cannot forge it (see
    // agents/index.js).
    //
    // Both namespaces are checked in one place on purpose. A session receives
    // agent replies through this same bus, so the guard had to admit it; a guard
    // that admitted it by name would have been a hole in the one rule that keeps
    // local threads local.
    if (isLocalThreadId(from) && !msg[AGENT_LOCAL_ORIGIN]) {
      console.warn('[ipc] dropped a wire frame claiming a local thread id:', from);
      return;
    }
    // Link-quality control frames are consumed here, never shown as chat.
    if (linkStats && linkStats.handleMessage(msg)) return;
    switch (msg.type) {
      case 'chat': {
        // An answer to a task. It goes onto the task record and nowhere else:
        // there is no thread for it to be appended to and no bubble for it to
        // become, which is the whole shape of the feature. Note what is *not*
        // here — no store.append, and no emit('chat'). That absence is the
        // mechanical guarantee that running a task cannot write into anybody's
        // conversation, rather than a promise that it will not.
        //
        // First, above the session branch and above every router below, for the
        // reason that branch is above them: an answer that happened to open
        // with "@" must not be read as a fresh question and asked again.
        if (isTaskId(from)) {
          tasks.noteReply(msg);
          break;
        }
        // An answer an agent gave a session. It is already addressed to the
        // thread it belongs in, and it must not be offered to the agent routers
        // below: an answer that happened to open with "@" would otherwise be
        // read as a fresh question and asked all over again.
        if (isSessionId(from)) {
          // A run that failed. Never stored — it is a notice like any other — but
          // the window gives it a countdown rather than sweeping it quietly, and
          // it names the question it failed so that question stops counting.
          const failed = msg.error === true;
          const answer = {
            id: msg.id || crypto.randomUUID(),
            peerId: from,
            direction: 'in',
            kind: 'text',
            text: msg.text,
            ts: msg.ts || Date.now(),
            ...(msg.notice === true && { notice: true }),
            ...(failed && { error: true, ...(msg.failedRef && { failedRef: msg.failedRef }) }),
            // The pictures the answer is talking about. Carried explicitly
            // because this message is built field by field: a new field on a
            // reply is not a new field here until it is named. Unconditional in
            // this branch — the guard above has already established that a
            // message addressed to a session came from a local agent.
            ...(msg.media && { media: msg.media }),
            // Who answered. A session can put one question to several agents, so
            // an answer that does not say whose it is is an opinion from nobody.
            // Only here, in a session: an agent's own thread is already the
            // answer to "who", and labelling every message in it would be words
            // with no reader.
            ...(msg.agentName && { speaker: msg.agentName, agentId: msg.agentId }),
          };
          if (!answer.notice) store.append(from, answer);
          emit('chat', answer);
          // The mark a failed question keeps is no longer this message's to make.
          // One agent failing says nothing about whether a question three of them
          // were asked went unanswered, so the round decides at the end — see
          // closeRound() in sessions/index.js.
          //
          // Queue chatter is not an outcome: being told an agent is busy is not
          // that agent's run ending.
          if (!answer.notice || failed) {
            sessions.noteOutcome({
              threadId: from,
              agentId: msg.agentId,
              kind: failed ? 'error' : 'answer',
              text: msg.text,
            });
          }
          break;
        }
        // A message from a real peer may be addressed to a local agent, gated on
        // that agent's reach and enabled state. When it is, the request belongs
        // in that agent's own thread rather than in the human chat — otherwise
        // asking an agent something graffitis a real conversation. You still see
        // everything the peer asked; `agent-request` files it under "via <peer>".
        if (agentHub && agentHub.routeFromPeer(from, msg.text)) break;
        // A turn-queue notice is true only for the moment it arrives, so it is
        // shown and then dropped — a saved conversation should hold what was
        // said, not the scheduling around it. Honoured only behind the Symbol
        // marker: the guard above drops wire frames claiming an agent id, but
        // without this a peer could flag their own chat message and have it
        // leave no trace on our disk.
        const notice = msg.notice === true && msg[AGENT_LOCAL_ORIGIN] === true;
        // Behind the same marker, and for the same reason: a peer must not be
        // able to flag their own chat message as one of our failed runs and have
        // it erase itself off our disk.
        const failed = msg.error === true && msg[AGENT_LOCAL_ORIGIN] === true;
        // Behind the marker for a third time, and this is the one where it
        // matters most. A path on a message is a path the window will fetch back
        // and draw, so honouring one a peer sent would be letting somebody else
        // decide which files on this machine appear on this screen. An agent
        // running here may name a picture it made; a frame off the wire may not
        // name anything. Nothing on the wire carries this field today — see
        // reply() in agents/index.js, which keeps it off the relayed copy — so
        // the guard is what makes that true rather than merely currently so.
        const media = Array.isArray(msg.media) && msg[AGENT_LOCAL_ORIGIN] === true ? msg.media : null;
        const message = {
          id: msg.id || crypto.randomUUID(),
          peerId: from,
          direction: 'in',
          kind: 'text',
          text: msg.text,
          ts: msg.ts || Date.now(),
          ...(notice && { notice: true }),
          ...(failed && { error: true, ...(msg.failedRef && { failedRef: msg.failedRef }) }),
          ...(media && { media }),
        };
        if (!notice) store.append(from, message);
        if (failed && msg.failedRef) store.update(from, msg.failedRef, { failed: true });
        emit('chat', message);
        break;
      }
      // A peer typing into a shared agent's own thread rather than using @name.
      // Every gate the @name path applies is re-applied inside routeDirect.
      case 'agent-chat': {
        if (agentHub) agentHub.routeDirect(from, msg.agentId, msg.text);
        break;
      }
      // A peer's bare `@name`: nothing is asked, so nothing is run and no turn is
      // spent. The same three gates as a question are re-applied inside
      // routeSummon — the greeting is this machine's to give or withhold.
      case 'agent-summon': {
        if (agentHub) agentHub.routeSummon(from, msg.agentId);
        break;
      }
      // A peer offering a passcode for the right to answer one of our agents'
      // permission prompts. Every gate — reach, delegation, the passcode itself
      // and its lockout — is applied inside claimApprovals, in one place, for
      // the same reason the three routing gates are.
      case 'agent-approval-claim': {
        if (agentHub) agentHub.claimApprovals(from, msg.agentId, msg.passcode);
        break;
      }
      // An owner's answer to a claim of ours.
      case 'agent-approval-grant': {
        const result = remoteAgents && remoteAgents.setApprovalToken(from, msg);
        if (result) {
          emit('agent-approval-grant', {
            threadId: result.entry.id,
            ok: result.ok,
            lockedMs: result.lockedMs,
          });
        }
        break;
      }
      // Their agent wants to run something on their machine, and they have
      // given us the right to say yes or no. Filed as an approval on the agent's
      // own thread, exactly as one of ours is — the window draws the same card.
      case 'agent-approval-ask': {
        const req = remoteAgents && remoteAgents.receiveApproval(from, msg);
        if (req) emit('agent-approval', req);
        break;
      }
      // Somebody's answer to one of ours, from a peer we handed the right to.
      // Nothing waits on the result — the run reports itself the ordinary way —
      // but the promise is still caught: an unhandled rejection off the wire is
      // a frame from a peer being able to end the main process.
      case 'agent-approval-answer': {
        if (agentHub) {
          agentHub
            .answerRemoteApproval(from, msg)
            .catch((err) => console.error('[ipc] delegated approval failed:', err.message));
        }
        break;
      }
      // It was answered at the owner's machine, or it ran out of time.
      case 'agent-approval-close': {
        const closed = remoteAgents && remoteAgents.closeApproval(from, msg);
        if (closed) emit('agent-approval-closed', { agentId: closed.threadId, reason: closed.reason });
        break;
      }
      // A run of ours that finished with nothing in it, on a question this peer
      // asked. Resolved through remoteAgents rather than trusted: get() only
      // returns an agent this peer actually advertised to us, so nobody can make a
      // light play on somebody else's thread. An id that does not resolve is a
      // frame to drop, not one to guess at.
      case 'agent-empty': {
        // Shown wherever the answer would have gone — a session, if one asked.
        const run = remoteAgents && remoteAgents.emptyRun(from, msg.agentId);
        if (run) {
          emit('agent-empty', { peerId: run.into, agentId: run.agentId, agentName: run.agentName });
          // An empty answer is still an answer, so a round waiting on this agent
          // stops waiting on it.
          if (sessions && sessions.isSessionId(run.into)) {
            sessions.noteOutcome({ threadId: run.into, agentId: run.agentId, kind: 'empty' });
          }
        }
        break;
      }
      // An agent owned by another peer is offering, or retracting, itself.
      case 'agent-advert':
        if (remoteAgents) remoteAgents.adopt(from, msg);
        break;
      case 'agent-withdraw':
        if (remoteAgents) remoteAgents.drop(from, msg.agentId);
        break;
      // Where we stand in the queue for a shared agent.
      case 'agent-queue':
        remoteAgents.setStanding(from, msg);
        break;
      // What a shared agent is doing right now, so the far side can show
      // "thinking" rather than an unexplained silence.
      case 'agent-activity': {
        const entry = remoteAgents.setActivity(from, msg);
        // In the thread that is waiting on it: the session that asked, or the
        // agent's own thread.
        if (entry) emit('typing', { peerId: remoteAgents.threadFor(entry), isTyping: msg.busy === true });
        break;
      }
      // The answer to something we asked a remote agent. It is filed under that
      // agent's thread, not under the chat with the peer who hosts it.
      case 'agent-reply': {
        const stored = remoteAgents.receive(from, msg);
        // An answer to a task, from an agent on somebody else's machine. It
        // goes onto the task record and nowhere else, exactly as one from an
        // agent here does — and, as there, it is neither stored nor emitted as
        // a message. Handled first, so nothing below can turn it into one.
        if (stored && isTaskId(stored.peerId)) {
          tasks.noteReply({ ...stored, from: stored.peerId });
          break;
        }
        if (stored) emit('chat', stored);
        // An answer from somebody else's agent ends its slot in the round exactly
        // as one of ours does. Queue chatter does not — being told where we stand
        // in a stranger's queue is not the run ending.
        if (stored && isSessionId(stored.peerId) && (!stored.notice || stored.error)) {
          sessions.noteOutcome({
            threadId: stored.peerId,
            agentId: stored.agentId,
            kind: stored.error ? 'error' : 'answer',
            text: stored.text,
          });
        }
        break;
      }
      case 'typing':
        emit('typing', { peerId: from, isTyping: Boolean(msg.isTyping) });
        break;
      case 'signal': {
        // If launched to the tray, surface the window for an incoming call/invite
        // (but never for PTT or ICE/answer traffic).
        if (isIncomingCallSignal(msg.signal) && revealWindow) revealWindow();
        emit('signal', { peerId: from, signal: msg.signal });
        break;
      }
      case 'file-offer':
        // The permit that lets the upload through is issued by the grant issuer
        // in grants.js, on this same bus event. This is only the chat bubble.
        emit('file-offer', { peerId: from, ...msg });
        break;
      default:
        break;
    }
  });

  // ---- renderer -> main commands ----
  ipcMain.handle('lanchat:getState', () => ({
    identity: getIdentity(),
    configured: config.isConfigured,
    config: publicConfig(config),
    presence: hub.presenceList(),
    // Read once at startup and kept current by the `peer-agents` event
    // afterwards. Without it a window reloaded while already connected would
    // have an empty `@` menu until some peer happened to re-advertise.
    peerAgents: remoteAgents.sharedBy(),
  }));

  ipcMain.handle('lanchat:setProfile', (_e, { displayName, avatar }) => {
    // The avatar ships inside every identity card, so cap it. The renderer
    // downscales to ~5 KB; this is a backstop against anything larger reaching
    // the wire (e.g. a future caller that forgets to downscale).
    const safeAvatar = sanitizeAvatar(avatar);
    config.set({ displayName: (displayName || '').trim() || getIdentity().hostname, avatar: safeAvatar });
    hub.emitPresence();
    emit('identity', getIdentity());
    return getIdentity();
  });

  ipcMain.handle('lanchat:getConfig', () => publicConfig(config));

  ipcMain.handle('lanchat:setConfig', (_e, patch) => {
    const allowed = {};
    for (const k of SETTABLE_KEYS) {
      if (k in patch) allowed[k] = patch[k];
    }
    config.set(allowed);
    return publicConfig(config);
  });

  // ---- agents ----
  // Every response goes through agentHub.list(), which redacts secrets to a
  // `hasSecret` boolean — a key that has been entered never comes back out.
  ipcMain.handle('lanchat:listAgents', () => agentHub.list());

  // `ok` reports whether the record was written; `probe` reports whether the
  // agent actually answered. They are deliberately separate — a connector can
  // save cleanly and still be unreachable, and the UI needs to tell them apart.
  ipcMain.handle('lanchat:addAgent', async (_e, draft) => {
    try {
      const { agent, probe } = await agentHub.add(draft);
      return { ok: true, agent, probe };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('lanchat:updateAgent', async (_e, { id, patch }) => {
    try {
      const result = await agentHub.update(id, patch);
      if (!result) return { ok: false, error: 'No such agent.' };
      return { ok: true, agent: result.agent, probe: result.probe };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('lanchat:removeAgent', async (_e, { id }) => {
    const removed = await agentHub.remove(id);
    // A session that asked this agent keeps its conversation — it is a real
    // record of what was said — but it stops claiming it can carry on, and the
    // header offers another agent instead of a name that no longer exists.
    if (removed && sessions.unbindAgent(id)) publishSessions();
    // And a task that asked it keeps its instruction — that is the work, and
    // the agent is a choice that can be made again — but it stops pointing at a
    // record that no longer exists. tasks publishes for itself.
    if (removed) tasks.unbindAgent(id);
    return { ok: removed, agents: agentHub.list() };
  });

  ipcMain.handle('lanchat:setAgentEnabled', async (_e, { id, enabled }) => {
    try {
      return { ok: true, agent: await agentHub.setEnabled(id, enabled) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('lanchat:setAgentPeers', (_e, { id, allowedPeers }) =>
    agentHub.setAllowedPeers(id, allowedPeers)
  );

  // Reach and discoverability. Deliberately separate from setAgentPeers so that
  // switching network-wide off leaves the allowlist untouched and immediately
  // governing again — the grant is narrowed, never discarded.
  ipcMain.handle('lanchat:setAgentSharing', async (_e, { id, networkWide, directChat }) => {
    try {
      const agent = await agentHub.setSharing(id, { networkWide, directChat });
      if (!agent) return { ok: false, error: 'No such agent.' };
      return { ok: true, agent };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('lanchat:testAgent', (_e, { id }) => agentHub.test(id));

  // Which Hermes profiles this agent's server will answer to. Returns an empty
  // list when none can be discovered, and the form falls back to a typed name.
  ipcMain.handle('lanchat:listAgentProfiles', async (_e, { id, draft } = {}) => {
    try {
      return { ok: true, profiles: await agentHub.profilesFor(id, draft) };
    } catch (err) {
      return { ok: false, error: err.message, profiles: [] };
    }
  });

  // Answering a permission prompt. Two destinations behind one channel, decided
  // by the id: our own agent's transport, or the owner of somebody else's agent
  // who handed us the right to answer for them. The window asks the same way
  // either way — which of the two it is, is not something a card should have to
  // know.
  ipcMain.handle('lanchat:answerAgentApproval', (_e, { agentId, runId, choice }) => {
    if (remoteAgents && remoteAgents.isRemoteAgentId(agentId)) {
      return remoteAgents.answerApproval(agentId, choice);
    }
    return agentHub.answerApproval(agentId, runId, choice);
  });

  // Asking an owner for the right to answer for them. The passcode goes out on
  // the authenticated socket and is never written down at either end — main
  // holds it only long enough to put it in the frame.
  ipcMain.handle('lanchat:claimAgentApprovals', (_e, { threadId, passcode } = {}) => {
    const found = remoteAgents && remoteAgents.resolveThread(threadId);
    if (!found) return { ok: false, error: 'That agent is not being shared with you.' };
    const sent = remoteAgents.claimApprovals(found.ownerPeerId, found.entry, passcode);
    // Only that it was asked. Whether it was granted comes back as its own
    // frame, because the owner decides it and may take a lockout to say so.
    return { ok: sent, ...(sent ? {} : { error: 'That peer is not connected.' }) };
  });

  // The owner's side of the same feature: who may answer for this agent, how
  // soon, and the passcode that proves it. One way only, like an agent's key.
  ipcMain.handle('lanchat:setAgentApprovals', async (_e, { id, ...patch } = {}) => {
    try {
      const agent = await agentHub.setApprovals(id, patch);
      if (!agent) return { ok: false, error: 'No such agent.' };
      return { ok: true, agent };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('lanchat:stopAgentRun', (_e, { agentId }) => agentHub.stopRun(agentId));

  // Developer panel gate. Verification and the password hash both stay in main
  // — the renderer only ever sees { ok, lockedMs? } back, never the hash itself,
  // and this deliberately never touches config.js/publicConfig().
  ipcMain.handle('lanchat:verifyDevPassword', (_e, password) => devGate.verify(password));

  ipcMain.handle('lanchat:setDevPassword', (_e, { newPassword } = {}) => {
    try {
      devGate.setPassword(newPassword);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('lanchat:lockDevGate', () => {
    devGate.lock();
    return true;
  });

  // Where conversations and received files live, so the UI can point at them.
  ipcMain.handle('lanchat:getPaths', () => ({
    history: store.dir,
    downloads: downloadsDir,
    config: config.file,
  }));

  ipcMain.handle('lanchat:getHistory', (_e, peerId) => store.read(peerId));

  // Saves a conversation as plain text. Deliberately not JSON: this is for
  // keeping or sharing a readable record, and the on-disk history is already
  // JSON for anyone who wants the raw form.
  ipcMain.handle('lanchat:exportHistory', async (_e, { peerId, name }) => {
    if (!peerId) return { ok: false };
    const messages = store.read(peerId);
    if (!messages.length) return { ok: false, error: 'There is nothing in this conversation yet.' };

    const who =
      String(name || peerId)
        .replace(/[^\w.\- ]+/g, '_')
        .trim() || 'chat';
    const stamp = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(getWindow(), {
      title: 'Save chat history',
      defaultPath: path.join(downloadsDir, `LanChat ${who} ${stamp}.txt`),
      filters: [{ name: 'Text file', extensions: ['txt'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    const me = getIdentity().name || 'Me';
    const lines = [
      `Chat history with ${name || peerId}`,
      `Exported ${new Date().toLocaleString()} from LanChat`,
      '',
    ];
    let lastDay = '';
    for (const m of messages) {
      const when = new Date(m.ts || Date.now());
      const day = when.toDateString();
      if (day !== lastDay) {
        lines.push(`--- ${day} ---`);
        lastDay = day;
      }
      const time = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      // `askedBy` marks a request a peer made to one of our agents, which would
      // otherwise be indistinguishable from something we asked ourselves.
      const speaker =
        m.direction === 'out' ? me : m.askedBy ? `${name || peerId} (via peer)` : name || peerId;
      const body = m.kind === 'text' || !m.kind ? m.text : `[${m.kind}]${m.fileName ? ` ${m.fileName}` : ''}`;
      lines.push(`[${time}] ${speaker}: ${body ?? ''}`);
    }
    lines.push('');

    try {
      fs.writeFileSync(result.filePath, lines.join('\n'), 'utf8');
    } catch (err) {
      return { ok: false, error: err.message };
    }
    return { ok: true, path: result.filePath, count: messages.length };
  });

  // Clears one conversation. Anything still queued for that peer is dropped
  // too — leaving pending messages behind would resurrect bubbles from a chat
  // the user just deleted.
  ipcMain.handle('lanchat:clearHistory', (_e, { peerId }) => {
    if (!peerId) return { ok: false };
    const cleared = store.clear(peerId);
    if (outbox && typeof outbox.clear === 'function') outbox.clear(peerId);
    return { ok: cleared };
  });

  // ---- sessions ----
  //
  // A session is a local workspace with a conversation in it: no presence, no
  // key, no address, and nothing on the wire. Its messages live in the ordinary
  // store under its own id, so history, export and delete need nothing here —
  // only the list itself, and the one way text gets into one from outside.

  // Both lists, always together. Every change that matters here moves a record
  // from one of them to the other, so publishing one without the other is the
  // one way the window could end up showing a session in two places or in
  // neither.
  function publishSessions() {
    emit('sessions', sessions.list());
    emit('trash', sessions.listTrash());
  }

  ipcMain.handle('lanchat:listSessions', () => sessions.list());

  ipcMain.handle('lanchat:createSession', (_e, draft) => {
    const record = sessions.create(draft || {});
    publishSessions();
    return record;
  });

  ipcMain.handle('lanchat:renameSession', (_e, { id, title }) => {
    const record = sessions.rename(id, title);
    if (record) publishSessions();
    return record;
  });

  // Who a session asks: a list of agents, or whoever is available, whether they
  // are asked all at once, one after another, or left to talk to each other —
  // and, for that last one, how many turns they get.
  ipcMain.handle('lanchat:setSessionCounsel', (_e, { id, agentIds, allAgents, mode, turns }) => {
    const record = sessions.setCounsel(id, { agentIds, allAgents, mode, turns });
    if (record) publishSessions();
    return record;
  });

  // The one-agent door into the same thing. Nothing in this window uses it any
  // more, but it costs three lines and it is what a renderer from before counsels
  // existed calls — and what `createSession({ agentId })` means.
  ipcMain.handle('lanchat:setSessionAgent', (_e, { id, agentId }) => {
    const record = sessions.setAgent(id, agentId);
    if (record) publishSessions();
    return record;
  });

  // Everyone this machine could put a question to, for the picker in a session's
  // header. Not the roster: the roster is who you can talk to, and this is who
  // can be asked — a distinction that matters for an agent shared without direct
  // chat, which is reachable and deliberately not a contact.
  ipcMain.handle('lanchat:askableAgents', () => sessions.askable());

  // The question a session already has out, for a window that has just opened or
  // just switched threads. Live state is pushed as it changes; this is how a
  // reader who missed the push catches up.
  ipcMain.handle('lanchat:sessionRound', (_e, { id }) => sessions.roundFor(id));

  // Calling off the question a session has out. Mainly for a discussion between
  // agents, which is the only thing here that keeps going without anybody typing,
  // but it works on any open round: a run that has stopped being worth waiting
  // for is a run that has stopped being worth waiting for.
  ipcMain.handle('lanchat:stopSessionRound', (_e, { id }) => ({ ok: sessions.stopRound(id) }));

  // Deleting a session puts it in the Trash. Same channel it has always been,
  // and the same `{ ok }` back: what changed is that the transcript stays on
  // disk until somebody says otherwise — see sessions/index.js.
  ipcMain.handle('lanchat:deleteSession', (_e, { id }) => {
    const ok = sessions.trash(id);
    if (ok) publishSessions();
    return { ok };
  });

  // ---- the Trash ----

  ipcMain.handle('lanchat:listTrash', () => sessions.listTrash());

  ipcMain.handle('lanchat:restoreSession', (_e, { id }) => {
    const record = sessions.restore(id);
    if (record) publishSessions();
    return record;
  });

  // The irreversible one. The window asks first; this end only does as it is
  // told, because a confirmation belongs where the person is.
  ipcMain.handle('lanchat:purgeSession', (_e, { id }) => {
    const ok = sessions.purge(id);
    if (ok) publishSessions();
    return { ok };
  });

  ipcMain.handle('lanchat:restoreAllSessions', () => {
    const count = sessions.restoreAll();
    if (count) publishSessions();
    return { ok: true, count };
  });

  ipcMain.handle('lanchat:purgeAllSessions', () => {
    const count = sessions.purgeAll();
    if (count) publishSessions();
    return { ok: true, count };
  });

  // ---- notes ----
  //
  // The Task Bar's first view. A note has no peer, no thread and no presence:
  // it is this machine's own writing, and none of it goes anywhere.
  //
  // The bodies travel one at a time, on `readNote`. A list channel that carried
  // them would send every word of every note across the bridge to draw a column
  // of titles — and the whole reason the store is split in two is so that never
  // has to happen.

  // Both lists, always together, for the reason publishSessions gives: every
  // change that matters moves a record from one of them to the other, and
  // publishing one without the other is how a note ends up in two places or in
  // neither.
  function publishNotes() {
    emit('notes', notes.list());
    emit('noteTrash', notes.trashed());
  }

  ipcMain.handle('lanchat:listNotes', () => notes.list());
  ipcMain.handle('lanchat:listNoteTrash', () => notes.trashed());
  ipcMain.handle('lanchat:readNote', (_e, { id }) => notes.read(id));

  ipcMain.handle('lanchat:createNote', (_e, draft) => {
    const record = notes.create(draft || {});
    publishNotes();
    return record;
  });

  // The editor's save, and the one call in this file that is expected to arrive
  // several times a second. It publishes only when the record actually moved —
  // see notes.js: a body-only save inside the coalescing window leaves the
  // metadata alone, and republishing an unchanged list would undo the point of
  // that by re-rendering the column on every keystroke instead.
  ipcMain.handle('lanchat:saveNote', (_e, { id, title, body, final }) => {
    const before = notes.get(id);
    const at = before ? before.updatedAt : null;
    const record = notes.save(id, { title, body, final });
    if (record && record.updatedAt !== at) publishNotes();
    return record;
  });

  ipcMain.handle('lanchat:deleteNote', (_e, { id }) => {
    const ok = notes.trash(id);
    if (ok) publishNotes();
    return { ok };
  });

  ipcMain.handle('lanchat:restoreNote', (_e, { id }) => {
    const ok = notes.restore(id);
    if (ok) publishNotes();
    return { ok };
  });

  // The irreversible one. The window asks first; this end only does as it is
  // told, because a confirmation belongs where the person is.
  ipcMain.handle('lanchat:purgeNote', (_e, { id }) => {
    const ok = notes.purge(id);
    if (ok) publishNotes();
    return { ok };
  });

  ipcMain.handle('lanchat:restoreAllNotes', () => {
    const count = notes.restoreAll();
    if (count) publishNotes();
    return { ok: true, count };
  });

  ipcMain.handle('lanchat:purgeAllNotes', () => {
    const count = notes.purgeAll();
    if (count) publishNotes();
    return { ok: true, count };
  });

  // ---- agent tasks ----
  //
  // A standing instruction and the agent it is put to. The answers do not
  // travel on this surface: `runs` fetches them for one task when one is
  // opened, for the reason note bodies are fetched one at a time.

  ipcMain.handle('lanchat:listTasks', () => tasks.list());
  ipcMain.handle('lanchat:taskRuns', (_e, { id, limit }) => tasks.runs(id, limit));

  ipcMain.handle('lanchat:createTask', (_e, draft) => tasks.create(draft || {}));
  ipcMain.handle('lanchat:updateTask', (_e, { id, patch }) => tasks.update(id, patch || {}));
  ipcMain.handle('lanchat:deleteTask', (_e, { id }) => {
    const ok = tasks.remove(id);
    // The schedules go with it. One left behind is a clock with nothing on the
    // other end: it would come round forever, refuse every time, and there
    // would be no task left to reach it through and switch it off.
    if (ok && schedules.removeForTask(id)) emit('schedules', schedules.list());
    return { ok };
  });

  // Running one by hand. A refusal comes back with the sentence to show for it
  // rather than a bare false — the same bargain a session's composer strikes:
  // being told why costs nobody their words.
  ipcMain.handle('lanchat:runTask', (_e, { id }) => tasks.run(id, { by: 'manual' }));
  ipcMain.handle('lanchat:stopTask', (_e, { id }) => tasks.stop(id));

  // ---- scheduled tasks ----
  //
  // A task, a spec that says when, and the moment it is next due. That moment
  // is computed here on every change rather than at fire time: the tick has to
  // be a numeric comparison, and a number on disk is only ever as good as the
  // last time something worked it out.

  function publishSchedules() {
    emit('schedules', schedules.list());
  }

  ipcMain.handle('lanchat:listSchedules', () => schedules.list());

  // What a spec would actually do, in times and in words. This is the whole of
  // the validation a cron expression can have — and it runs the same walker the
  // scheduler does, so it cannot promise a moment that will not happen.
  ipcMain.handle('lanchat:previewSchedule', (_e, { spec, count }) => {
    if (!parseSchedule(spec)) return { ok: false, error: 'That is not a schedule this can read.' };
    const next = nextRuns(spec, Date.now(), count || 3) || [];
    if (next.length === 0) return { ok: false, error: 'That will never come round.' };
    return { ok: true, next, describes: describeSchedule(spec) };
  });

  ipcMain.handle('lanchat:createSchedule', (_e, { taskId, spec }) => {
    if (!tasks.get(taskId)) return { ok: false, error: 'That task is no longer here.' };
    const nextRunAt = scheduler.nextFor(spec);
    if (!nextRunAt) return { ok: false, error: 'That is not a schedule this can read.' };
    const record = schedules.create({ taskId, spec, nextRunAt });
    publishSchedules();
    return record;
  });

  ipcMain.handle('lanchat:updateSchedule', (_e, { id, patch }) => {
    const before = schedules.get(id);
    if (!before) return null;
    const spec = patch && patch.spec !== undefined ? patch.spec : before.spec;
    const nextRunAt = scheduler.nextFor(spec);
    // A spec that cannot be read is refused rather than saved and silently
    // never fired, which is the failure nobody would notice.
    if (patch && patch.spec !== undefined && !nextRunAt) {
      return { ok: false, error: 'That is not a schedule this can read.' };
    }
    const record = schedules.update(id, { ...patch, nextRunAt });
    if (record) publishSchedules();
    return record;
  });

  // Switching one off, and back on. Coming back on recomputes when it is next
  // due from now — a schedule that was off for a week must not come back
  // already overdue and fire the moment it is enabled.
  ipcMain.handle('lanchat:setScheduleEnabled', (_e, { id, enabled }) => {
    const record = schedules.get(id);
    if (!record) return null;
    const on = Boolean(enabled);
    const updated = schedules.update(id, {
      enabled: on,
      nextRunAt: on ? scheduler.nextFor(record.spec) : record.nextRunAt,
    });
    if (updated) publishSchedules();
    return updated;
  });

  ipcMain.handle('lanchat:deleteSchedule', (_e, { id }) => {
    const ok = schedules.remove(id);
    if (ok) publishSchedules();
    return { ok };
  });

  // Clearing out errors an older version wrote into a session's history.
  //
  // The ids come from the window, which is where the person was asked whether
  // they wanted this — deleting somebody's history is not something to decide
  // for them. Only sessions: the Commit box is a session's, and the correction
  // that goes with the removal has nowhere to live on any other kind of thread.
  ipcMain.handle('lanchat:sweepSessionErrors', (_e, { id, ids }) => {
    if (!isSessionId(id)) return { ok: false, removed: 0 };
    const { removed } = sessions.sweepErrors(id, ids);
    if (removed) publishSessions();
    return { ok: true, removed };
  });

  // Summoning an agent chosen from the composer's `@` menu.
  //
  // By thread id rather than by writing `@Name` and letting matchMention read it
  // back. The menu already knows exactly which agent was picked, and turning that
  // into text only to parse it again introduces a way for it to go wrong: two
  // agents whose names share a prefix, a name that stopped being advertised
  // between the menu opening and the key being pressed, or any mention that fails
  // to match and falls through to the chat frame below — which would drop a bare
  // `@Name` into the conversation with a person, the one place agent traffic must
  // never go.
  ipcMain.handle('lanchat:summonAgent', (_e, { threadId }) => {
    const remote = remoteAgents.resolveThread(threadId);
    // Gone between the menu being drawn and this arriving. Refused rather than
    // guessed at, and the window says so.
    if (!remote) return { summoned: false, delivered: false, threadId };
    return remoteAgents.summon(remote.ownerPeerId, remote.entry);
  });

  // Taking named messages out of any thread.
  //
  // Separate from sweepSessionErrors above, which also corrects a session's
  // commit total. This one only removes: it is used for the summon lines and
  // greetings older builds left in *agent* threads, where there is no Commit box
  // and subtracting from one would be adjusting a number nothing displays.
  //
  // It now also reaches sessions, where there *is* a Commit box: a question that
  // failed is retired once the question sent to replace it has been answered
  // (retireSuperseded in App.jsx). Still nothing to correct, and for a better
  // reason than "nobody is looking" — commitCount already skips a message marked
  // `failed`, so a failed question was never in the total and removing it cannot
  // take it out twice. `unlinkedFailures` is untouched by design: it counts the
  // failures that could not be pinned to a question, which is the opposite of
  // this one.
  //
  // The ids are decided in the window, which is the only place that knows what is
  // on screen and has just counted it down in front of somebody.
  ipcMain.handle('lanchat:purgeMessages', (_e, { id, ids }) => {
    if (!id || !Array.isArray(ids) || !ids.length) return { ok: false, removed: 0 };
    return { ok: true, removed: store.remove(id, ids) };
  });

  // Loading a saved conversation back in. Read through readDocument, which is
  // already the app's answer to "turn this file into text somebody can be asked
  // about": it refuses binaries by name, decodes what Notepad writes, extracts
  // from PDFs, and fails with a sentence fit to show. A transcript is exactly
  // that kind of file, so it gets exactly that treatment.
  ipcMain.handle('lanchat:importSessionText', async (_e, { id }) => {
    if (!sessions.get(id)) return { ok: false, error: 'That session no longer exists.' };
    const result = await dialog.showOpenDialog(getWindow(), {
      title: 'Upload a conversation',
      properties: ['openFile'],
      filters: [
        { name: 'Text', extensions: ['txt', 'md', 'log', 'json', 'csv'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    const file = result.filePaths[0];
    let doc;
    try {
      doc = readDocument(file);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    // The file's own time, so an imported conversation sits in the past where it
    // belongs rather than claiming to have happened just now. Only the
    // plain-text path needs it; an export carries its own clock.
    let at = Date.now();
    try {
      at = fs.statSync(file).mtimeMs;
    } catch {
      // Unreadable timestamp on a file we just read: not worth failing an
      // import over, so it keeps the default.
    }
    const imported = sessions.importText(id, doc.text, { source: doc.name, at });
    if (imported.ok) publishSessions();
    return imported;
  });

  ipcMain.handle('lanchat:sendChat', (_e, { peerId, text, docPaths, context }) => {
    // Attached documents become part of the prompt, because there is nowhere
    // else for them to go: no agent transport carries attachments. What is sent
    // and what is remembered therefore differ, and deliberately so — `prompt`
    // holds the documents' text and goes to the agent, while `text` stays what
    // the person actually typed and is what the transcript keeps. Storing the
    // prompt instead would put a whole PDF in the message list and in history.
    const { docs, prompt } = withDocuments(peerId, text, docPaths);

    // A session asks the agent it was given, whether that is one of ours or one
    // a peer shared. The quoted context a fork carries travels the same way the
    // documents do — as words in the prompt, and not into the transcript.
    if (isSessionId(peerId)) return sessions.send(peerId, text, { prompt, docs, context });

    // Talking to an agent somebody else shared: the frame goes to its owner, and
    // our copy is filed under the agent's thread rather than under the chat with
    // them.
    const remote = remoteAgents.resolveThread(peerId);
    if (remote) return remoteAgents.send(remote.ownerPeerId, remote.entry, text, { prompt, docs });
    // `@Hermes …` typed in the chat with the agent's owner is the same
    // conversation reached a different way, so it goes to the same place. This
    // is what makes the agent's thread appear without it having to be shared for
    // direct chat.
    const mention = remoteAgents.matchMention(peerId, text);
    if (mention) {
      // `@name` with nothing after it is a summon rather than a question: it asks
      // the agent to be here, not to do anything. Nothing is filed for it — not
      // here and not on the owner's machine — so it has to be consumed here all
      // the same. Letting it fall through to the ordinary chat frame below is what
      // would leave a bare `@name` sitting in the conversation with a person.
      if (!mention.text) return remoteAgents.summon(mention.ownerPeerId, mention.entry);
      return remoteAgents.send(mention.ownerPeerId, mention.entry, mention.text, {
        prompt: composePrompt(mention.text, docs),
        docs,
      });
    }

    // A picture named in a message the person at the keyboard typed.
    //
    // Nothing is stripped here, unlike an agent's reply: this is prose somebody
    // wrote and sent to somebody else, and the copy kept has to be the copy sent.
    // So the frame, the queued retry and the stored message below all still
    // carry exactly what was typed, and the only thing this adds is the picture
    // underneath it.
    //
    // The preview is the sender's alone, and that is not an oversight: the file
    // itself does not travel. Naming a path tells the other end where something
    // is on a machine they cannot read; sending them the file is what the
    // paperclip is for.
    const { media } = resolveMedia(text, { strip: false });
    for (const item of media) bus.emit('allow-preview', item.path);
    const message = {
      id: crypto.randomUUID(),
      peerId,
      direction: 'out',
      kind: 'text',
      text,
      ts: Date.now(),
      ...(docs.length && { docs: docs.map((d) => ({ name: d.name, bytes: d.bytes })) }),
      ...(media.length && { media }),
    };
    const ok = hub.send(peerId, { type: 'chat', id: message.id, text: prompt, ts: message.ts });
    // Undelivered messages are held and retried when the peer reconnects, so
    // the bubble is stored as pending rather than silently lost. The queue gets
    // the prompt, not the stored text: a retry must carry the documents too, or
    // the agent would eventually be asked about a file it was never given.
    if (!ok) {
      message.pending = true;
      outbox.enqueue(peerId, { ...message, text: prompt });
    }
    store.append(peerId, message);
    return { ...message, delivered: ok };
  });

  ipcMain.handle('lanchat:sendTyping', (_e, { peerId, isTyping }) => {
    hub.send(peerId, { type: 'typing', isTyping });
    return true;
  });

  ipcMain.handle('lanchat:sendSignal', (_e, { peerId, signal }) => {
    const ok = hub.send(peerId, { type: 'signal', signal });
    return { delivered: ok };
  });

  ipcMain.handle('lanchat:pickAndSendFile', async (_e, { peerId }) => {
    const win = getWindow();
    const result = await dialog.showOpenDialog(win, {
      title: 'Send file(s)',
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled) return { sent: [] };
    return sendFiles(peerId, result.filePaths);
  });

  ipcMain.handle('lanchat:sendFilePaths', (_e, { peerId, paths }) => sendFiles(peerId, paths));

  // A recorded voice message arrives as bytes rather than a path, so it is
  // written to disk first and then sent down the ordinary file-transfer path.
  // Kept alongside history so it survives as the local copy of what was sent.
  ipcMain.handle('lanchat:sendVoice', async (_e, { peerId, data, ext }) => {
    if (!peerId || !data) return { sent: [] };
    const dir = path.join(path.dirname(config.file), 'voice');
    try {
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(dir, `Voice message ${stamp}${ext || '.weba'}`);
      fs.writeFileSync(file, Buffer.from(data));
      return sendFiles(peerId, [file]);
    } catch (err) {
      emit('toast', { level: 'error', text: `Could not save the recording: ${err.message}` });
      return { sent: [] };
    }
  });

  // ---- dictation ----
  //
  // Speech recorded in an agent or session thread, transcribed on this machine
  // by the FluidVoice app over its loopback API. The audio goes straight from
  // memory to that socket: it is never written to disk and never leaves here.
  ipcMain.handle('lanchat:dictate', (_e, { data }) => dictation.transcribe({ data }));

  // Is FluidVoice reachable, and is it FluidVoice? Asked by Settings, which shows
  // the answer next to the field rather than making the user find out by holding
  // a key and getting nothing.
  ipcMain.handle('lanchat:probeDictation', (_e, { port } = {}) => dictation.probe(port));

  // ---- device identity and known peers ----

  // Our own key, for reading out loud to somebody comparing it on their screen.
  ipcMain.handle('lanchat:security', () => ({
    fingerprint: deviceKey ? deviceKey.fingerprint() : null,
    publicKey: deviceKey ? deviceKey.publicKey() : null,
    keyMode: deviceKey ? deviceKey.mode() : null,
    reachability: netScope ? netScope.reachability() : null,
  }));

  ipcMain.handle('lanchat:listPins', () => (pins ? pins.list() : []));

  // Somebody compared fingerprints out loud. This is the only thing that makes
  // first-use trust falsifiable, which is why it has to be reachable.
  ipcMain.handle('lanchat:markPeerVerified', (_e, { peerId, verified = true }) => {
    if (!pins) return null;
    pins.markVerified(peerId, verified);
    hub.emitPresence();
    return pins.get(peerId);
  });

  // Accepting a changed key. Deliberate, explicit, and it revokes everything the
  // old key had been granted — otherwise clicking through the warning hands an
  // impostor every agent the real peer could reach, which would make the warning
  // the only thing standing between them and the agents.
  ipcMain.handle('lanchat:repinPeer', (_e, { peerId }) => {
    if (!pins) return null;
    const offered = pendingKeyChange.get(peerId);
    if (!offered) return null;
    pendingKeyChange.delete(peerId);
    const record = pins.repin(peerId, offered);
    const revoked = agentHub && agentHub.revokePeer ? agentHub.revokePeer(peerId) : [];
    discovery.refresh();
    return { record, revoked };
  });

  ipcMain.handle('lanchat:forgetPeer', (_e, { peerId }) => {
    if (!pins) return false;
    pendingKeyChange.delete(peerId);
    return pins.forget(peerId);
  });

  // Whether we accept connections that did not arrive on the tailnet. Its own
  // channel rather than a `setConfig` key, for the reason in publicConfig().
  ipcMain.handle('lanchat:setAcceptLan', (_e, { on }) => {
    config.set({ acceptLan: Boolean(on) });
    if (netScope) netScope.refresh();
    return publicConfig(config);
  });

  ipcMain.handle('lanchat:addManualPeer', (_e, { ip, port }) => {
    const entry = `${ip}:${port || config.get('servicePort')}`;
    const list = new Set(config.get('manualPeers') || []);
    list.add(entry);
    config.set({ manualPeers: [...list] });
    discovery.refresh();
    return [...list];
  });

  // Returns the chosen image as a data URL. The renderer downscales it before it
  // is stored, because the avatar travels inside the identity card on every
  // discovery probe — a full-size photo there would be wasteful on the wire.
  ipcMain.handle('lanchat:pickAvatar', async () => {
    const win = getWindow();
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose a profile picture',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const src = result.filePaths[0];
    const stat = fs.statSync(src);
    if (stat.size > 25 * 1024 * 1024) throw new Error('image is too large (max 25 MB)');
    const buf = fs.readFileSync(src);
    return { dataUrl: `data:${guessMime(src)};base64,${buf.toString('base64')}`, name: path.basename(src) };
  });

  // Copies a chosen audio file into userData so it survives the original moving,
  // and whitelists it for the local preview endpoint the renderer plays it from.
  ipcMain.handle('lanchat:pickSound', async (_e, { kind }) => {
    const win = getWindow();
    const choice = SOUND_KINDS[kind];
    if (!choice) return null;
    const result = await dialog.showOpenDialog(win, {
      title: choice.title,
      filters: [{ name: choice.filterName, extensions: choice.extensions }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const src = result.filePaths[0];
    const soundsDir = path.join(config.dir, 'sounds');
    fs.mkdirSync(soundsDir, { recursive: true });
    const dest = path.join(soundsDir, `${kind}${path.extname(src)}`);
    fs.copyFileSync(src, dest);
    bus.emit('allow-preview', dest);
    config.set({ [choice.key]: dest });
    return { path: dest, name: path.basename(src) };
  });

  // The renderer owns call state; main needs it to know when minimising should
  // dock to picture-in-picture instead.
  ipcMain.handle('lanchat:setCallActive', (_e, active) => {
    if (pip) pip.setCallActive(active);
    return true;
  });
  ipcMain.handle('lanchat:exitPip', () => {
    if (pip) pip.exit();
    return true;
  });
  ipcMain.handle('lanchat:togglePip', () => {
    if (pip) pip.toggle();
    return true;
  });

  ipcMain.handle('lanchat:linkStats', () => (linkStats ? linkStats.all() : []));

  // ---- updates ----
  ipcMain.handle('lanchat:checkForUpdates', () => updater.check());
  ipcMain.handle('lanchat:downloadUpdate', () => updater.download());
  ipcMain.handle('lanchat:installUpdate', () => updater.install());
  ipcMain.handle('lanchat:appVersion', () => require('electron').app.getVersion());

  // Renderer owns unread state; mirror it onto the status-menu item / badge.
  // Toggle launch-at-login. Returns whether the OS accepted it (false on Linux).
  ipcMain.handle('lanchat:setOpenAtLogin', (_e, open) => {
    config.set({ openAtLogin: Boolean(open) });
    return applyLoginItem ? applyLoginItem(Boolean(open)) : false;
  });

  ipcMain.handle('lanchat:setUnread', (_e, count) => {
    if (onUnread) onUnread(count);
    return true;
  });

  ipcMain.handle('lanchat:refresh', () => {
    discovery.refresh();
    hub.emitPresence();
    return true;
  });

  ipcMain.handle('lanchat:revealFile', (_e, filePath) => {
    if (filePath) shell.showItemInFolder(filePath);
    return true;
  });

  ipcMain.handle('lanchat:openFile', (_e, filePath) => {
    if (filePath) shell.openPath(filePath);
    return true;
  });

  // ---- links in messages ----
  // A link in a bubble opens in the real browser, never inside LanChat: the
  // window has our preload attached, and nothing a peer sends should ever be
  // loaded next to it. normalizeWebUrl is what makes that true — anything that
  // is not http(s) is refused here rather than handed to the OS.
  ipcMain.handle('lanchat:openExternal', async (_e, rawUrl) => {
    const url = normalizeWebUrl(rawUrl);
    if (!url) return { ok: false, reason: 'not a web link' };
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      emit('toast', { level: 'error', text: `Could not open the link: ${err.message}` });
      return { ok: false, reason: err.message };
    }
  });

  // Unfurling a link into a card. Everything about the fetch — what may be
  // reached, how much is read, what comes back — lives in linkPreview.js.
  const electron = require('electron');
  const linkPreview = createLinkPreview({ version: (electron.app && electron.app.getVersion()) || '0' });

  ipcMain.handle('lanchat:linkPreview', (_e, rawUrl) => {
    // The setting is enforced here, not in the renderer: with previews off, no
    // request leaves this machine even if a window asks for one.
    if (config.get('linkPreviews') === false) return { ok: false, reason: 'previews are off' };
    return linkPreview.get(rawUrl);
  });

  // A link that is itself a picture, drawn in the bubble instead of sitting
  // there as a URL. Behind the same setting and for the same reason: it is the
  // one that decides whether a message can cause this machine to connect
  // somewhere, and a photo is no different from a card in that respect.
  ipcMain.handle('lanchat:previewImage', (_e, rawUrl) => {
    if (config.get('linkPreviews') === false) return { ok: false, reason: 'previews are off' };
    return linkPreview.image(rawUrl);
  });

  // Keeping one. It lands in the same folder as a file a peer sent, under the
  // same naming rules, and is allowed for preview the same way — so from the
  // moment it is saved it behaves exactly like every other file in a
  // conversation, including after a restart.
  //
  // Not behind the previews setting: that setting is about what happens on its
  // own, and this is somebody pressing a button.
  ipcMain.handle('lanchat:saveImage', async (_e, rawUrl) => {
    const shot = await linkPreview.bytes(rawUrl);
    if (!shot.ok) {
      emit('toast', { level: 'error', text: `Could not save the picture: ${shot.reason}` });
      return shot;
    }
    try {
      const dest = uniqueDest(downloadsDir, imageFilename(shot.url, shot.type));
      fs.writeFileSync(dest, shot.body);
      bus.emit('allow-preview', dest);
      return { ok: true, path: dest, name: path.basename(dest), size: shot.body.length };
    } catch (err) {
      emit('toast', { level: 'error', text: `Could not save the picture: ${err.message}` });
      return { ok: false, reason: err.message };
    }
  });

  // Threads whose far end is something that reads rather than someone who
  // receives files. A session is one of them: it asks an agent, so a document
  // staged in one has somewhere to go.
  function isAgentThread(peerId) {
    return Boolean(
      (agentHub && agentHub.isAgent(peerId)) || remoteAgents.isRemoteAgentId(peerId) || isSessionId(peerId)
    );
  }

  // Reads the documents staged against a message and folds them into the prompt.
  //
  // A file that cannot be read is reported and dropped rather than failing the
  // whole send: if two are attached and one is a scan, the question should still
  // go, with the reason the other did not attached to it.
  function withDocuments(peerId, text, docPaths) {
    if (!docPaths || !docPaths.length) return { docs: [], prompt: text };
    // Documents are for agents. A peer gets files the way they always have —
    // over the file-transfer endpoint — so this refuses rather than quietly
    // pasting somebody's PDF into a chat message.
    if (!isAgentThread(peerId)) {
      emit('toast', { level: 'error', text: 'Documents can only be attached to an agent.' });
      return { docs: [], prompt: text };
    }
    const docs = [];
    for (const p of docPaths) {
      try {
        docs.push(readDocument(p));
      } catch (err) {
        emit('toast', { level: 'error', text: err.message });
      }
    }
    return { docs, prompt: composePrompt(text, docs) };
  }

  // Checks paths without reading them into a prompt, so the composer can stage a
  // chip it knows will work — and say why straight away when it will not. Only
  // the verdict crosses back; the text itself never leaves main.
  ipcMain.handle('lanchat:readDocuments', (_e, { paths }) =>
    (paths || []).map((p) => {
      try {
        const doc = readDocument(p);
        return { ok: true, path: doc.path, name: doc.name, bytes: doc.bytes, chars: doc.text.length };
      } catch (err) {
        return { ok: false, path: p, name: path.basename(p), error: err.message };
      }
    })
  );

  ipcMain.handle('lanchat:pickDocuments', async () => {
    const win = getWindow();
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose a document for the agent to read',
      filters: [
        {
          name: 'Documents',
          extensions: [
            'txt',
            'md',
            'pdf',
            'markdown',
            'rst',
            'json',
            'csv',
            'tsv',
            'log',
            'yml',
            'yaml',
            'xml',
            'html',
          ],
        },
        { name: 'All files', extensions: ['*'] },
      ],
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled) return [];
    return result.filePaths.map((p) => {
      try {
        const doc = readDocument(p);
        return { ok: true, path: doc.path, name: doc.name, bytes: doc.bytes, chars: doc.text.length };
      } catch (err) {
        return { ok: false, path: p, name: path.basename(p), error: err.message };
      }
    });
  });

  async function sendFiles(peerId, paths) {
    const sent = [];
    // Agents have no endpoint to upload to: a document reaches one as text in
    // the prompt, which is what the composer's attach button does. True of a
    // remotely-shared agent as much as a local one.
    if (isAgentThread(peerId)) {
      emit('toast', {
        level: 'error',
        text: 'Agents cannot receive files — attach a document for it to read instead.',
      });
      return { sent };
    }
    for (const p of paths) {
      try {
        const info = await fileSender.send(peerId, p);
        bus.emit('file-sent', p);
        const message = {
          id: info.transferId,
          peerId,
          direction: 'out',
          kind: 'file',
          file: { name: info.name, path: p, size: info.size, mime: info.mime },
          ts: Date.now(),
        };
        store.append(peerId, message);
        emit('chat', message);
        sent.push(message);
      } catch (err) {
        emit('toast', { level: 'error', text: `File send failed: ${err.message}` });
      }
    }
    return { sent };
  }

  return { emit, notes, tasks, schedules, scheduler };
}

const MAX_AVATAR_BYTES = 96 * 1024;

function sanitizeAvatar(avatar) {
  if (!avatar) return null;
  const out = { color: avatar.color || null, image: null };
  if (typeof avatar.image === 'string' && avatar.image.startsWith('data:image/')) {
    if (avatar.image.length <= MAX_AVATAR_BYTES) out.image = avatar.image;
    else console.warn('[ipc] avatar rejected: too large for the identity card');
  }
  return out;
}

// True only for a signal that should raise the window: a 1:1 call offer or a
// group invite. PTT and mid-call ICE/answer frames must not pop the UI open.
function isIncomingCallSignal(inner) {
  if (!inner || typeof inner !== 'object') return false;
  if (inner.channel === 'ptt') return false;
  if (inner.channel === 'group') return inner.kind === 'invite';
  return inner.kind === 'offer';
}

// Everything the renderer may see. One list, read by a pick loop rather than a
// destructure paired with an object literal: those two are free to drift, and
// when they did — a key returned that nothing had read — every config call threw
// and the window ran on its own seed defaults instead of the saved settings.
const PUBLIC_KEYS = Object.freeze([
  ...SETTABLE_KEYS,
  'manualPeers',
  // Read-only to the renderer: it is shown and it drives the Settings toggle,
  // but it is not settable through the bulk `setConfig` patch. A key that
  // decides who may open a socket to this machine gets its own channel, so it
  // can never be flipped as a side effect of saving unrelated preferences.
  'acceptLan',
]);

function publicConfig(config) {
  const out = {};
  for (const k of PUBLIC_KEYS) out[k] = config.data[k];
  return out;
}

module.exports = {
  createIpc,
  sanitizeAvatar,
  MAX_AVATAR_BYTES,
  isIncomingCallSignal,
  imageFilename,
  SETTABLE_KEYS,
  PUBLIC_KEYS,
};
