'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ipcMain, dialog, shell } = require('electron');
const { guessMime } = require('./fileTransfer');
const { LOCAL_ORIGIN: AGENT_LOCAL_ORIGIN } = require('./agents');
const { createRemoteAgents } = require('./agents/remote');
const { normalizeWebUrl } = require('./webLinks');
const { createLinkPreview } = require('./linkPreview');

// Bridges the main-process services to the renderer:
//   - ipcMain.handle(...)  : renderer -> main commands (request/response)
//   - bus events -> webContents 'lanchat:event' : main -> renderer notifications
// The renderer only ever sees the small, explicit surface exposed in preload.js.

function createIpc({ config, getIdentity, hub, bus, store, fileSender, discovery, updater, linkStats, pip, agentHub, outbox, downloadsDir, getWindow, revealWindow, applyLoginItem, onUnread }) {
  function emit(type, payload) {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('lanchat:event', { type, payload });
  }

  // Agents other peers have shared with us. Purely a receiver of adverts — it
  // never assumes a grant that was not sent.
  const remoteAgents = createRemoteAgents({ hub, store });

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
    for (const id of onlinePeers) if (!nowOnline.has(id)) remoteAgents.dropOwner(id);
    onlinePeers = nowOnline;
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
  bus.on('agent-status', (s) => emit('agent-status', s));
  bus.on('agent-delta', (d) => emit('agent-delta', d));
  bus.on('agent-approval', (a) => emit('agent-approval', a));
  bus.on('agent-typing', ({ agentId, isTyping }) => emit('typing', { peerId: agentId, isTyping }));

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
    // Agent ids are namespaced `agent:` and only ever originate locally. A frame
    // off the wire claiming one is a peer impersonating an agent — drop it. The
    // marker is a Symbol, so JSON.parse cannot forge it (see agents/index.js).
    if (agentHub && agentHub.isAgent(from) && !msg[AGENT_LOCAL_ORIGIN]) {
      console.warn('[ipc] dropped a wire frame claiming an agent id:', from);
      return;
    }
    // Link-quality control frames are consumed here, never shown as chat.
    if (linkStats && linkStats.handleMessage(msg)) return;
    switch (msg.type) {
      case 'chat': {
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
        const message = {
          id: msg.id || crypto.randomUUID(),
          peerId: from,
          direction: 'in',
          kind: 'text',
          text: msg.text,
          ts: msg.ts || Date.now(),
          ...(notice && { notice: true }),
        };
        if (!notice) store.append(from, message);
        emit('chat', message);
        break;
      }
      // A peer typing into a shared agent's own thread rather than using @name.
      // Every gate the @name path applies is re-applied inside routeDirect.
      case 'agent-chat': {
        if (agentHub) agentHub.routeDirect(from, msg.agentId, msg.text);
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
        if (entry) emit('typing', { peerId: entry.id, isTyping: msg.busy === true });
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
    const keys = [
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
      'agentMusicVolume',
      'pttEnabled',
      'pttKey',
      'pttCustomCode',
      'skippedUpdateVersion',
      'pttAllowIncoming',
      'openAtLogin',
    ];
    for (const k of keys) {
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

  ipcMain.handle('lanchat:sendChat', (_e, { peerId, text }) => {
    // Talking to an agent somebody else shared: the frame goes to its owner, and
    // our copy is filed under the agent's thread rather than under the chat with
    // them.
    const remote = remoteAgents.resolveThread(peerId);
    if (remote) return remoteAgents.send(remote.ownerPeerId, remote.entry, text);
    // `@Hermes …` typed in the chat with the agent's owner is the same
    // conversation reached a different way, so it goes to the same place. This
    // is what makes the agent's thread appear without it having to be shared for
    // direct chat.
    const mention = remoteAgents.matchMention(peerId, text);
    if (mention && mention.text) return remoteAgents.send(peerId, mention.entry, mention.text);

    const message = {
      id: crypto.randomUUID(),
      peerId,
      direction: 'out',
      kind: 'text',
      text,
      ts: Date.now(),
    };
    const ok = hub.send(peerId, { type: 'chat', id: message.id, text, ts: message.ts });
    // Undelivered messages are held and retried when the peer reconnects, so
    // the bubble is stored as pending rather than silently lost.
    if (!ok) {
      message.pending = true;
      outbox.enqueue(peerId, message);
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
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose a sound',
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const src = result.filePaths[0];
    const soundsDir = path.join(config.dir, 'sounds');
    fs.mkdirSync(soundsDir, { recursive: true });
    const dest = path.join(soundsDir, `${kind}${path.extname(src)}`);
    fs.copyFileSync(src, dest);
    bus.emit('allow-preview', dest);
    const key = kind === 'ringtone' ? 'customRingtonePath' : 'customNotificationPath';
    config.set({ [key]: dest });
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

  async function sendFiles(peerId, paths) {
    const sent = [];
    // Agents are text-only participants — there is no endpoint to upload to.
    // True of a remotely-shared agent as much as a local one.
    if ((agentHub && agentHub.isAgent(peerId)) || remoteAgents.isRemoteAgentId(peerId)) {
      emit('toast', { level: 'error', text: 'Agents cannot receive files.' });
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

function publicConfig(config) {
  const {
    iceServers,
    enableTailscale,
    enableLan,
    servicePort,
    discoveryPort,
    manualPeers,
    audioInputId,
    videoInputId,
    showAddresses,
    linkPreviews,
    ringtone,
    ringtoneVolume,
    customRingtonePath,
    notificationSound,
    notificationVolume,
    customNotificationPath,
    muteNotifications,
    agentMusicEnabled,
    agentMusicVolume,
    pttEnabled,
    pttKey,
    pttCustomCode,
    pttAllowIncoming,
    skippedUpdateVersion,
    openAtLogin,
  } = config.data;
  return {
    iceServers,
    enableTailscale,
    enableLan,
    servicePort,
    discoveryPort,
    manualPeers,
    audioInputId,
    videoInputId,
    showAddresses,
    linkPreviews,
    ringtone,
    ringtoneVolume,
    customRingtonePath,
    notificationSound,
    notificationVolume,
    customNotificationPath,
    muteNotifications,
    agentMusicEnabled,
    agentMusicVolume,
    pttEnabled,
    pttKey,
    pttCustomCode,
    pttAllowIncoming,
    skippedUpdateVersion,
    openAtLogin,
  };
}

module.exports = { createIpc, sanitizeAvatar, MAX_AVATAR_BYTES, isIncomingCallSignal };
