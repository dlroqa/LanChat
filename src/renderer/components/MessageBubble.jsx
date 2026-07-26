import React, { useState } from 'react';
import { formatTime, formatBytes, isImage, isVideo, isAudio } from '../lib/util.js';
import { FileIcon, Download } from '../lib/icons.jsx';

// previewUrl builds a localhost URL the main-process server streams the file from.
export default function MessageBubble({ msg, grouped, previewUrl, previewFallback, progress, onOpen, onReveal }) {
  const out = msg.direction === 'out';

  const body =
    msg.kind === 'file' ? (
      <FileContent
        msg={msg}
        previewUrl={previewUrl}
        previewFallback={previewFallback}
        progress={progress}
        onOpen={onOpen}
        onReveal={onReveal}
      />
    ) : (
      <div className="text">{msg.text}</div>
    );

  // A text message still waiting for the peer to come back online.
  const queued = out && msg.kind !== 'file' && msg.pending;

  return (
    <div className={`bubble-row ${out ? 'out' : 'in'} ${grouped ? 'grouped' : ''}`}>
      <div className={`bubble ${queued ? 'queued' : ''}`}>
        {body}
        <div className="time">
          {formatTime(msg.ts)}
          {queued && (
            <span className="queued-mark" title="Waiting for them to come online">
              · queued
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function FileContent({ msg, previewUrl, previewFallback, progress, onOpen, onReveal }) {
  // Windows only: a thumbnail that cannot be fetched used to leave the browser's
  // broken-image glyph sitting in the bubble — the one thing on screen that says
  // nothing and does nothing. The file is still there and still openable, so the
  // bubble falls back to the row that says so. Left off elsewhere, the bubble
  // renders exactly as it always has.
  const [previewFailed, setPreviewFailed] = useState(false);
  const f = msg.file || {};
  const url = previewUrl ? previewUrl(f.path) : null;
  const media = url && !(previewFallback && previewFailed);
  const pct = progress != null ? Math.round(progress * 100) : null;
  const fail = previewFallback ? () => setPreviewFailed(true) : undefined;

  if (media && isImage(f.mime)) {
    return (
      <div className="file-bubble">
        <div className="file-media">
          <img src={url} alt={f.name} onClick={() => onOpen(f.path)} onError={fail} loading="lazy" />
        </div>
        <FileMeta f={f} onReveal={onReveal} />
        {pct != null && pct < 100 && <Progress pct={pct} />}
      </div>
    );
  }
  // Any audio file gets an inline player, which makes a voice message just an
  // ordinary audio transfer rather than a separate message kind on the wire.
  if (media && isAudio(f.mime)) {
    return (
      <div className="file-bubble">
        <audio className="audio-player" src={url} controls preload="metadata" onError={fail} />
        <FileMeta f={f} onReveal={onReveal} />
        {pct != null && pct < 100 && <Progress pct={pct} />}
      </div>
    );
  }
  if (media && isVideo(f.mime)) {
    return (
      <div className="file-bubble">
        <div className="file-media">
          <video src={url} controls preload="metadata" onError={fail} />
        </div>
        <FileMeta f={f} onReveal={onReveal} />
        {pct != null && pct < 100 && <Progress pct={pct} />}
      </div>
    );
  }
  return (
    <div className="file-bubble">
      <div className="file-row" onClick={() => onOpen(f.path)} title="Open file">
        <span className="file-ic">
          <FileIcon size={20} />
        </span>
        <div className="file-info">
          <div className="fn">{f.name}</div>
          <div className="fs">
            {formatBytes(f.size)}
            {previewFallback && previewFailed && ' · preview unavailable'}
          </div>
        </div>
        <button className="icon-btn" onClick={(e) => (e.stopPropagation(), onReveal(f.path))} title="Show in folder">
          <Download size={18} />
        </button>
      </div>
      {pct != null && pct < 100 && <Progress pct={pct} />}
    </div>
  );
}

function FileMeta({ f, onReveal }) {
  return (
    <div className="file-row">
      <div className="file-info" style={{ flex: 1 }}>
        <div className="fn">{f.name}</div>
        <div className="fs">{formatBytes(f.size)}</div>
      </div>
      <button className="icon-btn" onClick={() => onReveal(f.path)} title="Show in folder">
        <Download size={18} />
      </button>
    </div>
  );
}

function Progress({ pct }) {
  return (
    <div className="progress">
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}
