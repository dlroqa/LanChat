// WebRTC call manager. Signaling frames are relayed through the main process
// (sendSignal) to the peer and back via handleSignal. On a tailnet/LAN the peer
// IP is gathered as a host ICE candidate, so calls connect P2P without STUN/TURN.

import { serializeCandidate, serializeDescription } from './signal.js';

export class CallManager {
  constructor({ sendSignal, onState, getIceServers, getSelfName, getDevices, onError, onPeerLeft }) {
    this.sendSignal = sendSignal;
    this.onState = onState;
    this.getIceServers = getIceServers || (() => []);
    this.getSelfName = getSelfName || (() => null);
    this.getDevices = getDevices || (() => ({ audioInputId: null, videoInputId: null }));
    this.onError = onError || ((m) => console.error('[call]', m));
    this.onPeerLeft = onPeerLeft || (() => {});
    this.reset();
  }

  reset() {
    this.pc = null;
    this.localStream = null;
    this.remoteStream = null;
    this.peerId = null;
    this.callId = null;
    this.pendingOffer = null;
    this.pendingCandidates = [];
    this.status = 'idle'; // idle | outgoing | incoming | connecting | in-call
    this.withVideo = false;
    this.muted = false;
    this.cameraOff = false;
    this.peerName = null;
  }

  // All signaling goes through here so a transport failure can never be silent
  // again (this is exactly how the ICE-candidate bug hid).
  send(signal) {
    return this.sendTo(this.peerId, signal);
  }

