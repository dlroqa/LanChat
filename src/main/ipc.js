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
const { normalizeWebUrl } = require('./webLinks');
const { createLinkPreview } = require('./linkPreview');
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
  'openAtLogin',
]);

// Bridges the main-process services to the renderer:
//   - ipcMain.handle(...)  : renderer -> main commands (request/response)
//   - bus events -> webContents 'lanchat:event' : main -> renderer notifications
// The renderer only ever sees the small, explicit surface exposed in preload.js.

function createIpc({ config, getIdentity, hub, bus, store, fileSender, discovery, updater, linkStats, pip, agentHub, outbox, devGate, deviceKey, pins, netScope, userDataDir, downloadsDir, getWindow, revealWindow, applyLoginItem, onUnread }) {
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
  const sessions = createSessions({ userDataDir, store, agentHub, remoteAgents });

  // Threads that exist only on this machine. Nothing off the wire may claim one.
  function isLocalThreadId(id) {
    return Boolean((agentHub && agentHub.isAgent(id)) || isSessionId(id));
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
  // Addressed to the thread that is waiting on the run rather than to the agent,
  // which are the same id unless a session asked. See deliver() in agents/index.js.
  bus.on('agent-typing', ({ agentId, threadId, isTyping }) => emit('typing', { peerId: threadId || agentId, isTyping }));
  // A run that finished with nothing in it. Carries a thread id rather than an
  // agent id because a peer's conversation with a local agent lives in its own
  // delegate thread, and that is the thread the window has to answer in.
  bus.on('agent-empty', ({ threadId }) => emit('agent-empty', { peerId: threadId }));

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
          };
          if (!answer.notice) store.append(from, answer);
          // The mark outlives the error that caused it: the error is gone in ten
          // seconds, but a question nothing ever answered must still not be
          // counted as one tomorrow.
          if (failed && msg.failedRef) store.update(from, msg.failedRef, { failed: true });
          emit('chat', answer);
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
        const message = {
          id: msg.id || crypto.randomUUID(),
          peerId: from,
          direction: 'in',
          kind: 'text',
          text: msg.text,
          ts: msg.ts || Date.now(),
          ...(notice && { notice: true }),
          ...(failed && { error: true, ...(msg.failedRef && { failedRef: msg.failedRef }) }),
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
      // A run of ours that finished with nothing in it, on a question this peer
      // asked. Resolved through remoteAgents rather than trusted: get() only
      // returns an agent this peer actually advertised to us, so nobody can make a
      // light play on somebody else's thread. An id that does not resolve is a
      // frame to drop, not one to guess at.
      case 'agent-empty': {
        // Shown wherever the answer would have gone — a session, if one asked.
        const into = remoteAgents && remoteAgents.emptyRun(from, msg.agentId);
        if (into) emit('agent-empty', { peerId: into });
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
        if (stored) emit('chat', stored);
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

  ipcMain.handle('lanchat:answerAgentApproval', (_e, { agentId, runId, choice }) =>
    agentHub.answerApproval(agentId, runId, choice)
  );

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

    const who = String(name || peerId).replace(/[^\w.\- ]+/g, '_').trim() || 'chat';
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
      const speaker = m.direction === 'out' ? me : m.askedBy ? `${name || peerId} (via peer)` : name || peerId;
      const body =
        m.kind === 'text' || !m.kind ? m.text : `[${m.kind}]${m.fileName ? ` ${m.fileName}` : ''}`;
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

  function publishSessions() {
    emit('sessions', sessions.list());
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

  ipcMain.handle('lanchat:setSessionAgent', (_e, { id, agentId }) => {
    const record = sessions.setAgent(id, agentId);
    if (record) publishSessions();
    return record;
  });

  // The record and the conversation go together — see sessions/index.js.
  ipcMain.handle('lanchat:deleteSession', (_e, { id }) => {
    const ok = sessions.remove(id);
    if (ok) publishSessions();
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

  // Taking named messages out of any thread.
  //
  // Separate from sweepSessionErrors above, which also corrects a session's
  // commit total. This one only removes: it is used for the summon lines and
  // greetings older builds left in *agent* threads, where there is no Commit box
  // and subtracting from one would be adjusting a number nothing displays.
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

    const message = {
      id: crypto.randomUUID(),
      peerId,
      direction: 'out',
      kind: 'text',
      text,
      ts: Date.now(),
      ...(docs.length && { docs: docs.map((d) => ({ name: d.name, bytes: d.bytes })) }),
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
        { name: 'Documents', extensions: ['txt', 'md', 'pdf', 'markdown', 'rst', 'json', 'csv', 'tsv', 'log', 'yml', 'yaml', 'xml', 'html'] },
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

  return { emit };
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
  SETTABLE_KEYS,
  PUBLIC_KEYS,
};
