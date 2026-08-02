import React, { useEffect, useRef, useState } from 'react';
import { formatBytes, isImage, isVideo, isAudio } from '../lib/util.js';
import { FileIcon, Download } from '../lib/icons.jsx';
import { Marked } from './Marked.jsx';

// The things in a message that are not words.
//
// There are two of them and they arrive by completely different roads. One is a
// file on this machine — sent by a peer, received from one, or made by an agent
// that named it — and it is drawn from the local preview endpoint, which will
// only serve a path main has explicitly allowed. The other is a picture some
// message linked to on the web, which main fetches and hands over as bytes,
// because the window never connects anywhere itself.
//
// They are drawn by the same component on purpose. A photo an agent made and a
// photo a friend sent are the same thing to the person looking at it, and the
// moment they are two components they start to drift apart.

// One file, drawn as whatever it is. `url` is where its bytes can be read from —
// the local preview endpoint for a file on disk, a data URL for one main
// fetched. Without one there is nothing to draw and the row is all there is.
export function MediaItem({ file, url, previewFallback, onOpen, onReveal, hit, current, children }) {
  // Windows only: a thumbnail that cannot be fetched used to leave the browser's
  // broken-image glyph sitting in the bubble — the one thing on screen that says
  // nothing and does nothing. The file is still there and still openable, so the
  // bubble falls back to the row that says so. Left off elsewhere, the bubble
  // renders exactly as it always has.
  const [failed, setFailed] = useState(false);
  const f = file || {};
  const media = url && !(previewFallback && failed);
  const fail = previewFallback ? () => setFailed(true) : undefined;
  const meta = <FileMeta f={f} onReveal={onReveal} hit={hit} current={current} />;

  if (media && isImage(f.mime)) {
    return (
      <div className="file-bubble">
        <div className="file-media">
          {/* A real button rather than a click handler on the picture: opening a
              photo is an action, and one that can only be reached with a mouse
              is one a keyboard cannot reach at all. */}
          <button className="file-media-open" onClick={() => onOpen(f.path)} aria-label={`Open ${f.name}`}>
            <img src={url} alt={f.name} onError={fail} loading="lazy" draggable="false" />
          </button>
        </div>
        {meta}
        {children}
      </div>
    );
  }
  // Any audio file gets an inline player, which makes a voice message just an
  // ordinary audio transfer rather than a separate message kind on the wire.
  if (media && isAudio(f.mime)) {
    return (
      <div className="file-bubble">
        <audio className="audio-player" src={url} controls preload="metadata" onError={fail} />
        {meta}
        {children}
      </div>
    );
  }
  if (media && isVideo(f.mime)) {
    return (
      <div className="file-bubble">
        <div className="file-media">
          <video src={url} controls preload="metadata" onError={fail} />
        </div>
        {meta}
        {children}
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
          <div className="fn">
            <Marked text={f.name} hit={hit} current={current} />
          </div>
          <div className="fs">
            {formatBytes(f.size)}
            {previewFallback && failed && ' · preview unavailable'}
          </div>
        </div>
        <RevealButton name={f.name} onClick={() => onReveal(f.path)} />
      </div>
      {children}
    </div>
  );
}

function FileMeta({ f, onReveal, hit, current }) {
  return (
    <div className="file-row">
      <div className="file-info" style={{ flex: 1 }}>
        <div className="fn">
          <Marked text={f.name} hit={hit} current={current} />
        </div>
        <div className="fs">{formatBytes(f.size)}</div>
      </div>
      <RevealButton name={f.name} onClick={() => onReveal(f.path)} />
    </div>
  );
}

// The button beside a file. Icon-only, so it says in words what it is for: a
// title is a hover affordance and a screen reader is not hovering.
function RevealButton({ name, onClick }) {
  const label = name ? `Show ${name} in folder` : 'Show in folder';
  return (
    <button
      className="icon-btn"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title="Show in folder"
      aria-label={label}
    >
      <Download size={18} />
    </button>
  );
}

export function Progress({ pct }) {
  return (
    <div className="progress">
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

// The pictures a message named, under the words that named them.
//
// `media` is written by main and only by main — an agent naming what it made, or
// the person at the keyboard naming something of their own. Nothing off the wire
// ever carries it, which is what makes it safe for the path to be handed
// straight to the OS when one is opened.
export function MediaAttachments({ media, previewUrl, previewFallback, onOpen, onReveal }) {
  if (!media || media.length === 0) return null;
  return (
    <div className="bubble-media">
      {media.map((f) => (
        <MediaItem
          key={f.path}
          file={f}
          url={previewUrl ? previewUrl(f.path) : null}
          previewFallback={previewFallback}
          onOpen={onOpen}
          onReveal={onReveal}
        />
      ))}
    </div>
  );
}

// Module-level, like the link cards: survives unmounting, so scrolling a picture
// out of view and back does not fetch it again, and every bubble holding the
// same link shares one answer.
const cache = new Map();
const inflight = new Map();

function load(url, fetchImage) {
  if (cache.has(url)) return Promise.resolve(cache.get(url));
  if (inflight.has(url)) return inflight.get(url);
  const run = Promise.resolve()
    .then(() => fetchImage(url))
    .catch(() => null)
    .then((res) => {
      const value = res && res.ok ? res : { ok: false };
      cache.set(url, value);
      inflight.delete(url);
      return value;
    });
  inflight.set(url, run);
  return run;
}

// A picture a message linked to, drawn in the bubble.
//
// Nothing is asked for until the bubble is on screen, and nothing takes up any
// room until there is a picture to put in it — the same two rules the link cards
// follow, for the same reasons. A link that turns out not to be a picture, or is
// too big to fetch, simply stays the link it already was.
function RemoteImage({ url, fetchImage, onSave, onReveal, onShown }) {
  const anchor = useRef(null);
  const [data, setData] = useState(() => cache.get(url) || null);
  // Where it went, once it has been saved. Held per bubble rather than in the
  // module cache: saving is something this reader did, not a fact about the URL.
  const [saved, setSaved] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const known = cache.get(url);
    if (known) {
      setData(known);
      return undefined;
    }
    setData(null);
    const el = anchor.current;
    if (!el || !fetchImage) return undefined;

    let alive = true;
    const start = () => {
      load(url, fetchImage).then((value) => alive && setData(value));
    };

    if (typeof IntersectionObserver !== 'function') {
      start();
      return () => {
        alive = false;
      };
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          start();
        }
      },
      { rootMargin: '200px' }
    );
    io.observe(el);
    return () => {
      alive = false;
      io.disconnect();
    };
  }, [url, fetchImage]);

  const ready = Boolean(data && data.ok && data.image);
  // A picture growing into the thread pushes the newest message up, so the chat
  // is told to hold the bottom if that is where the reader was.
  useEffect(() => {
    if (ready && onShown) onShown();
  }, [ready, onShown]);

  if (!ready) return <span ref={anchor} className="link-card-anchor" aria-hidden="true" />;

  const name = nameFromUrl(url);
  const save = async () => {
    if (saving || saved) return;
    setSaving(true);
    const res = await onSave(url);
    setSaving(false);
    if (res && res.ok) setSaved(res);
  };

  return (
    <div className="file-bubble" ref={anchor}>
      <div className="file-media">
        <img src={data.image} alt={name} draggable="false" />
      </div>
      <div className="file-row">
        <div className="file-info" style={{ flex: 1 }}>
          <div className="fn">{saved ? saved.name : name}</div>
          <div className="fs">{saved ? `${formatBytes(saved.size)} · saved` : 'from the web'}</div>
        </div>
        {saved ? (
          <RevealButton name={saved.name} onClick={() => onReveal(saved.path)} />
        ) : (
          <button
            className="icon-btn"
            onClick={save}
            disabled={saving}
            title={saving ? 'Saving…' : 'Save to downloads'}
            aria-label={saving ? `Saving ${name}` : `Save ${name} to downloads`}
          >
            <Download size={18} />
          </button>
        )}
      </div>
    </div>
  );
}

// What to call a picture before it has been saved anywhere. The last part of the
// path where there is one, so it reads as the thing it is rather than as the
// whole URL; the host otherwise, which is at least true.
function nameFromUrl(url) {
  try {
    const u = new URL(url);
    const base = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    return base || u.hostname;
  } catch {
    return url;
  }
}

export function RemoteImages({ urls, fetchImage, onSave, onReveal, onShown }) {
  if (!urls || urls.length === 0 || !fetchImage) return null;
  return (
    <div className="bubble-media">
      {urls.map((url) => (
        <RemoteImage
          key={url}
          url={url}
          fetchImage={fetchImage}
          onSave={onSave}
          onReveal={onReveal}
          onShown={onShown}
        />
      ))}
    </div>
  );
}
