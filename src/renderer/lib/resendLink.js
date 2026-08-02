// The link between a question that went unanswered and the question sent to
// replace it.
//
// Re-sending is a restore rather than a re-send — the words go back into the
// composer and are sent as a new message with a new id (see resendFrom in
// App.jsx) — so nothing on either message says they are the same question asked
// twice. Without that link the older copy sits in the thread forever, still
// claiming it was never answered, underneath the answer to the very same words.
//
// So the link is held here: one entry per thread, established when the words go
// back into the composer, armed when they are sent, and consumed when the run
// that answers them concludes. Kept out of App.jsx because the interesting part
// is the decision — which events conclude a run, and which of those are worth
// removing a bubble over — and a decision is worth testing without a browser.
//
// Pure and DOM-free: App holds the map in a ref and does the removing.

// Putting a failed question back in the composer. Not yet sent — the person may
// change it, may send it somewhere else, or may never send it at all, and none
// of those should retire anything.
//
// A second restore on the same thread replaces the first: whatever is in the
// composer now is what the next send is a replacement for.
export function linkResend(links, threadId, messageId) {
  if (!threadId || !messageId) return links;
  return { ...links, [threadId]: { id: messageId, sent: false } };
}

// Arming it, or putting it back. `sendText` arms the link before it awaits the
// send and disarms it again if the send was refused — the question the composer
// still holds has not been asked, so nothing may be retired on its behalf.
export function markSent(links, threadId, sent) {
  const link = links[threadId];
  if (!link || link.sent === sent) return links;
  return { ...links, [threadId]: { ...link, sent } };
}

// Dropping it unfired: the thread was cleared, or the question it points at is
// no longer there to be retired.
export function clearLink(links, threadId) {
  if (!links[threadId]) return links;
  const { [threadId]: _gone, ...rest } = links;
  return rest;
}

// What a message arriving in a thread says about the run that was answering it.
//
// `null` means the run has not concluded and the link stands: an outgoing
// message is our own, and a turn-queue notice — "you are #2 in line" — is the
// queue talking, not an answer. An error is a conclusion like any other: the run
// finished, badly, and main has already marked the new question with it.
export function chatOutcome(payload) {
  if (!payload || payload.direction !== 'in') return null;
  if (payload.error === true) return 'failure';
  if (payload.notice === true) return null;
  return 'answer';
}

// The same question for a session, which is decided by the round rather than by
// any one message in it: a counsel puts one question to several agents, and the
// first of three answering does not conclude anything. Only the closing round
// does — the one main publishes with `open` false.
export function roundOutcome(payload) {
  if (!payload || payload.open !== false) return null;
  if (payload.answered?.length) return 'answer';
  if (payload.failedRef) return 'failure';
  return 'empty';
}

// The end of it: the link goes, and the id of the question to retire comes back
// with it.
//
// Every conclusion drops the link, including an empty one. That is what stops an
// armed link outliving the run it belongs to and retiring a question hours later
// because something unrelated was finally answered in the same thread.
//
// But an empty run retires nothing. Nothing came back and nothing was marked, so
// the old bubble is the only remaining record that this question has now gone
// unanswered twice — and the button on it is still the thing to do about that.
export function retire(links, threadId, outcome) {
  const link = links[threadId];
  if (!outcome || !link || !link.sent) return { links, id: null };
  return {
    links: clearLink(links, threadId),
    id: outcome === 'empty' ? null : link.id,
  };
}
