// Voice message recording.
//
// Records from the microphone with MediaRecorder and hands back an encoded blob.
// The container is whichever Opus-capable format the platform supports — Chromium
// on Linux/Windows gives audio/webm, macOS Safari-derived stacks prefer audio/mp4
// — so the extension is chosen to match rather than assumed, otherwise the file
// gets mistyped on the receiving side.

const CANDIDATES = [
  { mime: 'audio/webm;codecs=opus', ext: '.weba' },
  { mime: 'audio/webm', ext: '.weba' },
  { mime: 'audio/ogg;codecs=opus', ext: '.ogg' },
  { mime: 'audio/mp4', ext: '.m4a' },
];

const MIN_DURATION_MS = 400; // shorter than this is a mis-click, not a message

let cachedFormat; // undefined = not probed yet, null = unsupported here

// Codec support cannot change within a session, and this is called on every
// composer render, so probe once.
export function pickFormat() {
  if (cachedFormat !== undefined) return cachedFormat;
  cachedFormat = null;
  if (typeof MediaRecorder !== 'undefined') {
    cachedFormat = CANDIDATES.find((c) => MediaRecorder.isTypeSupported(c.mime)) || null;
  }
  return cachedFormat;
}

// Starts recording immediately. The returned handle exposes stop() -> blob and
// cancel(), both of which always release the microphone.
export async function startRecording({ deviceId } = {}) {
  const format = pickFormat();
  if (!format) throw new Error('Voice recording is not supported here.');

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: deviceId ? { deviceId: { exact: deviceId } } : true,
  });

  const recorder = new MediaRecorder(stream, { mimeType: format.mime });
  const chunks = [];
  recorder.ondataavailable = (e) => e.data && e.data.size > 0 && chunks.push(e.data);
  recorder.start();
  const startedAt = Date.now();

  // Releasing every track is what actually turns the mic indicator off.
  const release = () => stream.getTracks().forEach((t) => t.stop());

  return {
    format,
    startedAt,

    async stop() {
      const durationMs = Date.now() - startedAt;
      const blob = await new Promise((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: format.mime }));
        try {
          recorder.stop();
        } catch {
          resolve(new Blob(chunks, { type: format.mime }));
        }
      });
      release();
      if (durationMs < MIN_DURATION_MS || blob.size === 0) return null;
      return { blob, durationMs, ext: format.ext };
    },

    cancel() {
      try {
        recorder.stop();
      } catch {}
      release();
    },
  };
}

export function formatDuration(ms) {
  const total = Math.round((ms || 0) / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export { MIN_DURATION_MS };
