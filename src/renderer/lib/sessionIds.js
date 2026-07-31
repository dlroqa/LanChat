// A session is a local workspace with a conversation in it: an imported
// transcript to read, and questions forked from it to an agent. It is addressed
// by a thread id like any other conversation, so the window can tell one from a
// person or an agent by its id alone — the mirror of isAgentThread() in
// agentPhrase.js, and kept next to nothing else for the same reason: the shape
// of an id is the one thing every surface needs to agree on.

import { isAgentThread } from './agentPhrase.js';

export const SESSION_PREFIX = 'session:';

export function isSessionThread(id) {
  return typeof id === 'string' && id.startsWith(SESSION_PREFIX);
}

// Threads with something that thinks at the far end. A session asks an agent, so
// it waits the way an agent thread waits: no keepalives, no typing bursts, and
// an indicator driven by whether an answer is outstanding.
export function isThinkingThread(id) {
  return isAgentThread(id) || isSessionThread(id);
}
