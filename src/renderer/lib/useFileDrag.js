import { useCallback, useEffect, useRef, useState } from 'react';

// The sheet that says what a dropped file will do — and, the harder half, when
// it comes down again.
//
// A drag is not a sequence a window can count. `dragenter` and `dragleave`
// arrive in pairs as the pointer crosses the elements *inside* the window, so
// counting them means keeping a depth that one missed event leaves wrong for
// the rest of the session. And the ways a drag ends are worse: carried back out
// of the window, cancelled with Esc, dropped on some other application — the
// page is told about none of them reliably. Waiting to be told is how the sheet
// stayed up over every conversation, Sessions and Agents and People alike,
// until the app was restarted.
//
// What is dependable is the opposite signal. While a drag is over the window,
// the drag-and-drop processing model keeps firing `dragover` at whatever is
// under the pointer, on a cadence the HTML specification fixes at every 350ms
// ±200ms — even if the pointer never moves. So the sheet is *held up* by that
// heartbeat rather than taken down by an event: a `dragleave` only proposes an
// ending, and the proposal is withdrawn by the `dragenter` for the element the
// pointer has moved on to, which arrives in the same burst of events. If the
// heartbeat stops for longer than it is allowed to rest, the sheet comes down
// regardless.
//
// The upshot is that there is no stuck state to reach. Anything that ends a
// drag ends the heartbeat, and the sheet goes with it.

// The specified cadence at its slowest is 550ms, so this is a little under
// twice the longest gap a live drag can leave. Nothing rests on the number
// being exact: it is the backstop for the endings that announce themselves
// nowhere else, and every other ending is taken the moment it arrives.
const QUIET_MS = 1000;

// A crossing from one element to the next fires `dragleave` and `dragenter`
// together, so this only has to outlast one burst of events — while a file
// carried back out of the window, where no `dragenter` follows, puts the sheet
// away too quickly to read as a delay.
const GRACE_MS = 120;

export function useFileDrag() {
  const [dragging, setDragging] = useState(false);
  const timers = useRef({ quiet: 0, grace: 0 });

  // Down now, and both countdowns off with it.
  const stop = useCallback(() => {
    clearTimeout(timers.current.quiet);
    clearTimeout(timers.current.grace);
    timers.current.quiet = 0;
    timers.current.grace = 0;
    setDragging(false);
  }, []);

  // The drag is still here — every `dragenter` and every `dragover` says so.
  // Any pending ending is withdrawn, and the sheet gets another QUIET_MS.
  const hold = useCallback(() => {
    clearTimeout(timers.current.grace);
    timers.current.grace = 0;
    clearTimeout(timers.current.quiet);
    timers.current.quiet = setTimeout(stop, QUIET_MS);
    setDragging(true);
  }, [stop]);

  // A `dragleave`, which is only a proposal — see above. Left alone if one is
  // already pending, so a burst of leaves does not push the ending further out.
  const release = useCallback(() => {
    if (timers.current.grace) return;
    timers.current.grace = setTimeout(stop, GRACE_MS);
  }, [stop]);

  // Two endings worth taking at once rather than waiting out the quiet: a drag
  // that started in this window finishing anywhere, and the window losing focus
  // — nothing is being dragged into a window that is not in front.
  useEffect(() => {
    window.addEventListener('dragend', stop);
    window.addEventListener('blur', stop);
    const t = timers.current;
    return () => {
      window.removeEventListener('dragend', stop);
      window.removeEventListener('blur', stop);
      clearTimeout(t.quiet);
      clearTimeout(t.grace);
    };
  }, [stop]);

  return { dragging, hold, release, stop };
}
