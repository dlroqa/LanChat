import React from 'react';
import { floorAsk } from '../lib/observerCopy.js';

// An observer asking to say something.
//
// The shelf is for ideas that can wait. This is the other kind: something an
// observer thinks is worth the interruption, which is exactly the claim a person
// should get to judge rather than have judged for them. So it asks, and it says
// what it wants to say while asking — a request that hid its own claim would be
// a notification with extra friction, and there would be nothing to decide on.
//
// It sits above the composer rather than in the transcript, because it is not
// part of the conversation until somebody says it is. Nothing here has been said
// yet: the words an observer will actually use are written after this is
// granted, against whatever has been said in the meantime.
//
// Three answers, because those are the three a person really has: yes, not now,
// and no. "Not now" is the important one — it is what stops the choice being
// between an interruption and losing the idea.
export default function FloorRequest({ floor, onHear, onShelf, onDismiss }) {
  if (!floor) return null;

  return (
    <div className="floor-req" role="status" aria-label={floorAsk(floor)}>
      <div className="floor-req-body">
        <span className="floor-req-who">{floor.who}</span>
        <span className="floor-req-claim">{floor.claim}</span>
      </div>
      {/* Once granted it is waiting for a gap rather than for the person, and it
          says so — a request that simply stopped responding to its own buttons
          would read as broken. */}
      {floor.granted ? (
        <span className="floor-req-waiting">waiting for a pause…</span>
      ) : (
        <div className="floor-req-acts">
          <button type="button" className="floor-act" onClick={onHear}>
            Hear it
          </button>
          <button type="button" className="floor-act quiet" onClick={onShelf}>
            Not now
          </button>
          <button
            type="button"
            className="floor-act quiet"
            onClick={onDismiss}
            aria-label="Dismiss this request"
          >
            No
          </button>
        </div>
      )}
    </div>
  );
}
