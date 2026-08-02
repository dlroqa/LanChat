import React from 'react';
import { useCountdown } from '../lib/useCountdown.js';

// Where a thread stands in the queue for a shared agent.
//
// Both sides of a handover show a live countdown from the same duration, so the
// person losing the turn and the person about to get it watch the same number
// fall together rather than each seeing a static snapshot.

export default function QueueBadge({ peer }) {
  const counting = peer.queueExpiring === true && peer.queueExpiresInSec > 0;
  const left = useCountdown(peer.queueExpiresInSec, counting);

  // A standing is only ever true while the agent is reachable. It is pushed, so
  // once the connection drops nothing can arrive to correct it — the last frame
  // received would sit there claiming a place in a queue that no longer exists,
  // with dots still bouncing on a dead row. Say nothing instead of saying
  // something stale; the standing is republished as soon as the agent is back.
  if (peer.online === false) return null;

  if (peer.queueState === 'active') {
    if (counting) {
      return (
        <span
          className="tag warn counting"
          title={`Idle — the turn passes in ${left}s unless you ask something`}
        >
          {left}s left
        </span>
      );
    }
    return (
      <span
        className="tag good"
        title={`${peer.queueRemaining} of ${peer.queueQuota} queries left this turn`}
      >
        {peer.queueRemaining}/{peer.queueQuota} left
      </span>
    );
  }

  if (peer.queueState === 'waiting') {
    // Spelled out in full for the tooltip and for screen readers: the dots say
    // "waiting" by moving and "nearly your turn" by changing colour, and
    // neither of those survives on its own if you cannot see them.
    //
    // Only whoever is next inherits the turn, so only they get a countdown —
    // and it is the same clock the current holder is watching run out. Until
    // then there is no exact number, but the queries still ahead move in real
    // time as they are spent, so the wait is measurable rather than silent.
    const label = counting
      ? `You are next — the turn passes to you in ${left}s`
      : `Waiting for a turn — position ${peer.queuePosition}, ${peer.queueAhead} ${
          peer.queueAhead === 1 ? 'query' : 'queries'
        } ahead of you`;
    return (
      <span
        className={`queue-dots ${counting ? 'counting' : ''}`}
        title={label}
        aria-label={label}
        role="status"
      >
        <i />
        <i />
        <i />
        {counting && <b>{left}s</b>}
      </span>
    );
  }

  return null;
}

// The same standing as a sentence, for the chat header.
export function useQueueLabel(peer) {
  const counting = peer?.queueExpiring === true && peer?.queueExpiresInSec > 0;
  const left = useCountdown(peer?.queueExpiresInSec, counting);
  if (!peer || peer.online === false) return '';
  if (peer.queueState === 'active') {
    return counting
      ? ` · idle — turn passes in ${left}s unless you ask something`
      : ` · your turn, ${peer.queueRemaining} of ${peer.queueQuota} queries left`;
  }
  if (peer.queueState === 'waiting') {
    return counting
      ? ` · your turn in ${left}s`
      : ` · waiting for a turn, #${peer.queuePosition} in line${peer.queueAhead ? `, ${peer.queueAhead} queries ahead of you` : ''}`;
  }
  return '';
}