  sendTo(peerId, signal) {
    if (!peerId) return;
    try {
      const result = this.sendSignal(peerId, signal);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => this.onError(`signaling failed (${signal.kind}): ${err.message}`));
      }
    } catch (err) {
      this.onError(`signaling failed (${signal.kind}): ${err.message}`);
    }
  }

  emit() {
    this.onState({
      status: this.status,
      peerId: this.peerId,
      peerName: this.peerName,
      withVideo: this.withVideo,
      localStream: this.localStream,
      remoteStream: this.remoteStream,
      muted: this.muted,
      cameraOff: this.cameraOff,
    });
  }

  makeId() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // Honour the user's chosen mic/camera, falling back to system defaults if that
  // device has since been unplugged (an `exact` constraint would otherwise throw
  // and abort the whole call).
  async getMedia(withVideo) {
    const { audioInputId, videoInputId } = this.getDevices();
    const videoBase = { width: { ideal: 1280 }, height: { ideal: 720 } };
    const preferred = {
      audio: audioInputId ? { deviceId: { exact: audioInputId } } : true,
      video: withVideo ? (videoInputId ? { ...videoBase, deviceId: { exact: videoInputId } } : videoBase) : false,
    };
    try {
      return await navigator.mediaDevices.getUserMedia(preferred);
    } catch (err) {
      if (!audioInputId && !videoInputId) throw err;
      return navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo ? videoBase : false });
    }
  }

  // Audio transport counters, used to tell "not sent" from "not played".
  async getAudioStats() {
    if (!this.pc) return null;
    try {
      const stats = await this.pc.getStats();
      let bytesReceived = 0;
      let bytesSent = 0;
      stats.forEach((r) => {
        if (r.kind !== 'audio' && r.mediaType !== 'audio') return;
        if (r.type === 'inbound-rtp') bytesReceived += r.bytesReceived || 0;
        if (r.type === 'outbound-rtp') bytesSent += r.bytesSent || 0;
      });
      return { bytesReceived, bytesSent, connection: this.pc.connectionState, ice: this.pc.iceConnectionState };
    } catch {
      return null;
    }
  }

  // Swap the mic or camera mid-call without renegotiating.
  async switchDevice(kind, deviceId) {
    if (!this.pc || !this.localStream) return;
    const isVideo = kind === 'video';
    const constraints = isVideo
      ? { video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } }
      : { audio: { deviceId: { exact: deviceId } } };

    const fresh = await navigator.mediaDevices.getUserMedia(constraints);
    const newTrack = isVideo ? fresh.getVideoTracks()[0] : fresh.getAudioTracks()[0];
    if (!newTrack) return;

    const sender = this.pc.getSenders().find((s) => s.track && s.track.kind === newTrack.kind);
    if (sender) await sender.replaceTrack(newTrack);

    const old = isVideo ? this.localStream.getVideoTracks()[0] : this.localStream.getAudioTracks()[0];
    if (old) {
      this.localStream.removeTrack(old);
      old.stop();
    }
    this.localStream.addTrack(newTrack);
    // New reference so the preview element re-binds (same reason as ontrack).
    this.localStream = new MediaStream(this.localStream.getTracks());
    if (isVideo) newTrack.enabled = !this.cameraOff;
    else newTrack.enabled = !this.muted;
    this.emit();
  }

  createPc() {
    const pc = new RTCPeerConnection({ iceServers: this.getIceServers() });
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        // Must be a plain object: RTCIceCandidate cannot be structured-cloned
        // across IPC, and that failure is what silently broke media.
        this.send({ kind: 'candidate', callId: this.callId, candidate: serializeCandidate(e.candidate) });
      }
    };
    pc.ontrack = (e) => {
      // ontrack fires once per track (audio, then video) carrying the SAME stream
      // object. Re-publishing that identical reference leaves React's dependency
      // unchanged, so the <video> never re-binds and a late-arriving video track
      // stays black. Publish a NEW MediaStream each time to force a re-attach.
      const tracks = e.streams[0] ? e.streams[0].getTracks() : [e.track];
      this.remoteStream = new MediaStream(tracks);
      if (this.status !== 'in-call') this.status = 'in-call';
      this.emit();
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        if (this.status !== 'idle') this.end(false);
      }
    };
    return pc;
  }

  // ---- outgoing ----
  async start(peer, withVideo) {
    if (this.status !== 'idle') return;
    this.peerId = peer.id;
    this.peerName = peer.name;
    this.withVideo = withVideo;
    this.callId = this.makeId();
    this.status = 'outgoing';
    this.emit();
    try {
      this.localStream = await this.getMedia(withVideo);
    } catch (err) {
      this.end(false);
      throw err;
    }
    this.pc = this.createPc();
    for (const track of this.localStream.getTracks()) this.pc.addTrack(track, this.localStream);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    // Carry our display name so the callee can label the incoming call.
    this.send({
      kind: 'offer',
      callId: this.callId,
      withVideo,
      name: this.getSelfName(),
      sdp: serializeDescription(this.pc.localDescription || offer),
    });
    this.emit();
  }

  // ---- incoming signaling ----
  async handleSignal(fromId, signal) {
    if (!signal || !signal.kind) return;
    switch (signal.kind) {
      case 'offer': {
        // Busy if already in a different call.
        if (this.status !== 'idle' && this.peerId !== fromId) {
          this.sendTo(fromId, { kind: 'busy', callId: signal.callId });
          return;
        }
        this.peerId = fromId;
        this.callId = signal.callId;
        this.withVideo = Boolean(signal.withVideo);
        this.peerName = signal.name || null;
        this.pendingOffer = signal.sdp;
        this.status = 'incoming';
        this.emit();
        break;
      }
      case 'answer': {
        if (!this.pc) return;
        await this.pc.setRemoteDescription(signal.sdp);
        await this.flushCandidates();
        this.status = 'in-call';
        this.emit();
        break;
      }
      case 'candidate': {
        if (this.pc && this.pc.remoteDescription) {
          try {
            await this.pc.addIceCandidate(signal.candidate);
          } catch {}
        } else {
          this.pendingCandidates.push(signal.candidate);
        }
        break;
      }
      case 'hangup':
      case 'decline':
      case 'busy': {
        if (this.peerId === fromId) {
          // The remote ended it — chime, but only once we were actually in the
          // call (a 'decline' of an outgoing ring is not a "left the call").
          if (signal.kind === 'hangup' && this.status === 'in-call') {
            this.onPeerLeft(this.peerName);
          }
          this.end(false);
        }
        break;
      }
      default:
        break;
    }
  }

  async flushCandidates() {
    for (const c of this.pendingCandidates) {
      try {
        await this.pc.addIceCandidate(c);
      } catch {}
    }
    this.pendingCandidates = [];
  }

  // ---- accept an incoming call ----
  async accept(prefs = {}) {
    if (this.status !== 'incoming') return;
    this.status = 'connecting';
    this.emit();
    try {
      this.localStream = await this.getMedia(this.withVideo);
    } catch (err) {
      this.decline();
      throw err;
    }
    // Honour the mute / camera-off choices made on the incoming-call toast, so
    // you join already muted or with the camera dark.
    if (prefs.muted) {
      this.muted = true;
      this.localStream.getAudioTracks().forEach((t) => (t.enabled = false));
    }
    if (prefs.cameraOff && this.withVideo) {
      this.cameraOff = true;
      this.localStream.getVideoTracks().forEach((t) => (t.enabled = false));
    }
    this.pc = this.createPc();
    for (const track of this.localStream.getTracks()) this.pc.addTrack(track, this.localStream);
    await this.pc.setRemoteDescription(this.pendingOffer);
    await this.flushCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.send({ kind: 'answer', callId: this.callId, sdp: serializeDescription(this.pc.localDescription || answer) });
    this.emit();
  }

  decline() {
    if (this.peerId) this.send({ kind: 'decline', callId: this.callId });
    this.end(false);
  }

  hangup() {
    if (this.peerId) this.send({ kind: 'hangup', callId: this.callId });
    this.end(false);
  }

  end(notify) {
    if (notify && this.peerId) this.send({ kind: 'hangup', callId: this.callId });
    if (this.localStream) this.localStream.getTracks().forEach((t) => t.stop());
    if (this.pc) {
      try {
        this.pc.close();
      } catch {}
    }
    this.reset();
    this.emit();
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
}
