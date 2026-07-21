'use strict';

const crypto = require('node:crypto');
const { ipcMain, dialog, shell } = require('electron');

// Bridges the main-process services to the renderer:
//   - ipcMain.handle(...)  : renderer -> main commands (request/response)
//   - bus events -> webContents 'lanchat:event' : main -> renderer notifications
// The renderer only ever sees the small, explicit surface exposed in preload.js.

function createIpc({ config, getIdentity, hub, bus, store, fileSender, discovery, getWindow }) {
  function emit(type, payload) {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('lanchat:event', { type, payload });
  }

  // ---- main -> renderer event forwarding ----
  bus.on('presence', (list) => emit('presence', list));
  bus.on('tailnet-peers', (list) => emit('tailnet-peers', list));
  bus.on('file-progress', (p) => emit('file-progress', p));

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
    switch (msg.type) {
      case 'chat': {
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
    config.set({ displayName: (displayName || '').trim() || getIdentity().hostname, avatar: avatar || null });
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
    ];
    for (const k of keys) {
      if (k in patch) allowed[k] = patch[k];
    }
    config.set(allowed);
    return publicConfig(config);
  });

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

  ipcMain.handle('lanchat:addManualPeer', (_e, { ip, port }) => {
    const entry = `${ip}:${port || config.get('servicePort')}`;
    const list = new Set(config.get('manualPeers') || []);
    list.add(entry);
    config.set({ manualPeers: [...list] });
    discovery.refresh();
    return [...list];
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
  };
}

module.exports = { createIpc };
