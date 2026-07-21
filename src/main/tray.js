'use strict';

const path = require('node:path');
const { Tray, Menu, nativeImage, app } = require('electron');

// Status-menu item: macOS menu bar (top right), Windows notification area
// (bottom right), Linux/GNOME status area (top right, via AppIndicator).
//
// The menu is rebuilt whenever presence changes so it always reflects who is
// online, and each online peer is a shortcut straight into that conversation.

const MAX_PEERS_IN_MENU = 8;

let ICONS = {};

function iconPath(name) {
  return path.join(__dirname, 'assets', name);
}

function loadTrayImage(unread = false) {
  if (unread) {
    // Coloured (non-template) so the green dot survives macOS menu-bar tinting.
    return nativeImage.createFromPath(iconPath(process.platform === 'linux' ? 'trayUnread@2x.png' : 'trayUnread.png'));
  }
  return loadBaseImage();
}

function loadBaseImage() {
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

// Small menu glyphs. Action icons are template images so macOS tints them for
// light/dark menus; the presence dots stay coloured deliberately.
function menuIcon(name, template = true) {
  try {
    const img = nativeImage.createFromPath(iconPath(name));
    if (img.isEmpty()) return undefined;
    if (template) img.setTemplateImage(true);
    return img;
  } catch {
    return undefined;
  }
}

function createTray({ getWindow, showWindow, onSelectPeer, onStartCall, getPresence, onQuit }) {
  let tray = null;
  let unread = 0;
  let blinkTimer = null;

  ICONS = {
    online: menuIcon('dotOnline.png', false),
    offline: menuIcon('dotOffline.png', false),
    message: menuIcon('menuMessageTemplate.png'),
    call: menuIcon('menuCallTemplate.png'),
    video: menuIcon('menuVideoTemplate.png'),
  };

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
        const name = p.name || p.hostname || 'Unknown';
        // A green dot marks availability; the submenu carries one-click actions.
        // Native menus cannot put several clickable icons on a single row, so
        // the actions live one level down rather than inline.
        template.push({
          label: name,
          icon: ICONS.online,
          submenu: [
            { label: `Message ${name}`, icon: ICONS.message, click: () => openWith(p.id) },
            {
              label: `Voice call ${name}`,
              icon: ICONS.call,
              click: () => openWith(p.id, { call: 'voice' }),
            },
            {
              label: `Video call ${name}`,
              icon: ICONS.video,
              click: () => openWith(p.id, { call: 'video' }),
            },
          ],
        });
      }
      if (peers.length > MAX_PEERS_IN_MENU) {
        template.push({ label: `+${peers.length - MAX_PEERS_IN_MENU} more…`, enabled: false });
      }
    }

    // Offline peers are listed greyed out with a grey dot, so the menu shows the
    // whole roster rather than hiding people who happen to be away.
    const offline = (getPresence() || []).filter((p) => !p.online).slice(0, MAX_PEERS_IN_MENU);
    if (offline.length) {
      template.push({ type: 'separator' });
      template.push({ label: 'Offline', enabled: false });
      for (const p of offline) {
        template.push({
          label: p.name || p.hostname || 'Unknown',
          icon: ICONS.offline,
          click: () => openWith(p.id),
        });
      }
    }

    template.push({ type: 'separator' });
    template.push({ label: 'Quit LanChat', click: onQuit });
    return Menu.buildFromTemplate(template);
  }

  // Focus the window, select the peer, and optionally start a call immediately.
  function openWith(peerId, opts = {}) {
    showWindow();
    onSelectPeer(peerId);
    if (opts.call && onStartCall) {
      // Give the renderer a beat to select the conversation first.
      setTimeout(() => onStartCall(peerId, opts.call === 'video'), 180);
    }
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

  // Blinks between the plain and dotted icon so a new message is noticeable
  // without being permanently distracting.
  function startBlink() {
    if (blinkTimer) return;
    let on = false;
    blinkTimer = setInterval(() => {
      if (!tray) return;
      on = !on;
      try {
        tray.setImage(loadTrayImage(on));
      } catch {}
    }, 700);
  }

  function stopBlink() {
    if (blinkTimer) clearInterval(blinkTimer);
    blinkTimer = null;
    if (tray) {
      try {
        tray.setImage(loadTrayImage(false));
      } catch {}
    }
  }

  function setUnread(count) {
    unread = Number(count) || 0;
    if (!tray) return;
    if (unread > 0) startBlink();
    else stopBlink();
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
      stopBlink();
      if (tray) tray.destroy();
      tray = null;
    },
    isActive: true,
  };
}

module.exports = { createTray };
