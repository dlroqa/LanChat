import React, { useMemo } from 'react';
import { formatTime, formatBytes } from '../lib/util.js';
import { FileIcon, Fork, Restore, Speaker, Pause } from '../lib/icons.jsx';
import { linkify, isImageUrl } from '../lib/linkify.js';
import { fieldHits } from '../lib/findInThread.js';
import { useCountdown } from '../lib/useCountdown.js';
import LinkPreview from './LinkPreview.jsx';
import { Hit, Marked, markRuns } from './Marked.jsx';
import { MediaItem, MediaAttachments, RemoteImages, Progress } from './MessageMedia.jsx';

// How long an error is given before it erases itself. The timer that actually
// removes it lives in App.jsx; this is the same number, for the sentence that
// says so. They are two views of one fact rather than two facts.
const ERROR_TTL_S = 10;

// previewUrl builds a localhost URL the main-process server streams the file from.
export default function MessageBubble({
  msg,
  // Which agent said it, as a colour. Null everywhere but a session, and null in
  // a session for anything a person wrote — the colour is how one agent's
  // answers are told from another's, and there is nothing to tell apart in a
  // thread with one voice in it. Handed down rather than worked out here: the
  // colours are decided for the conversation as a whole, because being distinct
  // is a property of the room and not of any one message in it.
  color = null,
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
  // A link that is itself a picture: fetched in main and handed back as bytes,
  // and saved into the downloads folder when the button is pressed. Both are
  // undefined where previews are off, which is what keeps a bubble from asking.
  previewImage,
  onSaveImage,
  // Carrying this bubble into a question. Given only where there is something
  // that can answer one — a session, or an agent thread a session can be
  // started from — so a chat with a person never grows the affordance.
  onFork,
  // Putting a question that failed back into the composer, with whatever it was
  // asking about. Offered on the same threads as onFork.
  onResend,
  // Reading the session aloud from this turn. Passed only by a session with a
  // voice switched on, so every other thread renders exactly as it always has.
  onSpeak,
  // This bubble's share of the player's cursor: 'playing' while it is the turn
  // being read, 'paused' while it is the one stopped on, and undefined for every
  // other bubble.
  speakState,
  // What the find bar is looking for: `{ query, base, current }`, where `base`
  // is the ordinal this bubble's first hit was given and `current` is the one
  // being pointed at. Undefined whenever nothing is being searched, which is
  // nearly always — the bubble then renders exactly as it always has.
  find,
}) {
  const out = msg.direction === 'out';

  // `msg.media` is what lets a markdown link naming a file become something that
  // can be opened: the scanner matches a target against this list rather than
  // working a path out of the text, so the only paths it can ever produce are
  // ones main already checked. See mediaPath() in lib/linkify.js.
  const runs = useMemo(
    () => (msg.kind === 'file' ? [] : linkify(msg.text, msg.media)),
    [msg.kind, msg.text, msg.media]
  );
  // Where the search word occurs in each part of this bubble, numbered from
  // `base`. Worked out here rather than passed in, so a new message arriving
  // does not re-slice every bubble above it.
  const hits = useMemo(
    () => (find?.query ? fieldHits(msg, find.query, find.base) : null),
    [msg, find?.query, find?.base]
  );
  const current = find?.current;
  // The first link only: a message with several should not become a wall of cards.
  // A link that is a picture is not one of them — it is drawn below as the
  // picture it is, and a card underneath saying the same thing again is noise.
  const firstLink = runs.find((r) => r.type === 'link' && !isImageUrl(r.href));
  // Every distinct picture the message linked to, in the order it named them.
  const imageLinks = useMemo(() => {
    const seen = [];
    for (const run of runs) {
      if (run.type === 'link' && isImageUrl(run.href) && !seen.includes(run.href)) seen.push(run.href);
    }
    return seen;
  }, [runs]);

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
      <MessageText
        runs={runs}
        onOpenLink={onOpenLink}
        onOpen={onOpen}
        hit={hits?.get('text')}
        current={current}
      />
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
  // Not while it is going. A question being retired is one whose replacement has
  // already been answered, and a button offering to put it back in the composer
  // is offering to ask it a third time on the way out the door.
  const resendable = failed && !dissolving && Boolean(onResend) && Boolean(msg.text);
  // Anything with words in it, in a thread that has a voice. Your own questions
  // included: the read-through covers the whole conversation, so a button that
  // appeared on one side of it and not the other would be a button that could
  // not start the reading from where you were looking. Not on a bubble that is
  // leaving, and not on a notice: neither is anybody's words.
  const speakable = Boolean(onSpeak) && Boolean(msg.text) && !msg.notice && !going && msg.kind !== 'file';
  // Whether this bubble is the one talking. `speakState` is the player's cursor
  // narrowed to this message by the pane, so exactly one bubble can be lit.
  const speaking = speakState === 'playing';
  const speakTitle =
    speakState === 'playing' ? 'Pause' : speakState === 'paused' ? 'Continue from here' : 'Read from here';

  // Counted here rather than passed in, so the sentence and the bubble it sits
  // under read the same clock. Stops at the moment the bubble starts to go —
  // "in 0s" under something already coming apart is a promise about the past.
  const left = useCountdown(ERROR_TTL_S, going && !dissolving);

  return (
    <div
      className={`bubble-row ${out ? 'out' : 'in'} ${grouped ? 'grouped' : ''} ${
        going ? 'erasing' : ''
      } ${dissolving ? 'dissolving' : ''} ${color && !out ? 'agent' : ''}`}
      // The handle the pane scrolls to as the reading advances. Every bubble
      // carries its own id; the pane queries for the one the cursor is on, the
      // same way search hits are found by data-hit.
      data-speaking-id={msg.id}
      // The one place the colour is named. Everything that uses it — the fill,
      // the edge, the speaker's name — reads it back out of this variable, so an
      // agent's colour reaches all three from a single source and a bubble with
      // no agent behind it keeps the ordinary surface.
      style={color && !out ? { '--agent-color': color } : undefined}
    >
      <div
        className={`bubble ${queued ? 'queued' : ''} ${rejected ? 'rejected' : ''} ${
          errored ? 'errored' : ''
        } ${leftover ? 'leftover' : ''} ${failed ? 'failed' : ''}`}
      >
        {/* Who said it. Only where the thread does not already answer that: a
            session can put one question to several agents, and three answers in
            a row with nothing to tell them apart are three opinions from nobody.
            Written by main onto the message — see reply() in agents/index.js —
            which is also where an imported transcript's speakers have always
            come from, so a line loaded from a file and a line answered just now
            are labelled by the same rule.

            Not on grouped bubbles: a group is one speaker's run of messages, and
            repeating the name down the side of it is noise. ChatPane only groups
            bubbles that agree on this field, so a group can never be two
            agents. */}
        {!out && !grouped && msg.speaker && <div className="bubble-speaker">{msg.speaker}</div>}
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
        {/* The pictures this message is talking about: ones on this machine that
            main named and checked, then ones it linked to on the web. Under the
            words rather than instead of them — the message said something, and
            the picture is what it said it about. */}
        <MediaAttachments
          media={msg.media}
          previewUrl={previewUrl}
          previewFallback={previewFallback}
          onOpen={onOpen}
          onReveal={onReveal}
        />
        <RemoteImages
          urls={imageLinks}
          fetchImage={previewImage}
          onOpen={onOpenLink}
          onSave={onSaveImage}
          onReveal={onReveal}
          onShown={onPreviewShown}
        />
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
            <span
              className="rejected-mark"
              title="Not sent — your first question is still waiting to be read"
            >
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
      {/* Hearing a turn. One button doing both jobs, because starting and
          stopping the same sentence is one decision — a separate stop button is
          dead weight on every bubble that is not talking, and two buttons where
          one is always wrong is how a control gets misread.

          It is absent unless the pane passes a handler, which it only does in a
          session with reading aloud switched on.

          Pressing it reads *on* from here rather than stopping at the end of
          this turn: it moves the same cursor the transport in the Activity Panel
          moves, so the two controls always agree about what is speaking. Cheap
          on a second press — main keeps what it synthesised, keyed on the voice
          and the text, so a replay costs nothing and is not billed twice. */}
      {speakable && (
        <button
          className={`bubble-speak ${speaking ? 'on' : ''}`}
          onClick={() => onSpeak(msg)}
          title={speakTitle}
          aria-label={speakTitle}
          aria-pressed={speaking}
        >
          {speaking ? <Pause size={15} /> : <Speaker size={15} />}
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
// linkify(), which reports plain text, http(s) URLs, files main vouched for, and
// the markdown punctuation around them — every element here is built from those,
// so nothing a peer writes can turn into markup. A search cuts the same runs
// again at the edges of what it found; a word that begins in a sentence and ends
// inside a link therefore comes back as two pieces carrying one ordinal, and the
// second is an anchor to the same place as the first.
function MessageText({ runs, onOpenLink, onOpen, hit, current }) {
  const pieces = markRuns(runs, hit);
  return (
    <div className="text">
      {pieces.map((run, i) => {
        const body = run.hit == null ? run.text : <Hit run={run} current={current} />;
        if (run.type === 'link') {
          return (
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
              {body}
            </a>
          );
        }
        // A file on this machine. The path came off `msg.media`, which only main
        // writes, so this is the same click as opening a file bubble.
        if (run.type === 'file') {
          return (
            <a
              key={i}
              className="msg-link"
              href="#"
              title={run.path}
              onClick={(e) => openFile(e, run.path, onOpen)}
              onAuxClick={(e) => e.button === 1 && openFile(e, run.path, onOpen)}
            >
              {body}
            </a>
          );
        }
        // The brackets and target of a markdown link. Kept in the run list so
        // the message still adds up to exactly what was said — that is what the
        // search numbering is built on — but not drawn, because it is
        // punctuation rather than words and the label beside it is what it was
        // punctuating. The exception is the one case where not drawing it would
        // break something: a search hit inside the target still has an ordinal,
        // and an ordinal on nothing is an arrow that scrolls nowhere.
        if (run.type === 'syntax') {
          return run.hit == null ? null : (
            <span key={i} className="md-syntax">
              {body}
            </span>
          );
        }
        if (run.hit == null) return <React.Fragment key={i}>{run.text}</React.Fragment>;
        return <Hit key={i} run={run} current={current} />;
      })}
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

function openFile(e, path, onOpen) {
  e.preventDefault();
  e.stopPropagation();
  if (onOpen) onOpen(path);
}

// A file bubble: a message that *is* a file rather than one that mentions one.
// The drawing of it lives in MessageMedia.jsx, shared with the pictures a
// message named — a photo a friend sent and a photo an agent made are the same
// thing to whoever is looking at them, and two components would drift apart.
// What is left here is the one thing only a transfer has: how far along it is.
function FileContent({ msg, previewUrl, previewFallback, progress, onOpen, onReveal, hit, current }) {
  const f = msg.file || {};
  const pct = progress != null ? Math.round(progress * 100) : null;
  return (
    <MediaItem
      file={f}
      url={previewUrl ? previewUrl(f.path) : null}
      previewFallback={previewFallback}
      onOpen={onOpen}
      onReveal={onReveal}
      hit={hit}
      current={current}
    >
      {pct != null && pct < 100 && <Progress pct={pct} />}
    </MediaItem>
  );
}
