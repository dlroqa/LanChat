import React, { useEffect, useRef, useState } from 'react';
import Avatar from './Avatar.jsx';
import DevicePicker from './DevicePicker.jsx';
import { Mic, MicOff, Video, VideoOff, PhoneOff, Settings } from '../lib/icons.jsx';

// Full-screen active-call surface: remote video (or audio-only card), local PiP,
// and the control bar. Driven entirely by CallManager state passed as `call`.
export default function CallOverlay({ call, devices, onHangup, onToggleMute, onToggleCamera, onSwitchDevice }) {
  const localRef = useRef(null);
  const remoteRef = useRef(null);
  const [elapsed, setElapsed] = useState(0);
  const [showDevices, setShowDevices] = useState(false);

  useEffect(() => {
    attachStream(localRef.current, call.localStream);
  }, [call.localStream, call.cameraOff]);

  useEffect(() => {
    attachStream(remoteRef.current, call.remoteStream);
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

  // Only treat the remote as "video" once an actual video track has arrived.
  const hasRemoteVideo = Boolean(call.remoteStream && call.remoteStream.getVideoTracks().length > 0);
  const showRemoteVideo = call.withVideo && hasRemoteVideo;

  return (
    <div className="call">
      <div className="call-stage">
        {/* One always-mounted remote element. Swapping between two <video> tags
            reassigned the ref without re-running the attach effect, so the remote
            stream could end up bound to an unmounted node. It also carries the
            remote audio during voice-only calls. */}
        <video
          ref={remoteRef}
          className="call-remote"
          autoPlay
          playsInline
          style={{ display: showRemoteVideo ? 'block' : 'none' }}
        />
        {!showRemoteVideo && (
          <div className="call-audio-only">
            <Avatar name={call.peerName} id={call.peerId} size="lg" />
            <div style={{ fontSize: 20, fontWeight: 600 }}>{call.peerName || 'Peer'}</div>
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

      {showDevices && (
        <div className="device-panel" role="dialog" aria-label="Audio and video sources">
          <div className="device-panel-title">Sources</div>
          <DevicePicker
            audioInputId={devices?.audioInputId}
            videoInputId={devices?.videoInputId}
            showVideo={call.withVideo}
            compact
            onChange={onSwitchDevice}
          />
        </div>
      )}

      <div className="call-bar">
        <button
          className={`call-btn ${showDevices ? 'active' : ''}`}
          onClick={() => setShowDevices((v) => !v)}
          title="Change microphone or camera"
          aria-expanded={showDevices}
        >
          <Settings size={22} />
        </button>
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

// Bind a MediaStream to a <video>, and nudge playback: Chromium can refuse to
// autoplay an unmuted element, which shows up as a frozen black frame.
function attachStream(el, stream) {
  if (!el || !stream) return;
  if (el.srcObject !== stream) el.srcObject = stream;
  const p = el.play();
  if (p && typeof p.catch === 'function') p.catch(() => {});
}

function fmt(s) {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
