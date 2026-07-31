import React, { useMemo, useState } from 'react';
import { formatTime, formatBytes, isImage, isVideo, isAudio } from '../lib/util.js';
import { FileIcon, Download, Fork, Restore } from '../lib/icons.jsx';
import { linkify } from '../lib/linkify.js';
import { fieldHits, sliceRuns } from '../lib/findInThread.js';
import { useCountdown } from '../lib/useCountdown.js';
import LinkPreview from './LinkPreview.jsx';

// How long an error is given before it erases itself. The timer that actually
// removes it lives in App.jsx; this is the same number, for the sentence that
// says so. They are two views of one fact rather than two facts.
const ERROR_TTL_S = 10;

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
  // Carrying this bubble into a question. Given only where there is something
  // that can answer one — a session, or an agent thread a session can be
  // started from — so a chat with a person never grows the affordance.
  onFork,
  // Putting a question that failed back into the composer, with whatever it was
  // asking about. Offered on the same threads as onFork.
  onResend,
  // What the find bar is looking for: `{ query, base, current }`, where `base`
  // is the ordinal this bubble's first hit was given and `current` is the one
  // being pointed at. Undefined whenever nothing is being searched, which is
  // nearly always — the bubble then renders exactly as it always has.
  find,
}) {
  const out = msg.direction === 'out';

  const runs = useMemo(() => (msg.kind === 'file' ? [] : linkify(msg.text)), [msg.kind, msg.text]);
  // Where the search word occurs in each part of this bubble, numbered from
  // `base`. Worked out here rather than passed in, so a new message arriving
  // does not re-slice every bubble above it.
  const hits = useMemo(
    () => (find?.query ? fieldHits(msg, find.query, find.base) : null),
    [msg, find?.query, find?.base]
  );
  const current = find?.current;
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
        hit={hits?.get('file')}
        current={current}
      />
    ) : (
      <MessageText runs={runs} onOpenLink={onOpenLink} hit={hits?.get('text')} current={current} />
    );

  // A text message still waiting for the peer to come back online.
  const queued = out && msg.kind !== 'file' && msg.pending;
  // Refused because a question of ours is already waiting to be read. It exists
  // only in this window and only for a moment — long enough to be seen going.
  const rejected = out && msg.rejected === true;
  // A run that failed. Never written down, and on its way out from the moment it
  // arrives: `dissolving` is App.jsx saying the count has reached zero.
  const errored = !out && msg.error === true;
  // A summon line or a greeting an older build left in an agent thread. Written
  // down at the time, so unlike an error this one really is being deleted — but
  // it leaves the same way, and by the same clock.
  const leftover = msg.erasing === true;
  const dissolving = msg.dissolving === true;
  // Either kind of message on its way out. The row layout, the caption slot and
  // the disintegration are shared; only the wording differs.
  const going = errored || leftover;
  // The question that error was the outcome of. Still here to be read and put
  // back, but no longer claiming to have been answered.
  const failed = out && msg.failed === true;

  // Only text can be quoted into a question: a file is a thing on disk, and
  // "here is a photo I once sent" is not a context an agent can read.
  const forkable = Boolean(onFork) && msg.kind !== 'file' && Boolean(msg.text) && !msg.notice && !rejected;
  const resendable = failed && Boolean(onResend) && Boolean(msg.text);

  // Counted here rather than passed in, so the sentence and the bubble it sits
  // under read the same clock. Stops at the moment the bubble starts to go —
  // "in 0s" under something already coming apart is a promise about the past.
  const left = useCountdown(ERROR_TTL_S, going && !dissolving);

  return (
    <div
      className={`bubble-row ${out ? 'out' : 'in'} ${grouped ? 'grouped' : ''} ${
        going ? 'erasing' : ''
      } ${dissolving ? 'dissolving' : ''}`}
    >
      <div
        className={`bubble ${queued ? 'queued' : ''} ${rejected ? 'rejected' : ''} ${
          errored ? 'errored' : ''
        } ${leftover ? 'leftover' : ''} ${failed ? 'failed' : ''}`}
      >
        {/* What this question was asked about. Stored on the message rather than
            folded into its text, so the transcript keeps the question somebody
            typed and shows separately what it was carrying. */}
        {msg.context && (
          <div className="bubble-quote">
            <span className="bubble-quote-mark" aria-hidden="true">
              ❝
            </span>
            <span className="bubble-quote-text">
              {msg.context.speaker ? <b>{msg.context.speaker}: </b> : null}
              <Marked text={msg.context.text} hit={hits?.get('context')} current={current} />
            </span>
          </div>
        )}
        {/* Documents handed to an agent. The bubble names them rather than
            reproducing them: what the agent read was a whole PDF, and a
            transcript that quoted it back would be unreadable. */}
        {msg.docs?.length > 0 && (
          <div className="bubble-docs">
            {msg.docs.map((doc, i) => (
              <span className="bubble-doc" key={`${doc.name}-${i}`}>
                <FileIcon size={13} />
                <Marked text={doc.name} hit={hits?.get(`doc:${i}`)} current={current} />
                <span className="bubble-doc-size">{formatBytes(doc.bytes)}</span>
              </span>
            ))}
          </div>
        )}
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
          {/* Loaded from a file rather than said here. Marked because a session
              is a place where both kinds of message sit together, and one that
              was imported must not be able to pass itself off as something the
              agent just replied. */}
          {msg.imported && (
            <span className="imported-mark" title={msg.source ? `Imported from ${msg.source}` : 'Imported'}>
              · imported
            </span>
          )}
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
          {/* Asked, but nothing came back from it. Said in words as well as in
              the dimming, because a bubble that is merely paler than its
              neighbours is not telling anybody anything. */}
          {failed && (
            <span className="failed-mark" title="The run that was answering this failed — it was not counted">
              · not answered
            </span>
          )}
        </div>
      </div>
      {/* Outside the bubble, beside it. Inside, it would sit on top of the words
          it is offering to carry. Revealed on hover and on focus, so it is
          reachable by keyboard as well as by mouse. */}
      {forkable && (
        <button
          className="bubble-fork"
          onClick={() => onFork(msg)}
          title="Ask about this"
          aria-label="Ask about this"
        >
          <Fork size={15} />
        </button>
      )}
      {/* Beside the question rather than beside the error, because the error is
          leaving and the question is what there is to do something about. */}
      {resendable && (
        <button
          className="bubble-resend"
          onClick={() => onResend(msg)}
          title="Put this question back in the composer"
          aria-label="Put this question back in the composer"
        >
          <Restore size={15} />
        </button>
      )}
      {/* Why the error is about to disappear, counted down in the open. Polite
          rather than assertive: it is worth hearing, but not worth cutting into
          whatever a screen reader is already saying. */}
      {/* One caption for a batch, not one per bubble: four summons leave four
          greetings, and four lines all saying the same thing would be its own
          kind of clutter. `eraseLast` marks the one to carry it. An error is
          always alone, so it always carries its own. */}
      {going && (errored || msg.eraseLast) && (
        <div className="bubble-erase" role="status" aria-live="polite">
          {`Erasing ${errored ? 'error' : 'summon'} to maintain clean context conversation` +
            (dissolving ? '' : ` in ${left}s`)}
        </div>
      )}
    </div>
  );
}

