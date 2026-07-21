'use strict';

const path = require('node:path');
const { Tray, Menu, nativeImage, app } = require('electron');

// Status-menu item: macOS menu bar (top right), Windows notification area
// (bottom right), Linux/GNOME status area (top right, via AppIndicator).
//
// The menu is rebuilt whenever presence changes so it always reflects who is
// online, and each online peer is a shortcut straight into that conversation.

const MAX_PEERS_IN_MENU = 8;

function iconPath(name) {
  return path.join(__dirname, 'assets', name);
}

function loadTrayImage() {
  // macOS uses a template image so the system tints it for light/dark menu bars.
  if (process.platform === 'darwin') {
    const img = nativeImage.createFromPath(iconPath('trayTemplate.png'));
    img.setTemplateImage(true);
    return img;
  }
  const img = nativeImage.createFromPath(iconPath('tray.png'));
  // Linux indicators render better from a slightly larger source.
  return process.platform === 'linux'
    ? nativeImage.createFromPath(iconPath('tray@2x.png'))
    : img;
}

function createTray({ getWindow, showWindow, onSelectPeer, getPresence, onQuit }) {
  let tray = null;
  let unread = 0;

  try {
    const image = loadTrayImage();
    if (image.isEmpty()) throw new Error('tray image failed to load');
    tray = new Tray(image);
  } catch (err) {
    // Headless Linux and some minimal desktops have no status area at all.
    console.warn('[tray] unavailable:', err.message);
    return { update: () => {}, setUnread: () => {}, destroy: () => {}, isActive: false };
  }

  function buildMenu() {
    const peers = (getPresence() || []).filter((p) => p.online);
    const template = [
      { label: statusLine(peers.length), enabled: false },
      { type: 'separator' },
      { label: 'Open LanChat', click: showWindow },
    ];

    if (peers.length) {
      template.push({ type: 'separator' });
      template.push({ label: 'Online now', enabled: false });
      for (const p of peers.slice(0, MAX_PEERS_IN_MENU)) {
        template.push({
          label: `   ${p.name || p.hostname || 'Unknown'}`,
          click: () => {
            showWindow();
            onSelectPeer(p.id);
          },
        });
      }
      if (peers.length > MAX_PEERS_IN_MENU) {
        template.push({ label: `   +${peers.length - MAX_PEERS_IN_MENU} more…`, enabled: false });
      }
    }

    template.push({ type: 'separator' });
    template.push({ label: 'Quit LanChat', click: onQuit });
    return Menu.buildFromTemplate(template);
  }

  function statusLine(count) {
    const who = count === 0 ? 'No one online' : count === 1 ? '1 person online' : `${count} people online`;
    return unread > 0 ? `${who} · ${unread} unread` : who;
  }

  function update() {
    if (!tray) return;
    const peers = (getPresence() || []).filter((p) => p.online);
    tray.setToolTip(`LanChat — ${statusLine(peers.length)}`);
    tray.setContextMenu(buildMenu());
  }

  function setUnread(count) {
    unread = Number(count) || 0;
    if (!tray) return;
    // macOS can show a count beside the menu bar icon.
    if (process.platform === 'darwin') tray.setTitle(unread > 0 ? ` ${unread}` : '');
    if (app.setBadgeCount) {
      try {
        app.setBadgeCount(unread);
      } catch {
        // unsupported on some Linux desktops
      }
    }
    update();
  }

  // On Windows and Linux a click should open the app; macOS shows the menu.
  tray.on('click', () => {
    if (process.platform === 'darwin') return;
    const win = getWindow();
    if (win && win.isVisible() && !win.isMinimized()) win.hide();
    else showWindow();
  });
  tray.on('double-click', showWindow);

  update();

  return {
    update,
    setUnread,
    destroy: () => {
      if (tray) tray.destroy();
      tray = null;
    },
    isActive: true,
  };
}

module.exports = { createTray };
