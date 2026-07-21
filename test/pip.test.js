'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// pip.js needs electron's `screen`; stub it so the geometry can be unit-tested.
const DISPLAY = { workArea: { x: 0, y: 25, width: 1440, height: 875 } };
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'electron' ? 'estub' : orig.call(this, r, ...a);
};
require.cache['estub'] = {
  id: 'estub',
  filename: 'estub',
  loaded: true,
  exports: { screen: { getDisplayMatching: () => DISPLAY } },
};

const { createPip, PIP_WIDTH, PIP_HEIGHT, MARGIN } = require('../src/main/pip.js');

function fakeWindow(bounds = { x: 100, y: 100, width: 1120, height: 740 }) {
  const state = {
    bounds: { ...bounds },
    minimum: [820, 560],
    resizable: true,
    onTop: false,
    buttons: true,
    minimized: false,
    events: {},
  };
  return {
    state,
    isDestroyed: () => false,
    getBounds: () => ({ ...state.bounds }),
    setBounds: (b) => Object.assign(state.bounds, b),
    getMinimumSize: () => [...state.minimum],
    setMinimumSize: (w, h) => (state.minimum = [w, h]),
    isResizable: () => state.resizable,
    setResizable: (v) => (state.resizable = v),
    isAlwaysOnTop: () => state.onTop,
    setAlwaysOnTop: (v) => (state.onTop = v),
    setWindowButtonVisibility: (v) => (state.buttons = v),
    isMinimized: () => state.minimized,
    restore: () => (state.minimized = false),
    showInactive: () => {},
    on: (name, fn) => (state.events[name] = fn),
  };
}

test('entering PiP pins the tile to the top-right of the work area', () => {
  const win = fakeWindow();
  const pip = createPip({ getWindow: () => win, onChange: () => {} });
  pip.enter();

  const b = win.state.bounds;
  assert.equal(b.width, PIP_WIDTH);
  assert.equal(b.height, PIP_HEIGHT);
  // Right edge sits one margin inside the work area's right edge.
  assert.equal(b.x + b.width, DISPLAY.workArea.x + DISPLAY.workArea.width - MARGIN);
  // Top edge respects the work area origin (so it clears the menu bar).
  assert.equal(b.y, DISPLAY.workArea.y + MARGIN);
  assert.equal(win.state.onTop, true, 'PiP must float above other windows');
  assert.ok(win.state.minimum[0] <= PIP_WIDTH, 'minimum size must allow the tile');
});

test('exiting PiP restores the original bounds and constraints', () => {
  const win = fakeWindow({ x: 240, y: 180, width: 1120, height: 740 });
  const pip = createPip({ getWindow: () => win, onChange: () => {} });

  pip.enter();
  pip.exit();

  assert.deepEqual(win.state.bounds, { x: 240, y: 180, width: 1120, height: 740 });
  assert.deepEqual(win.state.minimum, [820, 560], 'original minimum size restored');
  assert.equal(win.state.onTop, false);
  assert.equal(win.state.resizable, true);
  assert.equal(pip.isActive(), false);
});

test('minimising docks to PiP only during a video call', () => {
  const win = fakeWindow();
  const pip = createPip({ getWindow: () => win, onChange: () => {} });
  pip.attach(win);

  let prevented = false;
  const evt = { preventDefault: () => (prevented = true) };

  // No call in progress: minimise must behave normally.
  win.state.events.minimize(evt);
  assert.equal(prevented, false);
  assert.equal(pip.isActive(), false);

  // During a video call it docks instead of disappearing.
  pip.setCallActive(true);
  win.state.events.minimize(evt);
  assert.equal(prevented, true, 'minimise is intercepted during a video call');
  assert.equal(pip.isActive(), true);
});

test('ending the call leaves PiP automatically', () => {
  const win = fakeWindow();
  const pip = createPip({ getWindow: () => win, onChange: () => {} });
  pip.setCallActive(true);
  pip.enter();
  assert.equal(pip.isActive(), true);

  pip.setCallActive(false);
  assert.equal(pip.isActive(), false, 'hanging up must restore the window');
  assert.deepEqual(win.state.minimum, [820, 560]);
});

test('entering twice does not clobber the saved bounds', () => {
  const win = fakeWindow({ x: 50, y: 60, width: 1120, height: 740 });
  const pip = createPip({ getWindow: () => win, onChange: () => {} });
  pip.enter();
  pip.enter(); // must be a no-op, not save the PiP bounds as "normal"
  pip.exit();
  assert.deepEqual(win.state.bounds, { x: 50, y: 60, width: 1120, height: 740 });
});
