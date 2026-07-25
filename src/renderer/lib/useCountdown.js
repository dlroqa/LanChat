import { useEffect, useRef, useState } from 'react';

// Ticks a countdown down to zero.
//
// The main process sends a *duration* rather than a deadline, and each machine
// turns it into its own local deadline here. That is deliberate: two peers
// counting down to the same wall-clock timestamp would drift apart by however
// far their clocks disagree, whereas both starting a 20-second timer the moment
// the same frame lands stay in step to within the network hop.
//
// The deadline is only recomputed when the duration actually changes, so a
// re-render caused by anything else does not restart the count.
export function useCountdown(seconds, active) {
  const [left, setLeft] = useState(0);
  const deadlineRef = useRef(0);
  const key = active ? seconds : 0;

  useEffect(() => {
    if (!active || !seconds) {
      deadlineRef.current = 0;
      setLeft(0);
      return undefined;
    }
    deadlineRef.current = Date.now() + seconds * 1000;
    const read = () => setLeft(Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000)));
    read();
    // Twice a second, so the displayed number never lags a full second behind.
    const timer = setInterval(read, 500);
    return () => clearInterval(timer);
  }, [key, active, seconds]);

  return left;
}
