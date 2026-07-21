'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit API surface exposed to the renderer. No Node globals leak.
const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('lanchat', {
  getState: () => invoke('lanchat:getState'),
  setProfile: (profile) => invoke('lanchat:setProfile', profile),
  getConfig: () => invoke('lanchat:getConfig'),
  setConfig: (patch) => invoke('lanchat:setConfig', patch),

  // Agents. Secrets travel one way only: they can be set here, but every
  // response redacts them to a `hasSecret` boolean.
  listAgents: () => invoke('lanchat:listAgents'),
  addAgent: (draft) => invoke('lanchat:addAgent', draft),
  removeAgent: (id) => invoke('lanchat:removeAgent', { id }),
  setAgentEnabled: (id, enabled) => invoke('lanchat:setAgentEnabled', { id, enabled }),
  setAgentPeers: (id, allowedPeers) => invoke('lanchat:setAgentPeers', { id, allowedPeers }),
  testAgent: (id) => invoke('lanchat:testAgent', { id }),
  answerAgentApproval: (agentId, runId, choice) =>
    invoke('lanchat:answerAgentApproval', { agentId, runId, choice }),
  stopAgentRun: (agentId) => invoke('lanchat:stopAgentRun', { agentId }),

  getPaths: () => invoke('lanchat:getPaths'),
  getHistory: (peerId) => invoke('lanchat:getHistory', peerId),
  sendChat: (peerId, text) => invoke('lanchat:sendChat', { peerId, text }),
  sendTyping: (peerId, isTyping) => invoke('lanchat:sendTyping', { peerId, isTyping }),
  sendSignal: (peerId, signal) => invoke('lanchat:sendSignal', { peerId, signal }),

  pickAndSendFile: (peerId) => invoke('lanchat:pickAndSendFile', { peerId }),
  sendFilePaths: (peerId, paths) => invoke('lanchat:sendFilePaths', { peerId, paths }),
  sendVoice: (peerId, data, ext) => invoke('lanchat:sendVoice', { peerId, data, ext }),

  setUnread: (count) => invoke('lanchat:setUnread', count),

  pickAvatar: () => invoke('lanchat:pickAvatar'),
  pickSound: (kind) => invoke('lanchat:pickSound', { kind }),
  linkStats: () => invoke('lanchat:linkStats'),

  setCallActive: (active) => invoke('lanchat:setCallActive', active),
  exitPip: () => invoke('lanchat:exitPip'),
  togglePip: () => invoke('lanchat:togglePip'),

  appVersion: () => invoke('lanchat:appVersion'),
  checkForUpdates: () => invoke('lanchat:checkForUpdates'),
  downloadUpdate: () => invoke('lanchat:downloadUpdate'),
  installUpdate: () => invoke('lanchat:installUpdate'),
  addManualPeer: (ip, port) => invoke('lanchat:addManualPeer', { ip, port }),
  refresh: () => invoke('lanchat:refresh'),
  revealFile: (filePath) => invoke('lanchat:revealFile', filePath),
  openFile: (filePath) => invoke('lanchat:openFile', filePath),

  // Subscribe to main-process events. Returns an unsubscribe function.
  onEvent: (handler) => {
    const listener = (_e, evt) => handler(evt);
    ipcRenderer.on('lanchat:event', listener);
    return () => ipcRenderer.removeListener('lanchat:event', listener);
  },
});
