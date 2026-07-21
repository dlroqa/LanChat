'use strict';

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { app, BrowserWindow, session, Tray, Menu, nativeImage } = require('electron');

const { Config } = require('./config');
const { buildIdentity } = require('./identity');
const { PeerHub } = require('./peers');
const { createServer } = require('./server');
const { createDiscovery } = require('./discovery');
const { createFileSender } = require('./fileTransfer');
const { MessageStore } = require('./store');
const { createIpc } = require('./ipc');

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

function setupTray() {
  try {
    const img = nativeImage.createEmpty();
    tray = new Tray(img);
    tray.setToolTip('LanChat');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open LanChat', click: () => (mainWindow ? mainWindow.show() : createWindow()) },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ])
    );
  } catch {
    // Tray is best-effort (e.g. headless Linux has no tray).
  }
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

  createIpc({ config, getIdentity, hub, bus, store, fileSender, discovery, getWindow });

  await server.start();
  discovery.start();

  services = { config, bus, hub, server, discovery, store, downloadsDir };
  return services;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock && !process.env.LANCHAT_USERDATA) {
  // A second launch focuses the existing window (unless it's an explicit test instance).
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    setupMediaPermissions();
    await startServices();
    createWindow();
    setupTray();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    if (services) {
      services.discovery.stop();
      services.server.stop();
    }
  });
}
