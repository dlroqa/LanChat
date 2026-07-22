// Group video calls, as a full WebRTC mesh.
//
// Every participant holds a direct PeerConnection to every other participant and
// shares one local mic+camera stream across all of them. This keeps LanChat's
// serverless, peer-to-peer model — no SFU/media server — and reuses the exact
// tailnet/LAN ICE path that 1:1 calls already use. A mesh is O(n²) connections,
// so it suits small groups (roughly up to 5–6 on a LAN); that is the intended
// scale for a personal tool, and it is stated plainly in the UI.
//
// Coordination is decentralised — there is no "host" with authority once the
// call is running:
//   - The invite carries the current roster so a newcomer knows everyone.
//   - The newcomer announces itself to every roster member with `join`.
//   - Glare is avoided deterministically: for any pair, the lexicographically
//     smaller id creates the offer. Both sides apply the same rule, so exactly
//     one offer is made.
//   - `leave` is broadcast to everyone, so the roster needs no central owner.

import { serializeCandidate, serializeDescription } from './signal.js';

// Deterministic offerer: the smaller id offers. Pure and exported for tests.
export function shouldOffer(selfId, otherId) {
  return String(selfId) < String(otherId);
}

// Reconcile a known roster against a new one. Pure and exported for tests.
export function reconcileRoster(current, next, selfId) {
  const nextIds = new Set(next.map((p) => p.id).filter((id) => id !== selfId));
  const currentIds = new Set(current);
  const added = [...nextIds].filter((id) => !currentIds.has(id));
  const removed = [...currentIds].filter((id) => !nextIds.has(id));
  return { added, removed };
}

export class GroupCallManager {
  constructor({ sendSignal, onState, getIceServers, getDevices, getSelf, isBusy, onError }) {
    this.sendSignal = sendSignal;
    this.onState = onState;
    this.getIceServers = getIceServers || (() => []);
    this.getDevices = getDevices || (() => ({ audioInputId: null, videoInputId: null }));
    this.getSelf = getSelf || (() => ({ id: null, name: null }));
    this.isBusy = isBusy || (() => false); // a 1:1 call is in progress
    this.onError = onError || ((m) => console.error('[group]', m));
    this.reset();
  }

  reset() {
    this.roomId = null;
    this.status = 'idle'; // idle | inviting | invited | in-call
    this.withVideo = true;
    this.localStream = null;
    this.peers = new Map(); // peerId -> { pc, stream, name, pending: [] }
    this.roster = new Map(); // peerId -> { id, name } (others, not self)
    this.invite = null; // pending incoming invite
    this.hostName = null;
    this.muted = false;
    this.cameraOff = false;
  }

  emit() {
    const participants = [];
    for (const [id, info] of this.roster) {
      const peer = this.peers.get(id);
      participants.push({
        id,
        name: info.name,
        stream: peer ? peer.stream : null,
        connected: Boolean(peer && peer.pc && peer.pc.connectionState === 'connected'),
      });
    }
    this.onState({
      status: this.status,
      roomId: this.roomId,
      withVideo: this.withVideo,
      localStream: this.localStream,
      participants,
      invite: this.invite,
      muted: this.muted,
      cameraOff: this.cameraOff,
      count: participants.length + (this.status === 'in-call' ? 1 : 0),
    });
  }