// Message text, with the links in it made clickable. The runs come from
// linkify(), which only ever reports plain text and http(s) URLs — the anchors
// are built here, so nothing a peer writes can turn into markup. A search cuts
// the same runs again at the edges of what it found; a word that begins in a
// sentence and ends inside a link therefore comes back as two pieces carrying
// one ordinal, and the second is an anchor to the same place as the first.
function MessageText({ runs, onOpenLink, hit, current }) {
  const pieces = marked(runs, hit);
  return (
    <div className="text">
      {pieces.map((run, i) =>
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
            {run.hit == null ? run.text : <Hit run={run} current={current} />}
          </a>
        ) : run.hit == null ? (
          <React.Fragment key={i}>{run.text}</React.Fragment>
        ) : (
          <Hit key={i} run={run} current={current} />
        )
      )}
    </div>
  );
}

// The runs of a string, cut at whatever the search found in it. `hit` is
// undefined on every surface the current query does not touch, which is the
// usual case and costs nothing.
function marked(runs, hit) {
  if (!hit || hit.ranges.length === 0) return runs.map((run) => ({ ...run, hit: null }));
  return sliceRuns(runs, hit.ranges, hit.base);
}

// One occurrence, marked where it stands. `data-hit` is its ordinal in the
// thread: it is how the pane finds this one on screen when the arrows walk to
// it, and it is unique because the numbering is handed out once, in order.
function Hit({ run, current }) {
  return (
    <mark className={`find-hit${run.hit === current ? ' current' : ''}`} data-hit={run.hit}>
      {run.text}
    </mark>
  );
}

// The same marking for the strings that are not message text — a quoted
// excerpt, the name of a document, the name of a file.
function Marked({ text, hit, current }) {
  const pieces = marked([{ type: 'text', text }], hit);
  return (
    <>
      {pieces.map((run, i) =>
        run.hit == null ? (
          <React.Fragment key={i}>{run.text}</React.Fragment>
        ) : (
          <Hit key={i} run={run} current={current} />
        )
      )}
    </>
  );
}

// The window itself never navigates: the URL is handed to the main process,
// which opens it in the real browser.
function openLink(e, href, onOpenLink) {
  e.preventDefault();
  e.stopPropagation();
  if (onOpenLink) onOpenLink(href);
}

function FileContent({ msg, previewUrl, previewFallback, progress, onOpen, onReveal, hit, current }) {
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
        <FileMeta f={f} onReveal={onReveal} hit={hit} current={current} />
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
        <FileMeta f={f} onReveal={onReveal} hit={hit} current={current} />
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
        <FileMeta f={f} onReveal={onReveal} hit={hit} current={current} />
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
          <div className="fn">
            <Marked text={f.name} hit={hit} current={current} />
          </div>
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

function FileMeta({ f, onReveal, hit, current }) {
  return (
    <div className="file-row">
      <div className="file-info" style={{ flex: 1 }}>
        <div className="fn">
          <Marked text={f.name} hit={hit} current={current} />
        </div>
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
