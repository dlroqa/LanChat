import React, { useEffect, useRef, useState } from 'react';

// The name of a session, edited where it is read.
//
// A session is named after whatever it turned out to be about, which is rarely
// known when it is started — so the title is a button that becomes an input in
// place, rather than a field in a dialog somewhere else. Enter and blur commit,
// Escape puts back what was there, and an empty title falls back to the default
// rather than leaving a row with nothing to click on.

export default function SessionTitle({ title, onRename }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const input = useRef(null);
  // Guards the blur that follows Escape: the input is on its way out either
  // way, and without this the revert would be committed by the blur behind it.
  const cancelled = useRef(false);

  // A rename from anywhere else — an import naming an unnamed session — has to
  // reach the read state, but must not overwrite what somebody is typing.
  useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);

  useEffect(() => {
    if (editing && input.current) input.current.select();
  }, [editing]);

  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      setEditing(false);
      return;
    }
    setEditing(false);
    const next = draft.trim();
    if (next && next !== title) onRename(next);
    else setDraft(title);
  };

  if (!editing) {
    return (
      <button className="session-title" onClick={() => setEditing(true)} title="Rename this session">
        <span className="name-text">{title}</span>
      </button>
    );
  }

  return (
    <input
      ref={input}
      className="session-title-input"
      value={draft}
      aria-label="Session name"
      maxLength={80}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancelled.current = true;
          setDraft(title);
          setEditing(false);
        }
      }}
      autoFocus
    />
  );
}
