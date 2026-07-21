'use strict';

const { screen } = require('electron');

// Picture-in-picture for video calls, Zoom style: minimising during a video call
// shrinks LanChat to a small always-on-top video tile in the top-right corner
// instead of disappearing to the dock/taskbar.
//
// This reshapes the EXISTING window rather than opening a second one on purpose:
// a MediaStream cannot be handed to another renderer process, so a separate PiP
// window would have to duplicate the WebRTC connection. Reusing this window
// keeps the live stream exactly as it is.

const PIP_WIDTH = 320;
const PIP_HEIGHT = 180; // 16:9
const MARGIN = 16;

function createPip({ getWindow, onChange }) {
  let active = false;
  let callActive = false; // a video call is in progress
  let saved = null; // bounds + constraints to restore

  function isActive() {
    return active;
  }

  function setCallActive(v) {
    callActive = Boolean(v);
    // If the call ends while docked, come back to the normal window.
    if (!callActive && active) exit();
  }

  function enter() {
    const win = getWindow();
    if (!win || win.isDestroyed() || active) return;

    saved = {
      bounds: win.getBounds(),
      minimum: win.getMinimumSize(),
      resizable: win.isResizable(),
      alwaysOnTop: win.isAlwaysOnTop(),
    };

    // Position against the display the window is currently on, honouring the
    // work area so the tile never lands under a menu bar or taskbar.
    const display = screen.getDisplayMatching(saved.bounds);
    const area = display.workArea;
    const x = Math.round(area.x + area.width - PIP_WIDTH - MARGIN);
    const y = Math.round(area.y + MARGIN);

    // The normal minimum size is far larger than the tile.
    win.setMinimumSize(200, 120);
    win.setResizable(false);
    win.setAlwaysOnTop(true, 'floating');
    win.setBounds({ x, y, width: PIP_WIDTH, height: PIP_HEIGHT });
    if (process.platform === 'darwin' && win.setWindowButtonVisibility) {
      try {
        win.setWindowButtonVisibility(false);
      } catch {}
    }
    if (win.isMinimized()) win.restore();
    win.showInactive();

    active = true;
    onChange(true);
  }

  function exit() {
    const win = getWindow();
    if (!win || win.isDestroyed() || !active) return;

    if (saved) {
      win.setResizable(true);
      win.setMinimumSize(saved.minimum[0], saved.minimum[1]);
      win.setAlwaysOnTop(saved.alwaysOnTop);
      win.setBounds(saved.bounds);
    }
    if (process.platform === 'darwin' && win.setWindowButtonVisibility) {
      try {
        win.setWindowButtonVisibility(true);
      } catch {}
    }
    active = false;
    saved = null;
    onChange(false);
  }

  function toggle() {
    if (active) exit();
    else enter();
  }

  // Minimising during a video call docks to PiP instead.
  function attach(win) {
    win.on('minimize', (e) => {
      if (!callActive || active) return;
      e.preventDefault();
      enter();
    });
  }

  return { attach, enter, exit, toggle, isActive, setCallActive };
}

module.exports = { createPip, PIP_WIDTH, PIP_HEIGHT, MARGIN };
