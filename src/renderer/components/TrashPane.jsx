import React from 'react';
import { Trash, Restore } from '../lib/icons.jsx';
import { formatShortDate } from '../lib/util.js';

// The Trash: sessions that have been deleted and not yet deleted for good.
//
// It takes the conversation's place in the window rather than opening as a
// dialog, and wears the same header, because it is the same kind of thing — a
// list of workspaces, read where workspaces are read. What it deliberately does
// not have is anything a conversation's header has that this cannot do: no
// avatar, because a Trash is not somebody; no editable title, because "Trash"
// is not a name anybody chose; no import or export, because there is nothing in
// here to write out — a session in the Trash is put back first, and then it is
// an ordinary session with all of that available again.
//
// Everything shown is the record as main sees it. Nothing is remembered here:
// the list arrives on the `trash` event, so a session deleted in this window and
// one deleted by anything else land in exactly the same place.
export default function TrashPane({ trash = [], onRestore, onPurge, onRestoreAll, onPurgeAll }) {
  const count = trash.length;
  const empty = count === 0;

  return (
    <div className="chat">
      <div className="chat-header">
        <span className="session-mark large" aria-hidden="true">
          <Trash size={20} />
        </span>
        <div className="meta">
          <div className="name">Trash</div>
          <div className="sub">{empty ? 'Empty' : `${count} deleted session${count === 1 ? '' : 's'}`}</div>
        </div>
        <div className="chat-actions">
          {/* Emptying it, and undoing all of it. Both are disabled on an empty
              Trash rather than hidden: a button that vanishes when there is
              nothing to do teaches nobody where it was. */}
          <button
            className="icon-btn danger"
            onClick={onPurgeAll}
            disabled={empty}
            title="Delete everything in the Trash for good"
            aria-label="Delete everything in the Trash for good"
          >
            <Trash size={19} />
          </button>
          <button
            className="icon-btn"
            onClick={onRestoreAll}
            disabled={empty}
            title="Restore all sessions"
            aria-label="Restore all sessions"
          >
            <Restore size={19} />
          </button>
        </div>
      </div>

      {empty ? (
        <p className="empty-hint trash-empty">
          Nothing here. A deleted session waits in the Trash — with everything that was said in it — until you
          put it back or delete it for good.
        </p>
      ) : (
        <div className="trash-list">
          {trash.map((s) => (
            <div className="trash-row" key={s.id}>
              <span className="session-mark" aria-hidden="true">
                <Trash size={17} />
              </span>
              <div className="trash-meta">
                <div className="name">{s.title}</div>
                <div className="sub">Deleted {formatShortDate(s.deletedAt)}</div>
              </div>
              <div className="trash-row-actions">
                {/* Named in full rather than left as an icon: it is the one
                    thing somebody comes here to do, and the sentence says
                    where the session goes back to. */}
                <button className="btn ghost trash-restore" onClick={() => onRestore(s.id)}>
                  <Restore size={15} />
                  <span>Recover to Sessions</span>
                </button>
                <button
                  className="icon-btn danger"
                  onClick={() => onPurge(s.id)}
                  title="Delete this session for good"
                  aria-label="Delete this session for good"
                >
                  <Trash size={17} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
