// Where a thread stands in the queue for a shared agent, as one value.
//
// The agent panel needs this in three places at once — the word in the Status
// box, the tint on the Turn box, and the text inside it — and deriving it three
// times is exactly how those three drift apart and start contradicting each
// other. Derive it once here instead.
//
// Pure and DOM-free on purpose: the countdown is ticked by useCountdown in the
// component and handed in, so this stays a plain function of the peer card.

const WORDS = {
  waiting: 'Waiting',
  brace: 'Brace',
  ready: 'Ready',
  handover: 'Handover',
};

export function turnStanding(peer, secondsLeft) {
  if (!peer) return null;

  // A standing is pushed, so once the connection is gone nothing can arrive to
  // correct it — the last frame received would sit there claiming a place in a
  // queue that no longer exists, counting down to a handover that will never
  // happen. Say what is actually true instead.
  //
  // Not `!peer.online` alone: a delegate thread is always offline because it is
  // a transcript with no socket of its own, yet its standing is mirrored here
  // by this very process and is never stale. The test is whether a connection
  // failed, not whether one exists.
  if (peer.online === false && !peer.delegate) {
    // No word: the Status box keeps its own off-state label, which already says
    // why in more detail than this box has room for.
    return { key: 'offline', word: null, text: 'Offline' };
  }

  // The same guard the roster badge and the chat header use, so all three agree
  // on when a countdown is running.
  const counting = peer.queueExpiring === true && peer.queueExpiresInSec > 0;

  if (peer.queueState === 'active') {
    const key = counting ? 'handover' : 'ready';
    return {
      key,
      word: WORDS[key],
      text: counting ? `${secondsLeft}s left` : `${peer.queueRemaining}/${peer.queueQuota} left`,
    };
  }

  if (peer.queueState === 'waiting') {
    const key = counting ? 'brace' : 'waiting';
    return {
      key,
      word: WORDS[key],
      text: counting ? `your turn in ${secondsLeft}s` : `#${peer.queuePosition} in line`,
    };
  }

  // An agent that runs here takes no turns, so there is no standing to show.
  return null;
}

// The same standing spelled out, for the tooltip and for screen readers. Colour
// carries the state at a glance in the panel; it must not be the only thing
// that carries it.
export function turnStandingLabel(peer, secondsLeft) {
  const standing = turnStanding(peer, secondsLeft);
  if (!standing) return '';
  switch (standing.key) {
    case 'offline':
      return 'Not connected — there is no queue to stand in until this agent is back';
    case 'handover':
      return `Idle — the turn passes on in ${secondsLeft}s unless you ask something`;
    case 'ready':
      return `Your turn — ${peer.queueRemaining} of ${peer.queueQuota} queries left`;
    case 'brace':
      return `You are next — the turn passes to you in ${secondsLeft}s`;
    default:
      return `Waiting for a turn — position ${peer.queuePosition}, ${peer.queueAhead} ${
        peer.queueAhead === 1 ? 'query' : 'queries'
      } ahead of you`;
  }
}
