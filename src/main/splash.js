'use strict';

const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

// The launch splash: a small frameless window that opens before services start
// and closes once the real window is ready to take over.
//
// It is deliberately *not* transparent. A transparent frameless window needs a
// compositing window manager, and LanChat ships an AppImage and a .deb to
// desktops that may not have one — where the result is a black box around the
// artwork rather than no box at all. An opaque panel on --bg looks the same on
// every platform, and `roundedCorners` (on by default) still softens it on
// macOS and Windows 11.

let splashWindow = null;

// The reveal is gated on two independent things: the splash saying it is done,
// and the main window saying it can be shown. Neither can be relied on to
// finish first — a fast machine has the window ready seconds before the
// sequence ends, and a slow one does not — and either ordering alone would show
// something wrong: an empty window if the splash goes first, or a splash still
// sitting over a live app if the window does.
//
// Pure, and exported, so the ordering can be tested without an Electron run.
function createGate(keys, onReady) {
  const pending = new Set(keys);
  let fired = false;
  return function arrive(key) {
    pending.delete(key);
    // A repeated signal must not fire the reveal twice — the splash can send
    // `done` from its timer and from a click in the same moment.
    if (fired || pending.size > 0) return false;
    fired = true;
    onReady();
    return true;
  };
}

function createSplash({ isDev, onDone, confineNavigation }) {
  splashWindow = new BrowserWindow({
    width: 460,
    height: 320,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    center: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Shown on ready-to-show instead, so the first thing on screen is the
    // artwork rather than an empty panel.
    show: false,
    backgroundColor: '#0f1115',
    title: 'LanChat',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'splashPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  splashWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.show();
  });

  splashWindow.on('closed', () => {
    splashWindow = null;
  });

  // Same backstop the main window gets: this window never navigates anywhere.
  if (confineNavigation) confineNavigation(splashWindow.webContents);

  // The version travels in the URL rather than over IPC. It is known before the
  // window exists, and the page's CSP allows reading its own query string but
  // nothing else — no round trip to arrange, nothing to wait for.
  const search = `v=${app.getVersion()}`;
  if (isDev) {
    splashWindow.loadURL(`http://localhost:5273/splash.html?${search}`);
  } else {
    splashWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'renderer', 'splash.html'), { search });
  }

  ipcMain.on('splash:done', onDone);

  return splashWindow;
}

function closeSplash() {
  ipcMain.removeAllListeners('splash:done');
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
  splashWindow = null;
}

function splashIsOpen() {
  return Boolean(splashWindow && !splashWindow.isDestroyed());
}

module.exports = { createSplash, closeSplash, splashIsOpen, createGate };
