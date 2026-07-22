import React, { useEffect, useRef } from 'react';
import Avatar from './Avatar.jsx';
import { Mic, MicOff, Video, VideoOff, PhoneOff } from '../lib/icons.jsx';

// Full-screen group call: a responsive grid of participant tiles (self + each
// remote peer), plus mute / camera / leave controls. Driven entirely by
// GroupCallManager state passed as `call`.
export default function GroupCallView({ call, self, onLeave, onToggleMute, onToggleCamera }) {
  const tiles = [
    { id: 'self', name: `${self?.name || 'You'} (you)`, stream: call.localStream, self: true, connected: true, cameraOff: call.cameraOff },
    ...call.participants.map((p) => ({ ...p, self: false })),
  ];
  const cols = gridColumns(tiles.length);

  return (
    <div className="group-call">
      <div className="gc-header">
        <span className="gc-title">Group call</span>
        <span className="gc-count">{call.count} in call</span>
      </div>

      <div className="gc-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {tiles.map((t) => (
          <Tile key={t.id} tile={t} withVideo={call.withVideo} muted={t.self && call.muted} />
        ))}
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
        <button className="call-btn hang" onClick={onLeave} title="Leave call">
          <PhoneOff size={24} />
        </button>
      </div>
    </div>
  );
}

function Tile({ tile, withVideo, muted }) {
  const ref = useRef(null);
  const hasVideo = Boolean(tile.stream && tile.stream.getVideoTracks && tile.stream.getVideoTracks().length > 0);
  const showVideo = withVideo && hasVideo && !tile.cameraOff;

  useEffect(() => {
    const el = ref.current;
    if (!el || !tile.stream) return;
    if (el.srcObject !== tile.stream) el.srcObject = tile.stream;
    const p = el.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }, [tile.stream]);

  return (
    <div className="gc-tile">
      {/* Self tile is always muted locally to avoid an echo of your own mic. */}
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={muted || tile.self}
        className="gc-video"
        style={{ display: showVideo ? 'block' : 'none', transform: tile.self ? 'scaleX(-1)' : 'none' }}
      />
      {!showVideo && (
        <div className="gc-placeholder">
          <Avatar name={tile.name} id={tile.id} size="lg" />
        </div>
      )}
      <div className="gc-label">
        {tile.name}
        {!tile.self && !tile.connected && <span className="gc-connecting"> · connecting…</span>}
      </div>
    </div>
  );
}

// Grid columns that keep tiles roughly square as the group grows.
function gridColumns(n) {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}
