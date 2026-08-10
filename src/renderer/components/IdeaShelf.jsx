import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from '../lib/icons.jsx';

// What the observers noticed, where it costs nothing to ignore.
//
// The shelf is the whole reason an observer can be left switched on. An idea
// that arrives as a message demands to be read: it lands in the transcript, it
// makes an unread mark, it pushes the conversation up, and it is there for ever
// afterwards whether or not it was any good. An idea that arrives as a card on a
// shelf does none of that — it sits beside the title until somebody looks at it,
// and it goes away when they decide it is not worth having.
//
// So this is deliberately not a message list and deliberately not a
// notification. It is a row of small, quiet buttons under the session title,
// each of which opens into what it actually says.
//
// ---- what it must never do ----
//
// **No unread pressure.** Nothing here counts, badges, pulses or animates on
// arrival. A card appearing is the least urgent thing that happens in this
// window, and anything that made it feel otherwise would turn the feature into
// the interruption it exists to avoid.
//
// **No meaning in colour alone.** Every card carries its category in words. The
// tint is a second, redundant signal — see the note on `tone` below — because a
// person who cannot tell amber from blue must lose nothing at all.

// What kind of thing a card is, as a word and as a tint.
//
// The word is the label and is never omitted; the tint only ever agrees with the
// word it sits next to. Kept here as a table rather than derived from the
// category string, so a new candidate type is one edit and cannot accidentally
// arrive with no styling at all.
const TONE = {
  'Conflicts with a constraint': 'hard',
  Contradiction: 'hard',
  'Missing prerequisite': 'warn',
  'Possible risk': 'warn',
  'Alternative available': 'idea',
  'Synthesis available': 'idea',
  'Test worth running': 'idea',
  'Unanswered question': 'idea',
};

// How long ago, in the shortest form that is still true.
//
// A card's age matters because a suggestion about a conversation that has moved
// on is worth less than one about the sentence just typed, and the person
// deciding whether to open it should be able to see which they have.
function ago(at, now) {
  const secs = Math.max(0, Math.round((now - at) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

export default function IdeaShelf({ cards = [], onDismiss, onAsk }) {
  const [openId, setOpenId] = useState(null);
  const box = useRef(null);
  // Ticks once a minute so the ages stay honest without re-rendering the row on
  // every frame. Started only while there is something on the shelf — a timer
  // running against an empty row is a wakeup a minute for nothing.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (cards.length === 0) return undefined;
    const t = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(t);
  }, [cards.length]);

  useEffect(() => {
    if (!openId) return undefined;
    // Guarded because this component is rendered without a browser: the shelf is
    // asserted by mounting it for real in test/ideaShelf.test.js, where effects
    // run but there is no document to listen on. A component that can only exist
    // inside a window is a component whose behaviour can only be checked from a
    // screenshot.
    if (typeof document === 'undefined') return undefined;
    const away = (e) => {
      if (!box.current || !box.current.contains(e.target)) setOpenId(null);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [openId]);

  // A card that was dismissed while open must not leave the popover pointing at
  // nothing. Closed here rather than guarded at every read below.
  useEffect(() => {
    if (openId && !cards.some((c) => c.id === openId)) setOpenId(null);
  }, [cards, openId]);

  if (cards.length === 0) return null;
  const open = cards.find((c) => c.id === openId) || null;

  return (
    <div className="idea-shelf" ref={box}>
      {/* A group rather than a list of loose buttons, so a screen reader
          announces that these belong together and how many there are before
          reading them out one by one. */}
      <span
        role="group"
        className="idea-shelf-row"
        aria-label={`${cards.length} ${cards.length === 1 ? 'idea' : 'ideas'} from the observers`}
      >
        {cards.map((card) => (
          <button
            key={card.id}
            type="button"
            className={`idea-card ${TONE[card.category] || 'idea'} ${openId === card.id ? 'open' : ''}`}
            aria-expanded={openId === card.id}
            // The whole card in one sentence, for somebody who is hearing it
            // rather than seeing it: what kind of thing it is, who noticed it,
            // and how long it has been waiting.
            aria-label={`${card.label}, ${ago(card.createdAt, now)}. ${card.claim}`}
            onClick={() => setOpenId(openId === card.id ? null : card.id)}
          >
            <span className="idea-card-what">{card.category}</span>
            <ChevronDown size={11} />
          </button>
        ))}
      </span>

      {open && (
        <div className="idea-pop" role="dialog" aria-label={open.label}>
          <div className="idea-pop-head">
            <span className="idea-pop-what">{open.label}</span>
            <span className="idea-pop-age">{ago(open.createdAt, now)}</span>
          </div>
          <p className="idea-pop-claim">{open.claim}</p>
          {/* What it is grounded in. Shown as a count rather than as links,
              because the messages it points at are already on screen above —
              the useful fact here is that it points at anything at all, which
              is what separates a claim about this conversation from a claim
              about conversations in general. */}
          <p className="idea-pop-from">
            from {open.evidence.length} {open.evidence.length === 1 ? 'message' : 'messages'} in this
            conversation
          </p>
          <div className="idea-pop-acts">
            <button type="button" className="idea-act" onClick={() => onAsk && onAsk(open)}>
              <Check size={12} />
              Ask about it
            </button>
            <button
              type="button"
              className="idea-act quiet"
              onClick={() => {
                setOpenId(null);
                if (onDismiss) onDismiss(open);
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
