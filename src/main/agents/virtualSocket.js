'use strict';

// PeerHub treats a peer as anything registered with a { readyState, send() }
// object — it never inspects the socket beyond that. A virtual socket satisfies
// that contract but hands the frame to an agent connector instead of the wire,
// which is what lets an agent reuse the roster, presence dots, unread counts and
// persisted history without any change to peers.js.
//
// readyState uses the same numeric constants as `ws` (OPEN = 1, CLOSED = 3) so
// PeerHub.isConnected() and openSocket() work unmodified.

const OPEN = 1;
const CLOSED = 3;

function createVirtualSocket(onFrame) {
  return {
    readyState: OPEN,

    // PeerHub.send() serialises before handing the frame over, so parse it back.
    send(raw) {
      try {
        onFrame(JSON.parse(raw));
      } catch (err) {
        console.error('[agents] malformed outbound frame:', err.message);
      }
    },

    close() {
      this.readyState = CLOSED;
    },
  };
}

module.exports = { createVirtualSocket, OPEN, CLOSED };
