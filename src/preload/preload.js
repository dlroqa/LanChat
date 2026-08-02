'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
  updateAgent: (id, patch) => invoke('lanchat:updateAgent', { id, patch }),
  removeAgent: (id) => invoke('lanchat:removeAgent', { id }),
  setAgentEnabled: (id, enabled) => invoke('lanchat:setAgentEnabled', { id, enabled }),
  setAgentPeers: (id, allowedPeers) => invoke('lanchat:setAgentPeers', { id, allowedPeers }),
  setAgentSharing: (id, patch) => invoke('lanchat:setAgentSharing', { id, ...patch }),
  testAgent: (id) => invoke('lanchat:testAgent', { id }),
  listAgentProfiles: (id, draft) => invoke('lanchat:listAgentProfiles', { id, draft }),
  answerAgentApproval: (agentId, runId, choice) =>
    invoke('lanchat:answerAgentApproval', { agentId, runId, choice }),
  stopAgentRun: (agentId) => invoke('lanchat:stopAgentRun', { agentId }),

  // Developer panel gate. Only a boolean verdict ever comes back — the hash
  // and password never leave the main process.
  verifyDevPassword: (password) => invoke('lanchat:verifyDevPassword', password),
  setDevPassword: (newPassword) => invoke('lanchat:setDevPassword', { newPassword }),
  lockDevGate: () => invoke('lanchat:lockDevGate'),

  getPaths: () => invoke('lanchat:getPaths'),
  getHistory: (peerId) => invoke('lanchat:getHistory', peerId),
  clearHistory: (peerId) => invoke('lanchat:clearHistory', { peerId }),
  exportHistory: (peerId, name) => invoke('lanchat:exportHistory', { peerId, name }),
  sendChat: (peerId, text, docPaths, context) => invoke('lanchat:sendChat', { peerId, text, docPaths, context }),

  // Sessions: local workspaces that ask an agent, or several at once. Their
  // messages travel the ordinary chat channels — these are only the list, who
  // each one asks, and the way a saved conversation gets loaded back in.
  listSessions: () => invoke('lanchat:listSessions'),
  createSession: (draft) => invoke('lanchat:createSession', draft || {}),
  renameSession: (id, title) => invoke('lanchat:renameSession', { id, title }),
  setSessionCounsel: (id, patch) => invoke('lanchat:setSessionCounsel', { id, ...(patch || {}) }),
  setSessionAgent: (id, agentId) => invoke('lanchat:setSessionAgent', { id, agentId }),
  askableAgents: () => invoke('lanchat:askableAgents'),
  sessionRound: (id) => invoke('lanchat:sessionRound', { id }),
  deleteSession: (id) => invoke('lanchat:deleteSession', { id }),
  importSessionText: (id) => invoke('lanchat:importSessionText', { id }),
  sweepSessionErrors: (id, ids) => invoke('lanchat:sweepSessionErrors', { id, ids }),
  purgeMessages: (id, ids) => invoke('lanchat:purgeMessages', { id, ids }),
  summonAgent: (threadId) => invoke('lanchat:summonAgent', { threadId }),
  sendTyping: (peerId, isTyping) => invoke('lanchat:sendTyping', { peerId, isTyping }),
  sendSignal: (peerId, signal) => invoke('lanchat:sendSignal', { peerId, signal }),

  pickAndSendFile: (peerId) => invoke('lanchat:pickAndSendFile', { peerId }),
  sendFilePaths: (peerId, paths) => invoke('lanchat:sendFilePaths', { peerId, paths }),
  sendVoice: (peerId, data, ext) => invoke('lanchat:sendVoice', { peerId, data, ext }),

  // Dictation. `dictate` takes WAV bytes and gives back text; the audio is
  // transcribed by the FluidVoice app on this machine and never leaves it.
  dictate: (data) => invoke('lanchat:dictate', { data }),
  probeDictation: (port) => invoke('lanchat:probeDictation', { port }),

  // Documents an agent is asked to read. Both return a verdict per file — name,
  // size and either `ok` or the reason — never the text, which is read in main
  // when the message is sent and never travels through the window.
  pickDocuments: () => invoke('lanchat:pickDocuments'),
  readDocuments: (paths) => invoke('lanchat:readDocuments', { paths }),

  // The path behind a dropped file. Electron 32 removed the `path` property
  // that used to be stapled onto File objects, and this is what replaced it;
  // without it every drop looks like a file with no location on disk.
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },

  setUnread: (count) => invoke('lanchat:setUnread', count),

  pickAvatar: () => invoke('lanchat:pickAvatar'),
  pickSound: (kind) => invoke('lanchat:pickSound', { kind }),
  linkStats: () => invoke('lanchat:linkStats'),

  setCallActive: (active) => invoke('lanchat:setCallActive', active),
  setOpenAtLogin: (open) => invoke('lanchat:setOpenAtLogin', open),
  exitPip: () => invoke('lanchat:exitPip'),
  togglePip: () => invoke('lanchat:togglePip'),

  appVersion: () => invoke('lanchat:appVersion'),
  checkForUpdates: () => invoke('lanchat:checkForUpdates'),
  downloadUpdate: () => invoke('lanchat:downloadUpdate'),
  installUpdate: () => invoke('lanchat:installUpdate'),
  addManualPeer: (ip, port) => invoke('lanchat:addManualPeer', { ip, port }),

  // Device identity and the peers we have pinned. Read-mostly: the only things
  // that change state here are deliberate acts by the person at the keyboard.
  security: () => invoke('lanchat:security'),
  listPins: () => invoke('lanchat:listPins'),
  markPeerVerified: (peerId, verified) => invoke('lanchat:markPeerVerified', { peerId, verified }),
  repinPeer: (peerId) => invoke('lanchat:repinPeer', { peerId }),
  forgetPeer: (peerId) => invoke('lanchat:forgetPeer', { peerId }),
  setAcceptLan: (on) => invoke('lanchat:setAcceptLan', { on }),
  refresh: () => invoke('lanchat:refresh'),
  revealFile: (filePath) => invoke('lanchat:revealFile', filePath),
  openFile: (filePath) => invoke('lanchat:openFile', filePath),

  // Links found in messages. Both are refused in main for anything that is not
  // an http(s) URL: one opens in the real browser rather than in this window, and
  // the other is fetched in main — the window never reaches a remote host itself.
  openExternal: (url) => invoke('lanchat:openExternal', url),
  linkPreview: (url) => invoke('lanchat:linkPreview', url),

  // A link that is a picture. `previewImage` comes back as a data URL, so the
  // window draws bytes main has already fetched and checked rather than pointing
  // an <img> at a stranger's host; `saveImage` puts it in the downloads folder
  // and hands back where it went, so the button can then reveal it.
  previewImage: (url) => invoke('lanchat:previewImage', url),
  saveImage: (url) => invoke('lanchat:saveImage', url),

  // Subscribe to main-process events. Returns an unsubscribe function.
  onEvent: (handler) => {
    const listener = (_e, evt) => handler(evt);
    ipcRenderer.on('lanchat:event', listener);
    return () => ipcRenderer.removeListener('lanchat:event', listener);
  },
});
