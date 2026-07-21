// Serialization for WebRTC signaling payloads.
//
// Signaling crosses Electron's IPC boundary (renderer -> main -> peer), which
// uses the structured clone algorithm. RTCIceCandidate and RTCSessionDescription
// are *platform objects* and are NOT structured-cloneable: passing one straight
// to ipcRenderer.invoke rejects with "An object could not be cloned".
//
// That failure was silent (the send was never awaited), so ICE candidates never
// reached the peer, no media path was ever established, and calls appeared to
// connect while carrying no audio or video. Everything on the wire must be a
// plain JSON-safe object.

export function serializeCandidate(candidate) {
  if (!candidate) return null;
  const c = typeof candidate.toJSON === 'function' ? candidate.toJSON() : candidate;
  return {
    candidate: c.candidate || '',
    sdpMid: c.sdpMid ?? null,
    sdpMLineIndex: c.sdpMLineIndex ?? null,
    usernameFragment: c.usernameFragment ?? null,
  };
}

export function serializeDescription(desc) {
  if (!desc) return null;
  return { type: desc.type, sdp: desc.sdp };
}

// Guard used in tests and at runtime: true when the value survives a structured
// clone, i.e. it can safely cross the IPC boundary.
export function isCloneable(value) {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}
