import { useEffect, useState } from 'react';

// What to call the state of an agent that is busy.
//
// These are flavour on top of a real state, never a substitute for one: they are
// only ever shown while the agent is genuinely working, and a concrete detail
// reported by the transport ("Running bash…") always wins over a phrase.
export const THINKING = [
  'Thinking',
  'Searching',
  'Reasoning',
  'Working it out',
  'Digging around',
  'Piecing it together',
  'Figuring it out',
  'Finagling',
  'Chewing on it',
  'Looking into it',
];

const PERIOD_MS = 2600;

// Derived from the clock rather than from component state, so every place that
// shows the agent's status — the roster, the chat, the side panel, and the same
// agent open on another machine — lands on the same word at the same time
// instead of each drifting to its own rhythm.
export function phraseAt(now = Date.now()) {
  return THINKING[Math.floor(now / PERIOD_MS) % THINKING.length];
}

export function useAgentPhrase(active) {
  const [phrase, setPhrase] = useState(() => phraseAt());
  useEffect(() => {
    if (!active) return undefined;
    setPhrase(phraseAt());
    const t = setInterval(() => setPhrase(phraseAt()), 400);
    return () => clearInterval(t);
  }, [active]);
  return phrase;
}

// Agent conversations, whether hosted here or shared by a peer. Both are chat
// threads with something that thinks rather than types, so the UI treats them
// alike.
export function isAgentThread(id) {
  return typeof id === 'string' && (id.startsWith('agent:') || id.startsWith('remote-agent:'));
}
