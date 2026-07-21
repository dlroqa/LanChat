'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Persistent configuration + identity stored in the Electron userData dir.
// Kept dependency-free (plain JSON) so packaging stays trivial across platforms.

const DEFAULTS = Object.freeze({
  id: null, // filled on first run
  displayName: null, // prompts the user on first run
  avatar: null, // optional data-URL emoji/color; kept small
  servicePort: 47100, // HTTP + WebSocket service port
  discoveryPort: 47101, // UDP LAN broadcast port
  iceServers: [], // e.g. [{ urls: 'stun:stun.l.google.com:19302' }]
  audioInputId: null, // preferred microphone (null = system default)
  videoInputId: null, // preferred camera (null = system default)
  enableTailscale: true,
  enableLan: true,
  manualPeers: [], // ["100.x.y.z:47100", "192.168.1.5:47100"]
});

class Config {
  constructor(userDataDir) {
    this.dir = userDataDir;
    this.file = path.join(userDataDir, 'config.json');
    this.data = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.data = { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
      // First run or unreadable file — fall back to defaults.
      this.data = { ...DEFAULTS };
    }
    let dirty = false;
    if (!this.data.id) {
      this.data.id = crypto.randomUUID();
      dirty = true;
    }
    if (dirty) this.save();
    return this.data;
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('[config] save failed:', err.message);
    }
  }

  get(key) {
    return this.data[key];
  }

  set(patch) {
    this.data = { ...this.data, ...patch };
    this.save();
    return this.data;
  }

  get isConfigured() {
    return Boolean(this.data.id && this.data.displayName);
  }
}

module.exports = { Config, DEFAULTS };
