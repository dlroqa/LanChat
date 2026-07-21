import React, { useEffect, useRef, useState } from 'react';
import Avatar from './Avatar.jsx';
import DevicePicker from './DevicePicker.jsx';
import { createLevelMeter } from '../lib/audioMeter.js';
import { Mic, MicOff, Video, VideoOff, PhoneOff, Settings } from '../lib/icons.jsx';

// Full-screen active-call surface: remote video (or audio-only card), local PiP,
// and the control bar. Driven entirely by CallManager state passed as `call`.
export default function CallOverlay({
  call,
  devices,
  onHangup,
  onToggleMute,
  onToggleCamera,
  onSwitchDevice,
  onAudioStats,
}) {
  const localRef = useRef(null);
  const remoteRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const [elapsed, setElapsed] = useState(0);
  const [showDevices, setShowDevices] = useState(false);
  const [playError, setPlayError] = useState(null);
  const [levels, setLevels] = useState({ local: 0, remote: 0 });
  const [audioStats, setAudioStats] = useState(null);

  useEffect(() => {
    attachStream(localRef.current, call.localStream);
  }, [call.localStream, call.cameraOff]);

  // Remote audio plays through its own <audio> element rather than relying on a
  // hidden <video>: it is always present regardless of video state, and makes
  // audio-only calls independent of anything to do with video rendering.
  useEffect(() => {
    attachStream(remoteAudioRef.current, call.remoteStream, (err) => setPlayError(err.message));
    attachStream(remoteRef.current, call.remoteStream);
  }, [call.remoteStream]);

  useEffect(() => {
    if (call.status !== 'in-call') return undefined;
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [call.status]);

  // Live audio meters + transport counters. These turn "I can't hear anything"
  // into a specific answer: is the mic capturing, are bytes arriving, or is
  // playback blocked?
  useEffect(() => {
    const localMeter = createLevelMeter(call.localStream);
    const remoteMeter = createLevelMeter(call.remoteStream);
    const t = setInterval(async () => {
      setLevels({
        local: localMeter ? localMeter.getLevel() : 0,
        remote: remoteMeter ? remoteMeter.getLevel() : 0,
      });
      if (onAudioStats) setAudioStats(await onAudioStats());
    }, 500);
    return () => {
      clearInterval(t);
      localMeter?.stop();
      remoteMeter?.stop();
    };
  }, [call.localStream, call.remoteStream, onAudioStats]);

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

        {/* Remote audio always plays here, independent of any video element. */}
        <audio ref={remoteAudioRef} autoPlay />

        {call.withVideo && call.localStream && !call.cameraOff && (
          <video ref={localRef} className="call-local" autoPlay playsInline muted />
        )}
      </div>

      <AudioDiagnostics
        levels={levels}
        stats={audioStats}
        muted={call.muted}
        playError={playError}
        connected={call.status === 'in-call'}
        onRetryPlay={() => {
          setPlayError(null);
          attachStream(remoteAudioRef.current, call.remoteStream, (err) => setPlayError(err.message));
        }}
      />

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

// Shows whether audio is actually being captured, transmitted, and played, so
// "I can't hear anything" resolves to a specific cause instead of a guess.
function AudioDiagnostics({ levels, stats, muted, playError, connected, onRetryPlay }) {
  if (!connected) return null;
  const noneReceived = stats && stats.bytesReceived === 0;
  const noneSent = stats && stats.bytesSent === 0;

  return (
    <div className="call-diag">
      <Meter label="You" level={levels.local} warn={muted ? 'muted' : noneSent ? 'not sending' : null} />
      <Meter label="Them" level={levels.remote} warn={noneReceived ? 'no audio received' : null} />
      {playError && (
        <button className="btn" onClick={onRetryPlay} title={playError}>
          Enable sound
        </button>
      )}
    </div>
  );
}

function Meter({ label, level, warn }) {
  return (
    <div className="meter">
      <span className="meter-label">{label}</span>
      <span className="meter-bar">
        <span style={{ width: `${Math.round(level * 100)}%` }} />
      </span>
      {warn && <span className="meter-warn">{warn}</span>}
    </div>
  );
}

// Bind a MediaStream to a media element and nudge playback. Chromium can refuse
// to autoplay unmuted media; that used to be swallowed, which made a blocked
// call indistinguishable from a broken one, so failures are reported now.
function attachStream(el, stream, onError) {
  if (!el || !stream) return;
  if (el.srcObject !== stream) el.srcObject = stream;
  const p = el.play();
  if (p && typeof p.catch === 'function') {
    p.catch((err) => {
      if (onError) onError(err);
      else console.warn('[call] playback failed:', err.message);
    });
  }
}

function fmt(s) {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
