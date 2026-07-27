'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The splash has exactly one thing to say to the main process — that it is
// finished, either because the sequence ran out or because it was skipped — so
// this bridge exposes exactly that and nothing else. It deliberately does not
// share the app's preload: the splash has no business reaching the store, the
// peer hub, or anything else the real window can touch.
contextBridge.exposeInMainWorld('lanchatSplash', {
  done: () => ipcRenderer.send('splash:done'),
});
