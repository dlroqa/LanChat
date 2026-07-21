'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ipcMain, dialog, shell } = require('electron');
const { guessMime } = require('./fileTransfer');
const { LOCAL_ORIGIN: AGENT_LOCAL_ORIGIN } = require('./agents');

// Bridges the main-process services to the renderer:
//   - ipcMain.handle(...)  : renderer -> main commands (request/response)
//   - bus events -> webContents 'lanchat:event' : main -> renderer notifications
// The renderer only ever sees the small, explicit surface exposed in preload.js.

function createIpc({ config, getIdentity, hub, bus, store, fileSender, discovery, updater, linkStats, agentHub, downloadsDir, getWindow, onUnread }) {
  function emit(type, payload) {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('lanchat:event', { type, payload });
  }

  // ---- main -> renderer event forwarding ----
  bus.on('presence', (list) => emit('presence', list));
  bus.on('tailnet-peers', (list) => emit('tailnet-peers', list));
  bus.on('tailnet-status', (s) => emit('tailnet-status', s));
  bus.on('file-progress', (p) => emit('file-progress', p));
  bus.on('update-progress', (p) => emit('update-progress', p));
  bus.on('link-stats', (s) => emit('link-stats', s));
  bus.on('update-log', (m) => emit('toast', { level: 'info', text: m }));
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
        // that agent's allowlist and enabled state. It is deliberately still
        // stored and shown afterwards: you should always be able to see what a
        // peer asked your agent to do.
        if (agentHub) agentHub.routeFromPeer(from, msg.text);
        const message = {
          id: msg.id || crypto.randomUUID(),
          peerId: from,
          direction: 'in',
          kind: 'text',
          text: msg.text,
          ts: msg.ts || Date.now(),
        };
        store.append(from, message);
        emit('chat', message);
        break;
      }
      case 'typing':
        emit('typing', { peerId: from, isTyping: Boolean(msg.isTyping) });
        break;
      case 'signal':
        emit('signal', { peerId: from, signal: msg.signal });
        break;
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
      'ringtone',
      'ringtoneVolume',
      'customRingtonePath',
      'notificationSound',
      'notificationVolume',
      'customNotificationPath',
      'muteNotifications',
      'pttEnabled',
      'pttKey',
      'pttCustomCode',
      'pttAllowIncoming',
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

  ipcMain.handle('lanchat:addAgent', async (_e, draft) => {
    try {
      return { ok: true, agent: await agentHub.add(draft) };
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

  ipcMain.handle('lanchat:testAgent', (_e, { id }) => agentHub.test(id));

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

  ipcMain.handle('lanchat:sendChat', (_e, { peerId, text }) => {
    const message = {
      id: crypto.randomUUID(),
      peerId,
      direction: 'out',
      kind: 'text',
      text,
      ts: Date.now(),
    };
    store.append(peerId, message);
    const ok = hub.send(peerId, { type: 'chat', id: message.id, text, ts: message.ts });
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

  ipcMain.handle('lanchat:linkStats', () => (linkStats ? linkStats.all() : []));

  // ---- updates ----
  ipcMain.handle('lanchat:checkForUpdates', () => updater.check());
  ipcMain.handle('lanchat:downloadUpdate', () => updater.download());
  ipcMain.handle('lanchat:installUpdate', () => updater.install());
  ipcMain.handle('lanchat:appVersion', () => require('electron').app.getVersion());

  // Renderer owns unread state; mirror it onto the status-menu item / badge.
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

  async function sendFiles(peerId, paths) {
    const sent = [];
    // Agents are text-only participants — there is no endpoint to upload to.
    if (agentHub && agentHub.isAgent(peerId)) {
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
    ringtone,
    ringtoneVolume,
    customRingtonePath,
    notificationSound,
    notificationVolume,
    customNotificationPath,
    muteNotifications,
    pttEnabled,
    pttKey,
    pttCustomCode,
    pttAllowIncoming,
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
    ringtone,
    ringtoneVolume,
    customRingtonePath,
    notificationSound,
    notificationVolume,
    customNotificationPath,
    muteNotifications,
    pttEnabled,
    pttKey,
    pttCustomCode,
    pttAllowIncoming,
  };
}

module.exports = { createIpc, sanitizeAvatar, MAX_AVATAR_BYTES };
