'use strict';

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { app, BrowserWindow, session, safeStorage, shell } = require('electron');

const { Config } = require('./config');
const { buildIdentity } = require('./identity');
const { PeerHub } = require('./peers');
const { createServer } = require('./server');
const { createDiscovery } = require('./discovery');
const { createFileSender } = require('./fileTransfer');
const { MessageStore } = require('./store');
const { createIpc } = require('./ipc');
const { createTray } = require('./tray');
const { createUpdater } = require('./updater');
const { createLinkStats } = require('./linkStats');
const { createPip } = require('./pip');
const { createAgentHub } = require('./agents');
const { DevGate } = require('./devgate');
const { Outbox } = require('./outbox');
const { normalizeWebUrl } = require('./webLinks');
const { createSplash, closeSplash, splashIsOpen, createGate } = require('./splash');

// Node shows ten frames by default, which is not enough to see a cycle. The
// 0.4.21 crash dialog was truncated exactly where the loop closed, so the part
// that named the bug was the part that got cut off. Crashes here are read from a
// screenshot of a dialog on someone else's machine, and there is no second
// attempt at capturing one — the whole trace has to be in the first report.
Error.stackTraceLimit = 50;

// Long enough that the update check never competes with first-run setup.
const STARTUP_UPDATE_CHECK_DELAY = 4000;
// Re-check periodically so a session left open for hours still learns about a
// release that shipped after launch.
const PERIODIC_UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000;

// Comfortably past the splash's own ten seconds: this is only ever reached when
// the window has failed to become ready at all, and it must not cut short a
// boot that is merely slow.
const SPLASH_REVEAL_TIMEOUT = 20000;

const isDev = process.env.LANCHAT_DEV === '1';

// Allow running multiple instances on one machine for testing:
//   LANCHAT_USERDATA=/tmp/a LANCHAT_PORT=47100 electron .
if (process.env.LANCHAT_USERDATA) {
  app.setPath('userData', process.env.LANCHAT_USERDATA);
}
app.setName('LanChat');

let mainWindow = null;
let tray = null;
let pip = null;
let services = null;

function getWindow() {
  return mainWindow;
}

function createWindow({ hidden = false, onReadyToShow = null } = {}) {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: '#0f1115',
    title: 'LanChat',
    // Launched at login: create the window but keep it hidden, so the renderer
    // is alive (able to ring and answer calls) while LanChat sits in the tray.
    // It is also created hidden behind the launch splash, which shows it once
    // both it and this window are ready (see the reveal gate in splash.js).
    show: !hidden,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (onReadyToShow) mainWindow.once('ready-to-show', onReadyToShow);

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

  if (pip) pip.attach(mainWindow);

  confineNavigation(mainWindow.webContents);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Messages carry links now, and this window is the last place one should ever
// open: it has our preload attached. So the window itself never navigates and
// never opens a child window — a web link is handed to the real browser, and
// anything that is not a web link is dropped. The renderer already routes clicks
// through IPC; this is the backstop for the paths it does not control (middle
// click, target=_blank, a dropped URL).
function confineNavigation(webContents) {
  const isOwnPage = (url) => url.startsWith('file://') || url.startsWith('http://localhost:5273');

  webContents.setWindowOpenHandler(({ url }) => {
    const web = normalizeWebUrl(url);
    if (web) shell.openExternal(web);
    return { action: 'deny' };
  });

  webContents.on('will-navigate', (e, url) => {
    if (isOwnPage(url)) return;
    e.preventDefault();
    const web = normalizeWebUrl(url);
    if (web) shell.openExternal(web);
  });
}

function setupMediaPermissions() {
  // WebRTC calls need camera/mic; grant to our own renderer only.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'audioCapture', 'videoCapture', 'display-capture', 'notifications'];
    callback(allowed.includes(permission));
  });
}

// Windows/macOS: register (or clear) the OS login item. Linux desktops vary too
// much for a single reliable mechanism, so it's a no-op there and the Settings
// toggle is hidden.
function applyLoginItem(open) {
  if (process.platform === 'linux') return false;
  try {
    app.setLoginItemSettings({
      openAtLogin: open,
      openAsHidden: true, // macOS
      args: ['--hidden'], // Windows/macOS: start in the tray
    });
    return true;
  } catch (err) {
    console.warn('[login-item] failed:', err.message);
    return false;
  }
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  // A tray click or a second launch is someone asking for the window *now*, so
  // the splash has been overtaken and should get out of the way rather than
  // stay in front of the app it was introducing.
  //
  // Closed last, and only once there is another window: during boot the splash
  // may be the only one open, and destroying it first would leave Electron with
  // none at all — which on Windows and Linux means `window-all-closed`, and a
  // quit before the app has finished starting.
  if (splashIsOpen()) closeSplash();
}

function setupTray(ipcApi) {
  tray = createTray({
    getWindow,
    showWindow,
    getPresence: () => (services ? services.hub.presenceList() : []),
    onSelectPeer: (peerId) => ipcApi.emit('select-peer', peerId),
    onStartCall: (peerId, withVideo) => ipcApi.emit('start-call', { peerId, withVideo }),
    onQuit: () => {
      app.isQuitting = true;
      app.quit();
    },
  });

  // Keep the status menu in step with who is online.
  if (services) services.bus.on('presence', () => tray.update());
}

