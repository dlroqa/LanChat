// Push-to-talk: an instant, ring-free voice channel.
//
// Transport is WebRTC (Opus over UDP/SRTP), which on a tailnet connects directly
// peer-to-peer using host ICE candidates — no STUN/TURN, no relay. The renderer
// cannot open a raw UDP socket (contextIsolation), and a hand-rolled UDP path
// would need a native Opus module; WebRTC gives us the same Opus-over-UDP plus a
// jitter buffer, packet-loss concealment and echo cancellation.
//
// Each direction is a SEPARATE connection, deliberately:
//   - Transmitting  : we create the connection and attach our microphone.
//   - Receiving     : we auto-answer *receive-only* and never touch the mic.
// That means an incoming PTT can never silently open your microphone.

const IDLE_RELEASE_MS = 60000; // drop the mic after this long without talking

export class PttManager {
  constructor({ sendSignal, onState, getIceServers, getDevices, onError }) {
    this.sendSignal = sendSignal;
    this.onState = onState;
    this.getIceServers = getIceServers || (() => []);
    this.getDevices = getDevices || (() => ({ audioInputId: null }));
    this.onError = onError || ((m) => console.error('[ptt]', m));

    this.out = null; // { peerId, pc, stream, pending: [] }
    this.inbound = new Map(); // peerId -> { pc, stream, pending: [], talking }
    this.transmitting = false;
    this.connecting = false;
    this.idleTimer = null;
  }

  emit() {
    const talkers = [];
    for (const [peerId, entry] of this.inbound) if (entry.talking) talkers.push(peerId);
    this.onState({
      transmitting: this.transmitting,
      connecting: this.connecting,
      channelPeerId: this.out ? this.out.peerId : null,
      channelReady: Boolean(this.out && this.out.pc && this.out.pc.connectionState === 'connected'),
      talkers,
      inboundStreams: [...this.inbound.entries()].map(([peerId, e]) => ({ peerId, stream: e.stream })),
    });
  }

  send(peerId, signal) {
    if (!peerId) return;
    try {
      // channel:'ptt' keeps this off the normal call signalling path.
      const r = this.sendSignal(peerId, { ...signal, channel: 'ptt' });
      if (r && typeof r.catch === 'function') {
        r.catch((err) => this.onError(`push-to-talk signalling failed: ${err.message}`));
      }
    } catch (err) {
      this.onError(`push-to-talk signalling failed: ${err.message}`);
    }
  }

