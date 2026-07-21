import React, { useEffect, useRef, useState } from 'react';
import Avatar from './Avatar.jsx';
import { Mic, MicOff, Video, VideoOff, PhoneOff } from '../lib/icons.jsx';

// Full-screen active-call surface: remote video (or audio-only card), local PiP,
// and the control bar. Driven entirely by CallManager state passed as `call`.
export default function CallOverlay({ call, onHangup, onToggleMute, onToggleCamera }) {
  const localRef = useRef(null);
  const remoteRef = useRef(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (localRef.current && call.localStream) localRef.current.srcObject = call.localStream;
  }, [call.localStream]);

  useEffect(() => {
    if (remoteRef.current && call.remoteStream) remoteRef.current.srcObject = call.remoteStream;
  }, [call.remoteStream]);

  useEffect(() => {
    if (call.status !== 'in-call') return undefined;
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [call.status]);

  const statusText =
    call.status === 'outgoing'
      ? 'Calling…'
      : call.status === 'connecting'
        ? 'Connecting…'
        : call.status === 'in-call'
          ? fmt(elapsed)
          : '';

  const showRemoteVideo = call.withVideo && call.remoteStream;

  return (
    <div className="call">
      <div className="call-stage">
        {showRemoteVideo ? (
          <video ref={remoteRef} className="call-remote" autoPlay playsInline />
        ) : (
          <div className="call-audio-only">
            <Avatar name={call.peerName} id={call.peerId} size="lg" />
            <div style={{ fontSize: 20, fontWeight: 600 }}>{call.peerName || 'Peer'}</div>
            {/* Hidden element still needs to play remote audio in audio-only calls */}
            <video ref={remoteRef} autoPlay playsInline style={{ display: 'none' }} />
          </div>
        )}

        <div className="call-status">
          <div style={{ fontWeight: 600 }}>{call.peerName || 'Peer'}</div>
          <div className="t">{statusText}</div>
        </div>

        {call.withVideo && call.localStream && !call.cameraOff && (
          <video ref={localRef} className="call-local" autoPlay playsInline muted />
        )}
      </div>

      <div className="call-bar">
        <button className={`call-btn ${call.muted ? 'off' : ''}`} onClick={onToggleMute} title={call.muted ? 'Unmute' : 'Mute'}>
          {call.muted ? <MicOff size={24} /> : <Mic size={24} />}
        </button>
        {call.withVideo && (
          <button
            className={`call-btn ${call.cameraOff ? 'off' : ''}`}
            onClick={onToggleCamera}
            title={call.cameraOff ? 'Turn camera on' : 'Turn camera off'}
          >
            {call.cameraOff ? <VideoOff size={24} /> : <Video size={24} />}
          </button>
        )}
        <button className="call-btn hang" onClick={onHangup} title="Hang up">
          <PhoneOff size={24} />
        </button>
      </div>
    </div>
  );
}

function fmt(s) {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
