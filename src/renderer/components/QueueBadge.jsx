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

  if (peer.queueState === 'active') {
    if (counting) {
      return (
        <span className="tag warn counting" title={`Idle — the turn passes in ${left}s unless you ask something`}>
          {left}s left
        </span>
      );
    }
    return (
      <span className="tag good" title={`${peer.queueRemaining} of ${peer.queueQuota} queries left this turn`}>
        {peer.queueRemaining}/{peer.queueQuota} left
      </span>
    );
  }

  if (peer.queueState === 'waiting') {
    // Only whoever is next inherits the turn, so only they get a countdown.
    if (counting) {
      return (
        <span className="tag good counting" title={`You are next — the turn passes to you in ${left}s`}>
          up in {left}s
        </span>
      );
    }
    return (
      <span className="tag warn" title={`Waiting for a turn — position ${peer.queuePosition}`}>
        #{peer.queuePosition} in line
      </span>
    );
  }

  return null;
}

// The same standing as a sentence, for the chat header.
export function useQueueLabel(peer) {
  const counting = peer?.queueExpiring === true && peer?.queueExpiresInSec > 0;
  const left = useCountdown(peer?.queueExpiresInSec, counting);
  if (!peer) return '';
  if (peer.queueState === 'active') {
    return counting
      ? ` · idle — turn passes in ${left}s unless you ask something`
      : ` · your turn, ${peer.queueRemaining} of ${peer.queueQuota} queries left`;
  }
  if (peer.queueState === 'waiting') {
    return counting
      ? ` · you are next — turn passes to you in ${left}s`
      : ` · waiting for a turn, #${peer.queuePosition} in line`;
  }
  return '';
}
