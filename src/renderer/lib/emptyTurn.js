// A turn with nothing in it.
//
// Agents are told two things about having nothing to say. A discussion asks them
// to end on a closing line when they are done — "nothing further." — and the
// observer asks for the single word NOTHING when it has nothing worth
// interrupting for. Both are stored verbatim, which is right for the first and
// unfortunate for the second: a room fills up with bubbles that say only
// "NOTHING" and "nothing further.", and they are still there in the export and
// in the context the agents are handed back.
//
// **Whole body, or nothing.** A real answer that happens to end on the closing
// line is a real answer:
//
//     The answer's been given and independently verified — no rain for
//     Brentwood through Thursday. Two agents confirming the same zero is where
//     this one closes.
//
//     nothing further.
//
// That message is kept, entire, with its last line exactly as it was written.
// This module never edits a message and never asks anybody else to: a bubble is
// either kept whole or removed whole. dialogue.js says why in as many words —
// the closing line is a sentence rather than a sentinel *because* it is never
// stripped, and rewriting an answer to make the bookkeeping tidy is not a thing
// this codebase does. Removing a bubble that had nothing in it does not break
// that rule; editing one would.
//
// Pure and dependency-free, like sidebarSections.js and findInThread.js — the
// suite loads this file directly with the `export` keywords stripped.

// The closing line a discussion ends on, as dialogue.js defines it: optionally
// led by a dash, optionally followed by a full stop. Held here as a copy rather
// than imported, because that lives in main and this runs in the browser — and
// test/emptyTurn.test.js reads both files to make sure the copy still agrees
// with the line main actually asks agents to send.
const CLOSING_RE = /^\s*[—–-]?\s*nothing further[.!]?\s*$/i;

// The word the observer is told to reply with, allowing for the full stop and
// the quotation marks a model adds around a single word. The bare form of
// saidNothing() in observerPrompt.js.
const NOTHING_RE = /^["'`]?NOTHING["'`.!]*$/i;

// Whether a whole message body says nothing at all.
//
// Every non-blank line is counted, and one is the most there may be. That single
// count is what tells the two cases apart: a bubble that is only the closing
// line, and a bubble that reasons for a paragraph and then closes. The second
// has something in it to lose.
export function isEmptyBody(text) {
  const lines = String(text == null ? '' : text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) return false;
  return CLOSING_RE.test(lines[0]) || NOTHING_RE.test(lines[0]);
}

// Whether this message, in this thread, is an agent turn with nothing in it.
//
// The guards are as narrow as the thing being deleted. Only a session — the
// closing line and the observer's word are both things said in a room, and an
// agent's own thread has neither. Only something that arrived, only text, and
// only from an agent: `agentId` is stamped on the host's copy of an answer,
// `speakerId` on a guest's, and a person in the room has neither — so somebody
// typing "nothing further." keeps their words, which are theirs.
//
// Notices and errors are excluded because they are never written down anyway and
// have their own clocks. An imported transcript is excluded outright: it is the
// reader's own file, and nothing in here gets to decide a line of it was surplus.
export function isEmptyTurn(msg, { isSession = false } = {}) {
  if (!isSession || !msg) return false;
  if (msg.direction !== 'in' || msg.kind !== 'text') return false;
  if (msg.notice || msg.error || msg.imported) return false;
  if (!msg.agentId && !msg.speakerId) return false;
  return isEmptyBody(msg.text);
}

// The ones already sitting in a thread, for the sweep that runs when it is
// opened. Same rule, applied to a history that arrived from disk — after a
// window was closed mid-countdown, after a guest was sent the backlog of a room
// they just joined, or after a build that predates any of this.
export function findEmptyTurns(messages, opts) {
  return (messages || []).filter((m) => isEmptyTurn(m, opts));
}
