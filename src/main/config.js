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
  showAddresses: false, // hide peers' IP addresses in the UI by default
  // Links in messages are always clickable; this is only about unfurling them
  // into a card, which means LanChat fetching the page itself — the one thing in
  // the app that reaches past your own network, so it is a visible setting.
  linkPreviews: true,
  // Which conversations offer the find bar beside their title. Off means every
  // one of them; on narrows it to sessions, which are the threads that grow long
  // enough for scrolling back through them to be the problem. Off by default:
  // a chat with a person can be just as long, and the button costs nothing when
  // it is not used.
  findSessionsOnly: false,
  // The sidebar's four categories: the order they are stacked in, and which of
  // them are pinned open. Both are arrangements of the panel rather than of the
  // network, so they are per-machine and saved the moment they change. An older
  // or hand-edited list cannot lose a category — the renderer normalizes it back
  // to all four (see renderer lib/sidebarSections.js).
  sidebarOrder: ['sessions', 'agents', 'people', 'tailnet'],
  sidebarLocked: [],
  ringtone: 'classic', // see renderer lib/sounds.js
  ringtoneVolume: 0.8,
  customRingtonePath: null,
  notificationSound: 'ping',
  notificationVolume: 0.7,
  customNotificationPath: null,
  muteNotifications: false,
  // Music while an agent is working (see renderer lib/agentMusic.js). Its own
  // pair of keys rather than riding on muteNotifications: a message ping is an
  // interruption you may want silenced, and a bed you work to is not the same
  // decision. On by default: the music is bundled and the volume is half, so the
  // feature arrives working; one toggle in Settings → Sounds silences it.
  agentMusicEnabled: true,
  // The build that last turned the music on. A version this file has not seen
  // yet switches it back on once (see load()), so an update lands the same way a
  // fresh install does — with music — while switching it off between updates
  // sticks. Internal: not in the renderer's settable keys.
  agentMusicVersion: null,
  agentMusic: null, // null = the default bundled track ("Universe"); or a track name, or 'custom'
  agentMusicVolume: 0.5,
  customAgentMusicPath: null,
  pttEnabled: true,
  pttKey: null, // null = platform default (Command on macOS, Control elsewhere)
  pttCustomCode: null, // KeyboardEvent.code when pttKey === 'custom'
  skippedUpdateVersion: null, // a release the user chose not to be reminded about
  openAtLogin: false, // Windows/macOS: launch LanChat at login (hidden to tray)
  pttAllowIncoming: true,
  // Dictation in agent and session threads, where there is no ear at the far end
  // for live audio. Transcribed by the FluidVoice app over its loopback API;
  // macOS only in practice, and the renderer decides.
  dictationEnabled: true,
  dictationPort: 47733, // FluidVoice's LocalAPI.defaultPort
  audioInputId: null, // preferred microphone (null = system default)
  videoInputId: null, // preferred camera (null = system default)
  enableTailscale: true,
  enableLan: true,
  // Whether we ACCEPT inbound connections that arrived on something other than
  // the tailnet. Deliberately not `enableLan`, which is about whether we send and
  // listen for discovery beacons: finding a laptop over Wi-Fi and letting the
  // whole Wi-Fi network open a socket to you are different decisions, and one
  // key for both means a user gets the second without asking for it.
  //
  // Off by default, and off means nobody outside the tailnet can reach this
  // machine. On a machine with no tailnet at all that means nobody can reach it
  // at all — see netScope.reachability(), which is what tells the window to say
  // so rather than letting the app look broken.
  //
  // Main-owned, like manualPeers: present in publicConfig() so the UI can show
  // it, absent from the setConfig allowlist so it cannot be flipped by a bulk
  // patch. It has its own IPC channel.
  acceptLan: false,
  manualPeers: [], // ["100.x.y.z:47100", "192.168.1.5:47100"]
});

// Settings a previous version stored that are no longer read by anything. See
// the prune in load() for why these are removed from the file rather than simply
// dropped from DEFAULTS.
const RETIRED_KEYS = Object.freeze(['dictationCliPath', 'dictationModelReady']);

class Config {
  // `appVersion` is app.getVersion(); omitted (tests, tools) it simply means no
  // upgrade is being noticed and the stored settings are left exactly as they are.
  constructor(userDataDir, appVersion = null) {
    this.dir = userDataDir;
    this.appVersion = appVersion;
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
    // Music while an agent works comes back on with every new build, not just on
    // a fresh install: it is part of what the app is, and one toggle in
    // Settings → Sounds silences it again until the next update.
    if (this.appVersion && this.data.agentMusicVersion !== this.appVersion) {
      this.data.agentMusicVersion = this.appVersion;
      this.data.agentMusicEnabled = true;
      dirty = true;
    }
    // Keys an older version wrote that nothing reads any more.
    //
    // Deleted from the file, not just from DEFAULTS: load() spreads the stored
    // object over the defaults, so a retired key outlives its own removal and
    // gets written back by every save from then on. Left alone it would be inert
    // — publicConfig() copies only PUBLIC_KEYS, so it never reaches the renderer
    // — but it would also be permanent, and the stored value beats DEFAULTS, so
    // reusing one of these names later would hand an upgraded machine the old
    // value while a fresh install got the new default.
    //
    // A list rather than a pair of deletes: this is the prune step, and the next
    // key to be retired belongs here instead of in new code. Dictation moved from
    // the FluidAudio CLI to the FluidVoice app in 0.7.9.
    for (const key of RETIRED_KEYS) {
      if (key in this.data) {
        delete this.data[key];
        dirty = true;
      }
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

module.exports = { Config, DEFAULTS, RETIRED_KEYS };
