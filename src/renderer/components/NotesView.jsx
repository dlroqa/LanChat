import React, { useRef, useState } from 'react';
import EmptyState from './EmptyState.jsx';
import { Plus, Trash, Restore, X } from '../lib/icons.jsx';
import { formatShortDate } from '../lib/util.js';
import { useAutosave } from '../lib/useAutosave.js';

// Notes, in a column about three hundred pixels wide.
//
// Two faces on one view rather than two panes side by side: a list, and the note
// you have opened. There is no room here for both, and a note being written in a
// third of a column with a list stealing half of it would be worse than either.
//
// The list arrives from main and is never rewritten here. What is held is the
// note being edited — the draft — because a save is debounced and the field has
// to keep up with the keyboard in between. That draft is the thing that must
// never be lost, so every way out of the editor flushes it first: switching
// notes, closing, unmounting, and the panel being pulled away by a call.
//
// Autosave rather than a Save button. A note is not a form, and the one thing a
// panel like this cannot do is lose an afternoon's writing because somebody
// closed it the way they close everything else.

// Long enough that a sentence being typed is one save rather than thirty; short
// enough that a hand leaving the keyboard is followed by a save before it gets
// back. The flushes below are what make this a coalescing window rather than a
// window in which writing can be lost.
const SAVE_IDLE_MS = 500;

export default function NotesView({
  notes = [],
  trash = [],
  onCreate,
  onRead,
  onSave,
  onDelete,
  onRestore,
  onPurge,
}) {
  // Which note is open, and what is in it. `null` is the list.
  const [openId, setOpenId] = useState(null);
  const [draft, setDraft] = useState(null); // { title, body }
  const [showTrash, setShowTrash] = useState(false);

  const openRef = useRef(null);
  openRef.current = openId;

  // `final` is what tells main this is somebody finishing rather than pausing:
  // it flushes the metadata whatever the coalescing window says. The body
  // reaches disk either way — see src/main/notes.js.
  const { queue, flush } = useAutosave(
    (id, patch, final) => onSave(id, { ...patch, ...(final && { final: true }) }),
    SAVE_IDLE_MS
  );

  const edit = (patch) => {
    const id = openRef.current;
    if (!id) return;
    setDraft((d) => {
      const next = { ...d, ...patch };
      queue(id, { title: next.title, body: next.body });
      return next;
    });
  };

  const open = async (id) => {
    flush();
    const note = await onRead(id);
    if (!note) return;
    setOpenId(id);
    setDraft({ title: note.title, body: note.body || '' });
  };

  const close = () => {
    flush();
    setOpenId(null);
    setDraft(null);
  };

  const create = async () => {
    flush();
    const note = await onCreate();
    if (!note) return;
    setOpenId(note.id);
    setDraft({ title: note.title, body: '' });
  };

  const remove = (id) => {
    // Flushed first, then deleted: a save landing after the delete would be a
    // write to a note that is on its way to the Trash, and the record it
    // touched would come back out of it with a timestamp nobody explained.
    flush();
    if (id === openRef.current) {
      setOpenId(null);
      setDraft(null);
    }
    onDelete(id);
  };

  if (openId && draft) {
    return (
      <div className="note-editor">
        <div className="note-editor-head">
          <button
            type="button"
            className="icon-btn"
            onClick={close}
            title="Back to notes"
            aria-label="Back to notes"
          >
            <X size={17} />
          </button>
          <input
            className="note-title"
            value={draft.title}
            onChange={(e) => edit({ title: e.target.value })}
            onBlur={flush}
            placeholder="Untitled note"
            aria-label="Note title"
          />
          <button
            type="button"
            className="icon-btn danger"
            onClick={() => remove(openId)}
            title="Move to Trash"
            aria-label="Move this note to the Trash"
          >
            <Trash size={17} />
          </button>
        </div>
        <textarea
          className="note-body"
          value={draft.body}
          onChange={(e) => edit({ body: e.target.value })}
          onBlur={flush}
          placeholder="Write anything. It stays on this machine."
          aria-label="Note"
        />
      </div>
    );
  }

  const list = showTrash ? trash : notes;

  return (
    <div className="note-list">
      <div className="note-list-head">
        {/* A count rather than a heading: the floor already says Notes, and
            saying it twice in a column this narrow is a line of nothing. */}
        <span className="note-count">
          {showTrash ? `${trash.length} deleted` : `${notes.length} note${notes.length === 1 ? '' : 's'}`}
        </span>
        <button
          type="button"
          className={`icon-btn${showTrash ? ' on' : ''}`}
          onClick={() => setShowTrash((v) => !v)}
          disabled={!showTrash && trash.length === 0}
          title={showTrash ? 'Back to your notes' : 'Deleted notes'}
          aria-label={showTrash ? 'Back to your notes' : 'Deleted notes'}
          aria-pressed={showTrash}
        >
          <Trash size={16} />
        </button>
        {showTrash ? null : (
          <button type="button" className="icon-btn" onClick={create} title="New note" aria-label="New note">
            <Plus size={17} />
          </button>
        )}
      </div>

      {list.length === 0 ? (
        showTrash ? (
          <EmptyState title="Nothing deleted" ring={false}>
            A note you delete waits here until you put it back or delete it for good.
          </EmptyState>
        ) : (
          <EmptyState title="No notes yet">Anything you write here stays on this machine.</EmptyState>
        )
      ) : (
        <div className="note-rows">
          {list.map((note) => (
            <div className="note-row" key={note.id}>
              {showTrash ? (
                <div className="note-row-face">
                  <div className="note-row-title">{note.title}</div>
                  <div className="note-row-sub">Deleted {formatShortDate(note.deletedAt)}</div>
                </div>
              ) : (
                <button type="button" className="note-row-face" onClick={() => open(note.id)}>
                  <div className="note-row-title">{note.title}</div>
                  {/* The first line of the writing, so a row is recognisable
                      without opening it. Empty for a note nothing has been
                      typed into, which is honest — there is nothing to show. */}
                  <div className="note-row-sub">{note.preview || formatShortDate(note.updatedAt)}</div>
                </button>
              )}
              <div className="note-row-actions">
                {showTrash ? (
                  <>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => onRestore(note.id)}
                      title="Put this note back"
                      aria-label={`Put ${note.title} back`}
                    >
                      <Restore size={16} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn danger"
                      onClick={() => onPurge(note.id)}
                      title="Delete for good"
                      aria-label={`Delete ${note.title} for good`}
                    >
                      <Trash size={16} />
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="icon-btn danger"
                    onClick={() => remove(note.id)}
                    title="Move to Trash"
                    aria-label={`Move ${note.title} to the Trash`}
                  >
                    <Trash size={16} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
