import React from 'react';
import ModalShell from './ModalShell.jsx';

// Errors an older version wrote into a session's history, offered for removal.
//
// Asked rather than done. New errors erase themselves ten seconds after they
// appear, which is a promise made at the moment somebody is watching; these were
// written before that promise existed, and sweeping them the instant a session
// opened would be deleting a conversation on the strength of a decision its
// owner never made.
export default function ErrorSweepModal({ count, onKeep, onRemove }) {
  const many = count !== 1;
  return (
    // Escape means Keep. ModalShell wires the close affordance and the backdrop
    // to onClose, so the way out that costs nothing is the one you get by
    // default — never the one that deletes.
    <ModalShell
      title="Clean this history?"
      desc={
        `This session has ${count} error message${many ? 's' : ''} saved in it from an earlier ` +
        `version — the kind that now disappears on its own a few seconds after it appears.`
      }
      onClose={onKeep}
      className="sweep-modal"
    >
      <p className="desc">
        Removing {many ? 'them' : 'it'} also takes {count} off this session&rsquo;s commit count.{' '}
        {many ? 'Each of those errors was' : 'That error was'} a question that never got an answer, so{' '}
        {many ? 'they were' : 'it was'} never work the session got out of the agent.
      </p>
      {/* The part that cannot be undone, said before the button rather than
          discovered afterwards. These errors were written before a failure named
          the question that caused it, so there is no way to tell which question
          each belonged to — and no way to put one back. */}
      <p className="desc warn-note">
        The questions behind {many ? 'them' : 'it'} cannot be recovered:{' '}
        {many ? 'these errors' : 'this error'} predate the link back to what was asked. You will need to
        reconnect the context yourself before forking from this conversation.
      </p>
      <div className="modal-actions">
        <button className="btn" onClick={onKeep}>
          Keep
        </button>
        <button className="btn danger" onClick={onRemove}>
          Remove {count} message{many ? 's' : ''}
        </button>
      </div>
    </ModalShell>
  );
}

// Which messages in a loaded history are errors an older version kept.
//
// Anchored on the prefix reply() wrote them with, and nothing looser. Searching
// for the glyph anywhere would match a message *quoting* an error — somebody
// pasting one back to ask about it is exactly the kind of message a sweep must
// never touch.
//
// Outbound messages are exempt whatever they say: only the app writes these, and
// it only ever writes them inbound. Files too, which have no text to match.
//
// Exported for its own sake as much as for the component's: this is the rule
// that decides what gets deleted, and it is worth being able to test on its own.
export function findKeptErrors(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.filter(
    (m) =>
      m &&
      m.direction === 'in' &&
      m.kind !== 'file' &&
      typeof m.text === 'string' &&
      m.text.startsWith('⚠️ ') &&
      // A message still on screen from this session is already on its way out —
      // it has a countdown running and main never stored it. Sweeping it would
      // be asking to delete something that is not on disk.
      !m.notice &&
      !m.error
  );
}
