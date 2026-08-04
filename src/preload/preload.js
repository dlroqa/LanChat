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
  // Who may answer this agent's permission prompts besides you, and the passcode
  // that proves it. The passcode travels one way only, exactly like an agent's
  // key: it can be set here and never read back.
  setAgentApprovals: (id, patch) => invoke('lanchat:setAgentApprovals', { id, ...patch }),
  // The other end of it: asking a peer for the right to answer for their agent.
  claimAgentApprovals: (threadId, passcode) => invoke('lanchat:claimAgentApprovals', { threadId, passcode }),
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
  sendChat: (peerId, text, docPaths, context) =>
    invoke('lanchat:sendChat', { peerId, text, docPaths, context }),

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
  stopSessionRound: (id) => invoke('lanchat:stopSessionRound', { id }),
  deleteSession: (id) => invoke('lanchat:deleteSession', { id }),
  importSessionText: (id) => invoke('lanchat:importSessionText', { id }),

  // The Trash: where a deleted session waits. `deleteSession` above is what puts
  // one there; this is the list of what is in it, and the four ways back out —
  // two that put a session back where it was, two that finish the job.
  listTrash: () => invoke('lanchat:listTrash'),
  restoreSession: (id) => invoke('lanchat:restoreSession', { id }),
  purgeSession: (id) => invoke('lanchat:purgeSession', { id }),
  restoreAllSessions: () => invoke('lanchat:restoreAllSessions'),
  purgeAllSessions: () => invoke('lanchat:purgeAllSessions'),
  sweepSessionErrors: (id, ids) => invoke('lanchat:sweepSessionErrors', { id, ids }),

  // Notes: the Task Bar's own writing, belonging to this machine and to no
  // conversation. The bodies travel one at a time, on readNote — they are prose
  // with no bound on it, and a list channel that carried them would send every
  // word of every note across to draw a column of titles. Deleting sends a note
  // to a Trash of its own, with the same four ways back out sessions have.
  listNotes: () => invoke('lanchat:listNotes'),
  listNoteTrash: () => invoke('lanchat:listNoteTrash'),
  readNote: (id) => invoke('lanchat:readNote', { id }),
  createNote: (draft) => invoke('lanchat:createNote', draft || {}),
  saveNote: (id, patch) => invoke('lanchat:saveNote', { id, ...(patch || {}) }),
  deleteNote: (id) => invoke('lanchat:deleteNote', { id }),
  restoreNote: (id) => invoke('lanchat:restoreNote', { id }),
  purgeNote: (id) => invoke('lanchat:purgeNote', { id }),
  restoreAllNotes: () => invoke('lanchat:restoreAllNotes'),
  purgeAllNotes: () => invoke('lanchat:purgeAllNotes'),

  // Agent tasks: a standing instruction and the agent it is put to. The answers
  // are fetched for one task at a time, on taskRuns — a list channel carrying
  // every answer of every task would be the note-body mistake again. Running
  // one comes back either `{ ok: true, task }` or a refusal with the sentence
  // to show for it.
  listTasks: () => invoke('lanchat:listTasks'),
  taskRuns: (id, limit) => invoke('lanchat:taskRuns', { id, limit }),
  createTask: (draft) => invoke('lanchat:createTask', draft || {}),
  updateTask: (id, patch) => invoke('lanchat:updateTask', { id, patch: patch || {} }),
  deleteTask: (id) => invoke('lanchat:deleteTask', { id }),
  runTask: (id) => invoke('lanchat:runTask', { id }),
  stopTask: (id) => invoke('lanchat:stopTask', { id }),

  // Scheduled tasks: a task, and when it should run on its own. `previewSchedule`
  // is the validation — it runs the same walker the scheduler does and hands
  // back the next few real moments, so what the panel shows is what will happen.
  listSchedules: () => invoke('lanchat:listSchedules'),
  previewSchedule: (spec, count) => invoke('lanchat:previewSchedule', { spec, count }),
  createSchedule: (taskId, spec) => invoke('lanchat:createSchedule', { taskId, spec }),
  updateSchedule: (id, patch) => invoke('lanchat:updateSchedule', { id, patch: patch || {} }),
  setScheduleEnabled: (id, enabled) => invoke('lanchat:setScheduleEnabled', { id, enabled }),
  deleteSchedule: (id) => invoke('lanchat:deleteSchedule', { id }),
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
