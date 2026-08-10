import React, { useEffect, useRef, useState } from 'react';
import { Folder, ChevronDown, Grip, Trash } from '../lib/icons.jsx';

// A folder of sessions in the sidebar.
//
// The Sessions list sorts itself by when each session was last used, which is
// the right answer until there are thirty of them. A folder is the way out: made
// by hand, named, shut when you are not using it, and holding whichever sessions
// were put in it in whatever order they were put.
//
// It borrows the category fold above it rather than inventing one — `.sb-body`
// and `.sb-body-inner` are unscoped rules, so the same `0fr` → `1fr` grid track
// and the same `visibility` toggle apply here, which means a shut folder's rows
// genuinely leave the tab order instead of merely being hidden.
//
// Two differences from a category, both deliberate. A folder opens and shuts on
// a click, because a folder is a thing you open; a category opens on hover and
// is pinned with a lock, because the four of them are furniture. And the name is
// renamed on *double* click, because the single click is already the fold.

export default function SessionFolder({
  id,
  name,
  count,
  open,
  editing,
  onToggle,
  onEditing,
  onRename,
  onDelete,
  onMove,
  dropInto = false,
  dropEdge = null,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  children,
}) {
  const [draft, setDraft] = useState(name);
  const input = useRef(null);
  // Guards the blur that follows Escape: the input is on its way out either way,
  // and without this the revert would be committed by the blur behind it. Same
  // reason SessionTitle keeps one.
  const cancelled = useRef(false);

  // A rename from anywhere else has to reach the read state, but must not
  // overwrite what somebody is typing.
  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  useEffect(() => {
    if (editing && input.current) input.current.select();
  }, [editing]);

  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      onEditing(false);
      return;
    }
    onEditing(false);
    const next = draft.trim();
    if (next && next !== name) onRename(next);
    else setDraft(name);
  };

  // Arrow keys on the grip move the folder, exactly as they move a category.
  // Focus travels with it because the row is keyed by id, so a folder can be
  // walked up a list without touching the pointer.
  const gripKeys = (e) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      onMove(-1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      onMove(1);
    }
  };

  const cls = [
    'sb-folder',
    open ? 'open' : '',
    dropInto ? 'drop-into' : '',
    dropEdge ? `drop-${dropEdge}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls} data-folder={id}>
      <div
        className="folder-head"
        // Not while it is being renamed: a drag started from inside the input
        // would carry the folder off mid-word.
        draggable={!editing}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <button
          type="button"
          className="sb-grip folder-grip"
          onKeyDown={gripKeys}
          title="Drag to reorder, or use the arrow keys"
          aria-label={`Move ${name}`}
        >
          <Grip size={13} />
        </button>
        {/* The fold. A real button, so Enter and Space work and a screen reader
            is told what it does — and it carries the whole head's click, so the
            row opens wherever it is pressed. */}
        <button
          type="button"
          className="folder-twist"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={open ? `Collapse ${name}` : `Expand ${name}`}
        >
          <ChevronDown size={13} />
        </button>
        <span className="folder-mark" aria-hidden="true">
          <Folder size={15} />
        </span>
        {editing ? (
          <input
            ref={input}
            className="folder-name-input"
            value={draft}
            aria-label="Folder name"
            maxLength={60}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelled.current = true;
                setDraft(name);
                onEditing(false);
              }
            }}
            autoFocus
          />
        ) : (
          <button
            type="button"
            className="folder-name"
            onClick={onToggle}
            onDoubleClick={() => onEditing(true)}
            title="Double-click to rename"
          >
            <span className="name-text">{name}</span>
          </button>
        )}
        <span className="folder-count" aria-label={`${count} session${count === 1 ? '' : 's'}`}>
          {count}
        </span>
        {/* The folder goes; what was in it becomes loose again. Nothing is
            deleted but the folder, which is why this asks nothing first. */}
        <button
          type="button"
          className="icon-btn sb-action folder-remove"
          onClick={onDelete}
          title="Delete this folder — the sessions in it stay"
          aria-label={`Delete ${name}`}
        >
          <Trash size={13} />
        </button>
      </div>
      <div className="sb-body">
        <div className="sb-body-inner">{children}</div>
      </div>
    </div>
  );
}
