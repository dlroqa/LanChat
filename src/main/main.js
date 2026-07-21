'use strict';

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { app, BrowserWindow, session } = require('electron');

const { Config } = require('./config');
const { buildIdentity } = require('./identity');
const { PeerHub } = require('./peers');
const { createServer } = require('./server');
const { createDiscovery } = require('./discovery');
const { createFileSender } = require('./fileTransfer');
const { MessageStore } = require('./store');
const { createIpc } = require('./ipc');
const { createTray } = require('./tray');

const isDev = process.env.LANCHAT_DEV === '1';

// Allow running multiple instances on one machine for testing:
//   LANCHAT_USERDATA=/tmp/a LANCHAT_PORT=47100 electron .
if (process.env.LANCHAT_USERDATA) {
  app.setPath('userData', process.env.LANCHAT_USERDATA);
}
app.setName('LanChat');

let mainWindow = null;
let tray = null;
let services = null;

function getWindow() {
  return mainWindow;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: '#0f1115',
    title: 'LanChat',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5273');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'renderer', 'index.html'));
  }

  // Closing the window keeps LanChat running in the status menu, so you stay
  // reachable for messages and calls. Quit explicitly from the tray menu.
  mainWindow.on('close', (e) => {
    if (!app.isQuitting && tray && tray.isActive) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function setupMediaPermissions() {
  // WebRTC calls need camera/mic; grant to our own renderer only.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'audioCapture', 'videoCapture', 'display-capture', 'notifications'];
    callback(allowed.includes(permission));
  });
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function setupTray(ipcApi) {
  tray = createTray({
    getWindow,
    showWindow,
    getPresence: () => (services ? services.hub.presenceList() : []),
    onSelectPeer: (peerId) => ipcApi.emit('select-peer', peerId),
    onQuit: () => {
      app.isQuitting = true;
      app.quit();
    },
  });

  // Keep the status menu in step with who is online.
  if (services) services.bus.on('presence', () => tray.update());
}

async function startServices() {
  const config = new Config(app.getPath('userData'));
  if (process.env.LANCHAT_PORT) config.set({ servicePort: Number(process.env.LANCHAT_PORT) });
  if (process.env.LANCHAT_DISCOVERY_PORT)
    config.set({ discoveryPort: Number(process.env.LANCHAT_DISCOVERY_PORT) });

  const bus = new EventEmitter();
  bus.setMaxListeners(50);

  const getIdentity = () => buildIdentity(config);

  const downloadsDir = path.join(app.getPath('downloads'), 'LanChat');
  const store = new MessageStore(app.getPath('userData'));
  const hub = new PeerHub({ getIdentity, bus });
  const server = createServer({ config, getIdentity, hub, bus, downloadsDir });
  const discovery = createDiscovery({ config, getIdentity, hub, bus });
  const fileSender = createFileSender({ hub, getIdentity, bus });

  const ipcApi = createIpc({
    config,
    getIdentity,
    hub,
    bus,
    store,
    fileSender,
    discovery,
    getWindow,
    // `tray` is resolved lazily: the tray is created after services start.
    onUnread: (count) => tray && tray.setUnread(count),
  });

  await server.start();
  discovery.start();

  services = { config, bus, hub, server, discovery, store, downloadsDir };
  return ipcApi;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock && !process.env.LANCHAT_USERDATA) {
  // A second launch focuses the existing window (unless it's an explicit test instance).
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    setupMediaPermissions();
    const ipcApi = await startServices();
    createWindow();
    setupTray(ipcApi);

    app.on('activate', showWindow);
  });

  app.on('window-all-closed', () => {
    // With a status-menu item present, LanChat keeps running in the background
    // so messages and calls still reach you. Quit from the tray menu.
    if (tray && tray.isActive) return;
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    if (tray) tray.destroy();
    if (services) {
      services.discovery.stop();
      services.server.stop();
    }
  });
}
