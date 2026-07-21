// Camera / microphone enumeration helpers.
//
// Browsers hide device *labels* until the user has granted media permission at
// least once, so a fresh install shows "Microphone 1", "Camera 1" etc. until
// ensureLabels() has run.

export async function listDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      audioInputs: devices.filter((d) => d.kind === 'audioinput'),
      videoInputs: devices.filter((d) => d.kind === 'videoinput'),
    };
  } catch {
    return { audioInputs: [], videoInputs: [] };
  }
}

// Briefly opens the devices so the OS grants permission and labels become
// readable. Falls back to audio-only on machines with no camera.
export async function ensureLabels() {
  const attempts = [{ audio: true, video: true }, { audio: true }];
  for (const constraints of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      stream.getTracks().forEach((t) => t.stop());
      return true;
    } catch {
      // try the next, less demanding constraint set
    }
  }
  return false;
}

export function labelFor(device, index, fallback) {
  return device.label || `${fallback} ${index + 1}`;
}

// Subscribe to devices being plugged in / removed.
export function onDeviceChange(handler) {
  navigator.mediaDevices.addEventListener('devicechange', handler);
  return () => navigator.mediaDevices.removeEventListener('devicechange', handler);
}
