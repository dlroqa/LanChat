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

// The two lines a summon used to leave behind in an agent thread.
//
// Summoning writes nothing now, on either machine, but every thread summoned
// before that still holds them — and a peer on an older build still sends the
// greeting, so a thread can pick one up today. Neither is a question or an
// answer; both are machinery, and the thread is for the conversation.
//
// Anchored end to end, the way findKeptErrors is and for the same reason:
//
//   * the greeting as the owner's machine wrote it, with the agent's name in the
//     middle. `.{1,64}` rather than `.*` so a long line cannot wander into it;
//   * a bare `@name` and *nothing else*, which is exactly the shape of the
//     summon bubble. `@Tessie what is the time` is a real question and must
//     survive, which is what `\S+$` guarantees.
//
// Direction matters both ways round. The greeting only ever arrived, and the
// summon line was only ever ours — so an inbound `@name` is something a peer
// said and is left alone.
const LEGACY_GREETING = /^Hello — .{1,64} here\. Ask me anything\.$/;
const BARE_MENTION = /^@\S{1,64}$/;

export function findSummonLeftovers(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.filter((m) => {
    if (!m || m.kind === 'file' || typeof m.text !== 'string') return false;
    // Anything already counting itself down is on its way out without help, and
    // was never on disk to begin with.
    if (m.notice || m.error) return false;
    if (m.direction === 'in') return LEGACY_GREETING.test(m.text);
    if (m.direction === 'out') return BARE_MENTION.test(m.text);
    return false;
  });
}
