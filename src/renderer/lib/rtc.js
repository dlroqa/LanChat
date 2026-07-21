// WebRTC call manager. Signaling frames are relayed through the main process
// (sendSignal) to the peer and back via handleSignal. On a tailnet/LAN the peer
// IP is gathered as a host ICE candidate, so calls connect P2P without STUN/TURN.

export class CallManager {
  constructor({ sendSignal, onState, getIceServers }) {
    this.sendSignal = sendSignal;
    this.onState = onState;
    this.getIceServers = getIceServers || (() => []);
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

  async getMedia(withVideo) {
    return navigator.mediaDevices.getUserMedia({
      audio: true,
      video: withVideo ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    });
  }

  createPc() {
    const pc = new RTCPeerConnection({ iceServers: this.getIceServers() });
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.sendSignal(this.peerId, { kind: 'candidate', callId: this.callId, candidate: e.candidate });
      }
    };
    pc.ontrack = (e) => {
      this.remoteStream = e.streams[0];
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
    this.sendSignal(this.peerId, { kind: 'offer', callId: this.callId, withVideo, sdp: offer });
    this.emit();
  }

  // ---- incoming signaling ----
  async handleSignal(fromId, signal) {
    if (!signal || !signal.kind) return;
    switch (signal.kind) {
      case 'offer': {
        // Busy if already in a different call.
        if (this.status !== 'idle' && this.peerId !== fromId) {
          this.sendSignal(fromId, { kind: 'busy', callId: signal.callId });
          return;
        }
        this.peerId = fromId;
        this.callId = signal.callId;
        this.withVideo = Boolean(signal.withVideo);
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
        if (this.peerId === fromId) this.end(false);
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
  async accept() {
    if (this.status !== 'incoming') return;
    this.status = 'connecting';
    this.emit();
    try {
      this.localStream = await this.getMedia(this.withVideo);
    } catch (err) {
      this.decline();
      throw err;
    }
    this.pc = this.createPc();
    for (const track of this.localStream.getTracks()) this.pc.addTrack(track, this.localStream);
    await this.pc.setRemoteDescription(this.pendingOffer);
    await this.flushCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.sendSignal(this.peerId, { kind: 'answer', callId: this.callId, sdp: answer });
    this.emit();
  }

  decline() {
    if (this.peerId) this.sendSignal(this.peerId, { kind: 'decline', callId: this.callId });
    this.end(false);
  }

  hangup() {
    if (this.peerId) this.sendSignal(this.peerId, { kind: 'hangup', callId: this.callId });
    this.end(false);
  }

  end(notify) {
    if (notify && this.peerId) this.sendSignal(this.peerId, { kind: 'hangup', callId: this.callId });
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
