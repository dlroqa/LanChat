import React, { useMemo, useState } from 'react';
import { formatTime, formatBytes, isImage, isVideo, isAudio } from '../lib/util.js';
import { FileIcon, Download } from '../lib/icons.jsx';
import { linkify } from '../lib/linkify.js';
import LinkPreview from './LinkPreview.jsx';

// previewUrl builds a localhost URL the main-process server streams the file from.
export default function MessageBubble({
  msg,
  grouped,
  previewUrl,
  previewFallback,
  progress,
  onOpen,
  onReveal,
  // Links in message text: opened in the real browser, and unfurled into a card
  // when the user has previews on (`linkPreview` is undefined when they don't).
  onOpenLink,
  linkPreview,
  onPreviewShown,
}) {
  const out = msg.direction === 'out';

  const runs = useMemo(() => (msg.kind === 'file' ? [] : linkify(msg.text)), [msg.kind, msg.text]);
  // The first link only: a message with several should not become a wall of cards.
  const firstLink = runs.find((r) => r.type === 'link');

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
      <MessageText runs={runs} onOpenLink={onOpenLink} />
    );

  // A text message still waiting for the peer to come back online.
  const queued = out && msg.kind !== 'file' && msg.pending;
  // Refused because a question of ours is already waiting to be read. It exists
  // only in this window and only for a moment — long enough to be seen going.
  const rejected = out && msg.rejected === true;

  return (
    <div className={`bubble-row ${out ? 'out' : 'in'} ${grouped ? 'grouped' : ''}`}>
      <div className={`bubble ${queued ? 'queued' : ''} ${rejected ? 'rejected' : ''}`}>
        {body}
        {firstLink && linkPreview && (
          <LinkPreview
            url={firstLink.href}
            out={out}
            fetchPreview={linkPreview}
            onOpen={onOpenLink}
            onShown={onPreviewShown}
          />
        )}
        <div className="time">
          {formatTime(msg.ts)}
          {queued && (
            <span className="queued-mark" title="Waiting for them to come online">
              · queued
            </span>
          )}
          {rejected && (
            <span className="rejected-mark" title="Not sent — your first question is still waiting to be read">
              · not your turn
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// Message text, with the links in it made clickable. The runs come from
// linkify(), which only ever reports plain text and http(s) URLs — the anchors
// are built here, so nothing a peer writes can turn into markup.
function MessageText({ runs, onOpenLink }) {
  return (
    <div className="text">
      {runs.map((run, i) =>
        run.type === 'link' ? (
          <a
            key={i}
            className="msg-link"
            href={run.href}
            title={run.href}
            onClick={(e) => openLink(e, run.href, onOpenLink)}
            // Middle click means "open in a new tab" everywhere else; here it is
            // the same thing as a click, and never a new window inside the app.
            onAuxClick={(e) => e.button === 1 && openLink(e, run.href, onOpenLink)}
          >
            {run.text}
          </a>
        ) : (
          <React.Fragment key={i}>{run.text}</React.Fragment>
        )
      )}
    </div>
  );
}

// The window itself never navigates: the URL is handed to the main process,
// which opens it in the real browser.
function openLink(e, href, onOpenLink) {
  e.preventDefault();
  e.stopPropagation();
  if (onOpenLink) onOpenLink(href);
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
