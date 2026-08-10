'use strict';

// When it is not rude to speak.
//
// An observer that has earned the right to say something still has to pick a
// moment. The whole value of the feature is destroyed by getting this wrong in
// either direction: speak over somebody mid-sentence and it is an interruption
// dressed up as help; wait for a silence that never comes and the idea arrives
// three topics too late.
//
// A seam is a gap in the conversation. Not a long one — a few seconds where
// nobody is typing, nothing has just landed, and no agent is mid-answer. That is
// the moment a person in a room would pick, and it is cheap to detect because
// LanChat already tracks all three facts for other reasons.
//
// ---- what a seam is deliberately not ----
//
// **Disconnection is not consent.** A peer whose socket dropped is not somebody
// who has stopped talking; they are somebody we cannot hear. Treating absence as
// a gap would make the observer loudest exactly when the room is least able to
// object, so presence is never an input here. This is the one rule in the file
// worth stating twice.
//
// Everything is a pure function over an injected clock. Timing is the thing
// least testable by running it, so nothing here reads Date.now on its own.

// How long after somebody's last message the room still counts as busy.
//
// Adaptive between the two, and the reason is what people do rather than what is
// tidy: a person who has just sent one line is usually still typing the next, and
// a person who has sent a paragraph is usually finished. So a short message buys
// a longer wait. Both ends are a few seconds — long enough not to trample the
// end of a thought, short enough that the gap actually arrives.
const MIN_DEBOUNCE_MS = 4000;
const MAX_DEBOUNCE_MS = 6000;

// A message this long or longer is treated as a finished thought.
const LONG_MESSAGE = 240;

// How long a typing indicator is believed for.
//
// Typing state arrives as an event and there is no event for "stopped typing
// without sending" that can be relied on across a flaky link. So a stale
// indicator expires rather than pinning the observer shut for ever — the failure
// mode of trusting it indefinitely is an observer that never speaks again after
// one dropped frame.
const TYPING_TTL_MS = 8000;

// How long after speaking an observer must wait before it may ask again.
//
// Diminishing returns, made mechanical. Even a genuinely useful contribution
// buys quiet afterwards, because the second one in a row is where "helpful"
// turns into "talkative" and nobody can point at the moment it happened.
const COOLDOWN_MS = 90 * 1000;

// And how long a protective interruption buys. Much longer, because the whole
// claim of that path is that it is rare — an interruption that can happen twice
// in five minutes was never protective, it was just loud.
const PROTECTIVE_COOLDOWN_MS = 10 * 60 * 1000;

// The most protective interruptions a session may ever produce in an hour.
//
// A ceiling on top of the cooldown, because a cooldown alone permits six an hour
// for ever. If a room genuinely needs more than this, the observer is
// misconfigured and the right answer is for somebody to look at it rather than
// for it to keep firing.
const PROTECTIVE_MAX_PER_HOUR = 3;
const HOUR_MS = 60 * 60 * 1000;

// How long a floor request waits for a gap before it gives up and goes to the
// shelf.
//
// It does not expire into nothing — the idea was worth having and is still worth
// reading later. It stops *waiting*, which is a different thing, and the card it
// becomes says so.
const SEAM_PATIENCE_MS = 45 * 1000;

// How long to wait after the last human message before speaking.
function debounceFor(lastMessage) {
  const length = String(lastMessage == null ? '' : lastMessage).length;
  return length >= LONG_MESSAGE ? MIN_DEBOUNCE_MS : MAX_DEBOUNCE_MS;
}

// Whether anybody in the room is mid-sentence.
//
// `typing` is a map of peer id to the time their last typing event arrived —
// which is how a shared session makes the multi-person rule real rather than
// theoretical: one person's typing holds the floor shut for everybody's
// observers, exactly as it would in a room.
function anyoneTyping(typing, now) {
  if (!typing) return false;
  for (const at of Object.values(typing)) {
    if (Number.isFinite(at) && now - at < TYPING_TTL_MS) return true;
  }
  return false;
}

// Whether this is a moment to speak into.
//
// All four have to be true, and each is a different way of being rude:
// interrupting a sentence, stepping on a message that just landed, talking over
// an agent that is already answering, and speaking again too soon after the last
// time.
function seamOpen({
  typing = null,
  lastHumanAt = 0,
  lastHumanText = '',
  streaming = false,
  lastSpokeAt = 0,
  cooldownMs = COOLDOWN_MS,
  now = Date.now(),
} = {}) {
  if (streaming) return false;
  if (anyoneTyping(typing, now)) return false;
  if (lastHumanAt && now - lastHumanAt < debounceFor(lastHumanText)) return false;
  if (lastSpokeAt && now - lastSpokeAt < cooldownMs) return false;
  return true;
}

// Whether a floor request has waited long enough to stop waiting.
function seamStarved(requestedAt, now = Date.now()) {
  if (!requestedAt) return false;
  return now - requestedAt >= SEAM_PATIENCE_MS;
}

// Whether a session may interrupt right now, on top of everything else.
//
// Separate from seamOpen because a protective interruption does not wait for a
// seam — that is the entire point of it — but it is still rate limited, and by a
// stricter rule. `history` is when this session last interrupted, most recent
// first.
function protectiveAllowedNow(history, now = Date.now()) {
  const times = (history || []).filter((t) => Number.isFinite(t));
  if (times.length === 0) return true;
  const last = Math.max(...times);
  if (now - last < PROTECTIVE_COOLDOWN_MS) return false;
  const recent = times.filter((t) => now - t < HOUR_MS);
  return recent.length < PROTECTIVE_MAX_PER_HOUR;
}

// Whether an unsolicited turn has already been spent.
//
// At most one agent speaks unasked before a person says something again. Two in
// a row is a conversation between observers with somebody watching, which is the
// thing this whole feature is arranged to prevent.
function turnSpent({ spokeAt = 0, lastHumanAt = 0 } = {}) {
  if (!spokeAt) return false;
  return spokeAt > lastHumanAt;
}

module.exports = {
  MIN_DEBOUNCE_MS,
  MAX_DEBOUNCE_MS,
  LONG_MESSAGE,
  TYPING_TTL_MS,
  COOLDOWN_MS,
  PROTECTIVE_COOLDOWN_MS,
  PROTECTIVE_MAX_PER_HOUR,
  SEAM_PATIENCE_MS,
  debounceFor,
  anyoneTyping,
  seamOpen,
  seamStarved,
  protectiveAllowedNow,
  turnSpent,
};