async function startServices() {
  const config = new Config(app.getPath('userData'), app.getVersion());
  if (process.env.LANCHAT_PORT) config.set({ servicePort: Number(process.env.LANCHAT_PORT) });
  if (process.env.LANCHAT_DISCOVERY_PORT)
    config.set({ discoveryPort: Number(process.env.LANCHAT_DISCOVERY_PORT) });

  const bus = new EventEmitter();
  bus.setMaxListeners(50);

  const getIdentity = () => buildIdentity(config);

  const downloadsDir = path.join(app.getPath('downloads'), 'LanChat');
  const store = new MessageStore(app.getPath('userData'));
  // Histories written before turn notices became transient still hold them, so
  // they are cleared out here rather than left to clutter the thread forever.
  store.pruneLegacyNotices();
  const hub = new PeerHub({ getIdentity, bus });
  // `store` is passed so previews of files already in a conversation survive a
  // restart — see the allowlist in server.js.
  const server = createServer({ config, getIdentity, hub, bus, downloadsDir, store });
  const discovery = createDiscovery({ config, getIdentity, hub, bus });
  const fileSender = createFileSender({ hub, getIdentity, bus });

  const outbox = new Outbox(app.getPath('userData'), { hub, bus, store });
  const devGate = new DevGate(app.getPath('userData'));
  const updater = createUpdater({ bus });
  const linkStats = createLinkStats({ hub, bus });
  pip = createPip({ getWindow, onChange: (on) => bus.emit('pip', on) });
  const agentHub = createAgentHub({
    userDataDir: app.getPath('userData'),
    hub,
    bus,
    store,
    safeStorage,
  });

  const ipcApi = createIpc({
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
    downloadsDir,
    getWindow,
    revealWindow: showWindow,
    applyLoginItem,
    // `tray` is resolved lazily: the tray is created after services start.
    onUnread: (count) => tray && tray.setUnread(count),
  });

  await server.start();
  discovery.start();
  linkStats.start();
  // Drains queued messages whenever a peer becomes reachable again.
  outbox.start();
  // Agents are restored last: enabled ones reconnect, disabled ones appear in
  // the roster as offline. A failure here must not stop the app from starting.
  agentHub.startAll().catch((err) => console.error('[agents] startup failed:', err.message));

  // Check GitHub for a newer release on every launch. Deferred a few seconds so
  // it never competes with first-run setup or the initial peer scan, and fully
  // best-effort: no network, no release, or a rate limit must never surface as
  // an error on startup.
  const runUpdateCheck = () =>
    updater
      .check()
      .then((res) => {
        if (res && res.status === 'available') bus.emit('update-available', res);
      })
      .catch((err) => console.warn('[updater] check skipped:', err.message));

  setTimeout(runUpdateCheck, STARTUP_UPDATE_CHECK_DELAY);
  // Keep watching while the app stays open; the renderer decides whether the
  // notice actually surfaces (skipped/"Later" versions are suppressed there).
  setInterval(runUpdateCheck, PERIODIC_UPDATE_CHECK_INTERVAL);

  services = { config, bus, hub, server, discovery, store, downloadsDir, linkStats, agentHub, outbox };
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

    // Started at login (we pass --hidden in the login-item args, and macOS also
    // reports wasOpenedAtLogin): boot straight to the tray.
    //
    // Read before services start rather than after: it only looks at how we
    // were launched, and the splash below has to be on screen *during* the boot
    // to be worth anything.
    const launchedHidden =
      process.argv.includes('--hidden') ||
      (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);

    // Launched to the tray there is no window to introduce, and a splash
    // appearing on the desktop at every login would be an intrusion — so this
    // is the one launch that stays silent.
    let arrive = null;
    if (!launchedHidden) {
      arrive = createGate(['splash', 'window'], () => {
        // The window is shown first and the splash torn down after, so the last
        // thing that happens is the splash lifting off an app that is already
        // there — never a moment of bare desktop in between.
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
        closeSplash();
      });
      createSplash({ isDev, onDone: () => arrive('splash'), confineNavigation });
      // Insurance. If the window never reports itself ready — a renderer that
      // fails to load, a dev server that went away — the gate would otherwise
      // hold the splash in front of an app nobody can reach, and skipping does
      // not help because skipping only answers for the splash's half.
      setTimeout(() => arrive && arrive('window'), SPLASH_REVEAL_TIMEOUT);
    }

    const ipcApi = await startServices();
    createWindow({
      hidden: launchedHidden || Boolean(arrive),
      onReadyToShow: arrive ? () => arrive('window') : null,
    });
    setupTray(ipcApi);
    applyLoginItem(Boolean(services.config.get('openAtLogin')));

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
    // Quitting mid-launch: the splash would otherwise outlive the app that was
    // starting behind it.
    closeSplash();
    if (tray) tray.destroy();
    if (services) {
      services.discovery.stop();
      services.linkStats.stop();
      services.server.stop();
      // Tears down in-flight runs and kills any agent child processes.
      services.agentHub.stopAll();
      services.outbox.stop();
    }
  });
}