  makeRoomId() {
    return `g-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }

  signal(peerId, msg) {
    if (!peerId) return;
    try {
      const r = this.sendSignal(peerId, { ...msg, channel: 'group', roomId: this.roomId });
      if (r && typeof r.catch === 'function') r.catch((err) => this.onError(`group signalling failed: ${err.message}`));
    } catch (err) {
      this.onError(`group signalling failed: ${err.message}`);
    }
  }

  async getMedia(withVideo) {
    const { audioInputId, videoInputId } = this.getDevices();
    const video = withVideo
      ? { width: { ideal: 1280 }, height: { ideal: 720 }, ...(videoInputId ? { deviceId: { exact: videoInputId } } : {}) }
      : false;
    const audio = audioInputId ? { deviceId: { exact: audioInputId } } : true;
    try {
      return await navigator.mediaDevices.getUserMedia({ audio, video });
    } catch (err) {
      if (!audioInputId && !videoInputId) throw err;
      return navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
    }
  }

  rosterArray() {
    // Includes self, since invitees need to know everyone.
    const self = this.getSelf();
    return [{ id: self.id, name: self.name }, ...[...this.roster.values()]];
  }

  // ---- start a group call --------------------------------------------------
  async host(peers, withVideo) {
    if (this.status !== 'idle' || this.isBusy()) return;
    this.roomId = this.makeRoomId();
    this.withVideo = withVideo;
    this.status = 'in-call';
    try {
      this.localStream = await this.getMedia(withVideo);
    } catch (err) {
      this.reset();
      this.onError(`Cannot start group call: ${err.message}`);
      this.emit();
      return;
    }
    const self = this.getSelf();
    // Seed the roster with invitees so the grid shows them as "connecting".
    for (const p of peers) this.roster.set(p.id, { id: p.id, name: p.name });
    for (const p of peers) {
      this.signal(p.id, {
        kind: 'invite',
        withVideo,
        hostName: self.name,
        roster: this.rosterArray(),
      });
    }
    this.emit();
  }

  // ---- incoming invite -----------------------------------------------------
  receiveInvite(fromId, signal) {
    if (this.isBusy() || this.status === 'in-call') {
      this.sendSignal(fromId, { channel: 'group', roomId: signal.roomId, kind: 'decline' });
      return;
    }
    this.invite = {
      roomId: signal.roomId,
      from: fromId,
      hostName: signal.hostName,
      withVideo: Boolean(signal.withVideo),
      roster: signal.roster || [],
    };
    this.status = 'invited';
    this.emit();
  }

  async accept(prefs = {}) {
    if (this.status !== 'invited' || !this.invite) return;
    const inv = this.invite;
    this.roomId = inv.roomId;
    this.withVideo = inv.withVideo;
    this.hostName = inv.hostName;
    try {
      this.localStream = await this.getMedia(inv.withVideo);
    } catch (err) {
      this.decline();
      this.onError(`Cannot join group call: ${err.message}`);
      return;
    }
    this.status = 'in-call';
    this.invite = null;

    // Apply pre-answer mute / camera-off choices before any track is published.
    if (prefs.muted) {
      this.muted = true;
      this.localStream.getAudioTracks().forEach((t) => (t.enabled = false));
    }
    if (prefs.cameraOff && this.withVideo) {
      this.cameraOff = true;
      this.localStream.getVideoTracks().forEach((t) => (t.enabled = false));
    }

    const self = this.getSelf();
    // Populate the roster from the invite (everyone except us).
    for (const p of inv.roster) {
      if (p.id && p.id !== self.id) this.roster.set(p.id, { id: p.id, name: p.name });
    }
    // Announce ourselves to everyone, then connect per the glare rule.
    for (const [id, info] of this.roster) {
      this.signal(id, { kind: 'join', name: self.name });
      this.connectTo(id, info.name, shouldOffer(self.id, id));
    }
    this.emit();
  }

  decline() {
    if (this.invite) this.sendSignal(this.invite.from, { channel: 'group', roomId: this.invite.roomId, kind: 'decline' });
    this.invite = null;
    if (this.status === 'invited') this.status = 'idle';
    this.emit();
  }

  // ---- mesh connections ----------------------------------------------------
  connectTo(peerId, name, initiate) {
    if (this.peers.has(peerId)) return;
    const pc = new RTCPeerConnection({ iceServers: this.getIceServers() });
    const entry = { pc, stream: null, name, pending: [] };
    this.peers.set(peerId, entry);

    for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);

    pc.onicecandidate = (e) => {
      if (e.candidate) this.signal(peerId, { kind: 'candidate', candidate: serializeCandidate(e.candidate) });
    };
    pc.ontrack = (e) => {
      entry.stream = new MediaStream(e.streams[0] ? e.streams[0].getTracks() : [e.track]);
      this.emit();
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) this.dropPeer(peerId);
      this.emit();
    };

    if (initiate) {
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer).then(() => offer))
        .then((offer) => this.signal(peerId, { kind: 'offer', sdp: serializeDescription(pc.localDescription || offer) }))
        .catch((err) => this.onError(`group offer failed: ${err.message}`));
    }
    this.emit();
  }

  async handleSignal(fromId, signal) {
    if (!signal || signal.channel !== 'group') return;

    if (signal.kind === 'invite') return this.receiveInvite(fromId, signal);

    // Ignore traffic for a different room than the one we're in.
    if (this.status !== 'in-call' || signal.roomId !== this.roomId) {
      if (signal.kind === 'join') {
        // We may not have this room yet if timing raced; ignore safely.
      }
      return;
    }

    switch (signal.kind) {
      case 'join': {
        // A newcomer announced itself. Add to roster and connect per glare rule.
        if (!this.roster.has(fromId)) this.roster.set(fromId, { id: fromId, name: signal.name });
        this.connectTo(fromId, signal.name, shouldOffer(this.getSelf().id, fromId));
        this.emit();
        break;
      }
      case 'offer': {
        let entry = this.peers.get(fromId);
        if (!entry) {
          this.roster.set(fromId, { id: fromId, name: this.roster.get(fromId)?.name });
          this.connectTo(fromId, this.roster.get(fromId)?.name, false);
          entry = this.peers.get(fromId);
        }
        try {
          await entry.pc.setRemoteDescription(signal.sdp);
          for (const c of entry.pending) await entry.pc.addIceCandidate(c).catch(() => {});
          entry.pending = [];
          const answer = await entry.pc.createAnswer();
          await entry.pc.setLocalDescription(answer);
          this.signal(fromId, { kind: 'answer', sdp: serializeDescription(entry.pc.localDescription || answer) });
        } catch (err) {
          this.onError(`group answer failed: ${err.message}`);
        }
        break;
      }
      case 'answer': {
        const entry = this.peers.get(fromId);
        if (!entry) return;
        try {
          await entry.pc.setRemoteDescription(signal.sdp);
          for (const c of entry.pending) await entry.pc.addIceCandidate(c).catch(() => {});
          entry.pending = [];
        } catch (err) {
          this.onError(`group setup failed: ${err.message}`);
        }
        break;
      }
      case 'candidate': {
        const entry = this.peers.get(fromId);
        if (!entry) return;
        if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(signal.candidate).catch(() => {});
        else entry.pending.push(signal.candidate);
        break;
      }
      case 'leave':
        this.dropPeer(fromId);
        this.roster.delete(fromId);
        this.emit();
        break;
      default:
        break;
    }
  }

  dropPeer(peerId) {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    try {
      entry.pc.close();
    } catch {}
    this.peers.delete(peerId);
  }

  toggleMute() {
    if (!this.localStream) return;
    this.muted = !this.muted;
    this.localStream.getAudioTracks().forEach((t) => (t.enabled = !this.muted));
    this.emit();
  }

  toggleCamera() {
    if (!this.localStream) return;
    const vids = this.localStream.getVideoTracks();
    if (!vids.length) return;
    this.cameraOff = !this.cameraOff;
    vids.forEach((t) => (t.enabled = !this.cameraOff));
    this.emit();
  }

  leave() {
    for (const id of this.peers.keys()) this.signal(id, { kind: 'leave' });
    for (const id of [...this.peers.keys()]) this.dropPeer(id);
    if (this.localStream) this.localStream.getTracks().forEach((t) => t.stop());
    this.reset();
    this.emit();
  }
}