  newPc(peerId, bucket) {
    const pc = new RTCPeerConnection({ iceServers: this.getIceServers() });
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        // Plain object: RTCIceCandidate is not structured-cloneable across IPC.
        const c = typeof e.candidate.toJSON === 'function' ? e.candidate.toJSON() : e.candidate;
        this.send(peerId, {
          kind: 'candidate',
          candidate: {
            candidate: c.candidate || '',
            sdpMid: c.sdpMid ?? null,
            sdpMLineIndex: c.sdpMLineIndex ?? null,
            usernameFragment: c.usernameFragment ?? null,
          },
        });
      }
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        if (bucket === 'out') this.closeOut();
        else this.closeInbound(peerId);
      }
      this.emit();
    };
    return pc;
  }

  // ---- transmitting side ----------------------------------------------------

  async ensureChannel(peer) {
    if (this.out && this.out.peerId === peer.id) return this.out;
    this.closeOut();
    this.connecting = true;
    this.emit();

    const { audioInputId } = this.getDevices();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: audioInputId ? { deviceId: { exact: audioInputId } } : true,
      });
    } catch (err) {
      this.connecting = false;
      this.emit();
      throw err;
    }
    // Silent until the key is actually held.
    stream.getAudioTracks().forEach((t) => (t.enabled = false));

    const pc = this.newPc(peer.id, 'out');
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.out = { peerId: peer.id, pc, stream, pending: [] };
    this.send(peer.id, { kind: 'offer', ptt: true, sdp: { type: offer.type, sdp: offer.sdp } });
    this.connecting = false;
    this.emit();
    return this.out;
  }

  // Held down / released.
  async setTransmitting(on, peer) {
    if (on) {
      if (!peer) return;
      clearTimeout(this.idleTimer);
      try {
        await this.ensureChannel(peer);
      } catch (err) {
        this.onError(`Cannot open push-to-talk: ${err.message}`);
        return;
      }
      if (!this.out) return;
      this.out.stream.getAudioTracks().forEach((t) => (t.enabled = true));
      this.transmitting = true;
      this.send(this.out.peerId, { kind: 'talk', talking: true });
    } else {
      if (this.out) {
        this.out.stream.getAudioTracks().forEach((t) => (t.enabled = false));
        this.send(this.out.peerId, { kind: 'talk', talking: false });
      }
      this.transmitting = false;
      // Release the microphone if PTT goes unused, so the OS mic indicator does
      // not stay lit indefinitely.
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.closeOut(), IDLE_RELEASE_MS);
    }
    this.emit();
  }

  closeOut() {
    if (!this.out) return;
    try {
      this.out.stream.getTracks().forEach((t) => t.stop());
      this.out.pc.close();
    } catch {}
    this.out = null;
    this.transmitting = false;
    this.emit();
  }

  // ---- receiving side -------------------------------------------------------

  async handleSignal(fromId, signal) {
    if (!signal || !signal.kind) return;

    if (signal.kind === 'offer' && signal.ptt) {
      // Auto-answer, receive-only: we add no tracks, so the mic is never opened.
      this.closeInbound(fromId);
      const pc = this.newPc(fromId, 'in');
      const entry = { pc, stream: null, pending: [], talking: false };
      this.inbound.set(fromId, entry);
      pc.ontrack = (e) => {
        entry.stream = new MediaStream(e.streams[0] ? e.streams[0].getTracks() : [e.track]);
        this.emit();
      };
      try {
        await pc.setRemoteDescription(signal.sdp);
        for (const c of entry.pending) await pc.addIceCandidate(c).catch(() => {});
        entry.pending = [];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.send(fromId, { kind: 'answer', sdp: { type: answer.type, sdp: answer.sdp } });
      } catch (err) {
        this.onError(`push-to-talk answer failed: ${err.message}`);
      }
      this.emit();
      return;
    }

    if (signal.kind === 'answer') {
      if (this.out && this.out.peerId === fromId) {
        try {
          await this.out.pc.setRemoteDescription(signal.sdp);
          for (const c of this.out.pending) await this.out.pc.addIceCandidate(c).catch(() => {});
          this.out.pending = [];
        } catch (err) {
          this.onError(`push-to-talk setup failed: ${err.message}`);
        }
        this.emit();
      }
      return;
    }

    if (signal.kind === 'candidate') {
      const target =
        this.out && this.out.peerId === fromId ? this.out : this.inbound.get(fromId) || null;
      if (!target) return;
      if (target.pc.remoteDescription) await target.pc.addIceCandidate(signal.candidate).catch(() => {});
      else target.pending.push(signal.candidate);
      return;
    }

    if (signal.kind === 'talk') {
      const entry = this.inbound.get(fromId);
      if (entry) {
        entry.talking = Boolean(signal.talking);
        this.emit();
      }
      return;
    }

    if (signal.kind === 'close') {
      this.closeInbound(fromId);
    }
  }

  closeInbound(peerId) {
    const entry = this.inbound.get(peerId);
    if (!entry) return;
    try {
      entry.pc.close();
    } catch {}
    this.inbound.delete(peerId);
    this.emit();
  }

  closeAll() {
    clearTimeout(this.idleTimer);
    if (this.out) this.send(this.out.peerId, { kind: 'close' });
    this.closeOut();
    for (const peerId of [...this.inbound.keys()]) this.closeInbound(peerId);
  }
}

// ---------------------------------------------------------------------------
// Keyboard handling.
//
// Electron's globalShortcut has no key-up event, so true hold-to-talk only works
// while the window has focus — that is a platform limit, not a design choice.
// Default key is the platform's primary modifier: Command on macOS, Control on
// Windows and Linux.

export const PTT_KEYS = {
  meta: { label: 'Command (⌘)', match: (e) => e.key === 'Meta', win: 'Control', code: 'Meta' },
  control: { label: 'Control', match: (e) => e.key === 'Control', code: 'Control' },
  alt: { label: 'Option / Alt', match: (e) => e.key === 'Alt', code: 'Alt' },
  space: { label: 'Space', match: (e) => e.code === 'Space', code: 'Space' },
};

export function defaultPttKey() {
  return navigator.platform.toLowerCase().includes('mac') ? 'meta' : 'control';
}

// Attaches hold-to-talk listeners. Returns an unsubscribe function.
export function attachPttKey({ keyName, isEnabled, onDown, onUp }) {
  const def = PTT_KEYS[keyName] || PTT_KEYS[defaultPttKey()];
  let held = false;
  let poisoned = false; // another key was pressed during the hold

  const typing = () => {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
  };

  const release = () => {
    if (!held) return;
    held = false;
    poisoned = false;
    onUp();
  };

  const down = (e) => {
    if (!isEnabled()) return;
    if (held) {
      // A modifier held with another key is a shortcut (⌘C, ⌘V) — not talking.
      if (!def.match(e)) {
        poisoned = true;
        release();
      }
      return;
    }
    if (!def.match(e)) return;
    // Never hijack the key while the user is typing a message.
    if (typing()) return;
    if (e.repeat) return;
    held = true;
    poisoned = false;
    onDown();
  };

  const up = (e) => {
    if (!held) return;
    if (def.match(e) || (def.code === 'Space' && e.code === 'Space')) release();
  };

  // Losing focus mid-hold must stop transmission, or the mic stays live.
  const blur = () => release();

  window.addEventListener('keydown', down, true);
  window.addEventListener('keyup', up, true);
  window.addEventListener('blur', blur);
  return () => {
    release();
    window.removeEventListener('keydown', down, true);
    window.removeEventListener('keyup', up, true);
    window.removeEventListener('blur', blur);
  };
}
