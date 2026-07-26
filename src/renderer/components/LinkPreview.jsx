import React, { useEffect, useRef, useState } from 'react';

// The card under a message that contains a link.
//
// Two rules shape it. First, a preview costs a page fetch, so one is only asked
// for when the bubble is actually on screen — opening a long conversation must
// not fan out into a request per message — and the answer is shared between every
// bubble that holds the same link. Second, nothing is shown until there is
// something real to show: no skeleton that collapses again, because most of what
// fails to unfurl fails silently, and a card that appears and vanishes is worse
// than one that simply arrives.

// Module-level: survives unmounting, so scrolling a card out of view and back
// does not ask again, and switching threads keeps what was already fetched.
const cache = new Map();
const inflight = new Map();

function load(url, fetchPreview) {
  if (cache.has(url)) return Promise.resolve(cache.get(url));
  if (inflight.has(url)) return inflight.get(url);
  const run = Promise.resolve()
    .then(() => fetchPreview(url))
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

export default function LinkPreview({ url, out, fetchPreview, onOpen, onShown }) {
  const anchor = useRef(null);
  const [data, setData] = useState(() => cache.get(url) || null);

  useEffect(() => {
    const known = cache.get(url);
    if (known) {
      setData(known);
      return undefined;
    }
    setData(null);
    const el = anchor.current;
    if (!el || !fetchPreview) return undefined;

    let alive = true;
    const start = () => {
      load(url, fetchPreview).then((value) => alive && setData(value));
    };

    // Older bubbles are usually scrolled well out of sight; they get a preview
    // when, and if, they are read.
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
  }, [url, fetchPreview]);

  // A card growing into the thread pushes the newest message up, so the chat is
  // told to hold the bottom if that is where the reader was.
  const ready = Boolean(data && data.ok);
  useEffect(() => {
    if (ready && onShown) onShown();
  }, [ready, onShown]);

  // Until then this is a zero-height marker: it exists so the observer has
  // something to watch, and takes up no room in the bubble.
  if (!ready) return <span ref={anchor} className="link-card-anchor" aria-hidden="true" />;

  const open = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (onOpen) onOpen(data.url || url);
  };

  return (
    <a
      ref={anchor}
      className={`link-card ${out ? 'out' : ''}`}
      href={data.url || url}
      title={data.url || url}
      onClick={open}
      onAuxClick={(e) => e.button === 1 && open(e)}
    >
      {data.image && <img className="link-thumb" src={data.image} alt="" draggable="false" />}
      <div className="link-body">
        {data.siteName && <div className="link-site">{data.siteName}</div>}
        {data.title && <div className="link-title">{data.title}</div>}
        {data.description && <div className="link-desc">{data.description}</div>}
      </div>
    </a>
  );
}
