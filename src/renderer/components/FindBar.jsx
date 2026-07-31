import React from 'react';
import { Search, ChevronUp, ChevronDown, X } from '../lib/icons.jsx';

// The find bar: a word, how many times the conversation says it, and the two
// arrows that walk them. It floats over the top of the messages rather than
// pushing them down, so the thread stays where the reader left it.
//
// It owns nothing. The query, which hit is current, and whether it is open at
// all live in ChatPane — this only says what those look like and which key does
// what.
export default function FindBar({ query, count, index, onQuery, onNext, onPrev, onClose, inputRef }) {
  const searching = query.trim().length > 0;
  const label = !searching ? '' : count === 0 ? 'no matches' : `${index + 1}/${count}`;

  function onKeyDown(e) {
    // Escape is handled here rather than on the window: a dialog opened on top
    // of the conversation listens there, and one press should close one thing.
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (count > 0) (e.shiftKey ? onPrev : onNext)();
    }
  }

  return (
    <div className="find-bar" role="search" onKeyDown={onKeyDown}>
      <span className="find-ic" aria-hidden="true">
        <Search size={16} />
      </span>
      <input
        ref={inputRef}
        className="find-input"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Find in this conversation"
        aria-label="Find in this conversation"
        autoComplete="off"
        spellCheck="false"
      />
      {/* Said out loud as well as shown: somebody using a screen reader is
          typing into a box whose whole answer is this number. Polite, so it
          waits its turn rather than cutting into the keystroke being read. */}
      <span className="find-count" role="status" aria-live="polite">
        {label}
      </span>
      {/* Up is back through the conversation, down is forward — the direction
          the eye moves, not the direction of the list index. */}
      <button
        className="icon-btn find-step"
        onClick={onPrev}
        disabled={count === 0}
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
      >
        <ChevronUp size={17} />
      </button>
      <button
        className="icon-btn find-step"
        onClick={onNext}
        disabled={count === 0}
        title="Next match (Enter)"
        aria-label="Next match"
      >
        <ChevronDown size={17} />
      </button>
      <button
        className="icon-btn find-step"
        onClick={onClose}
        title="Close find (Esc)"
        aria-label="Close find"
      >
        <X size={17} />
      </button>
    </div>
  );
}
