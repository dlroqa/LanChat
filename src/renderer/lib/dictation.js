// Hold-to-dictate: record while the key is held, transcribe on release.
//
// This is the agent-thread counterpart to push-to-talk. Where PTT opens a live
// channel to a person, an agent has no ear — so the same gesture records, hands
// the audio to a local transcriber, and gives back text.
//
// The one design constraint worth stating: the microphone does not open the
// instant the key goes down. On macOS the push-to-talk key is Command, which is
// also the first half of ⌘C, ⌘V and ⌘Z — and dictation deliberately runs while
// the composer has focus, where those shortcuts are used constantly. So a hold
// only arms the recorder; ARM_MS later it starts. attachPttKey already releases
// the moment a second key arrives, which for a shortcut happens in tens of
// milliseconds — comfortably inside the window, so the mic never opens and no
// cue plays. The cost is that a useful hold is ARM_MS + MIN_DURATION_MS long.

// Whether holding the key here dictates rather than transmits. Kept as a plain
// function of its three inputs so the answer can be asserted directly — the one
// that matters most is that it is false off macOS, where the key must keep
// doing exactly what it did before.
export function shouldDictate({ isMac, enabled, thinkingThread }) {
  return Boolean(isMac && enabled !== false && thinkingThread);
}

// What a hold started here actually does.
//
//   'radio'   — open the voice channel, exactly as push-to-talk always has
//   'dictate' — record and transcribe
//   'none'    — this thread dictates, but there is nothing installed to do it
//
// The third case is why this is not just shouldDictate(): with FluidVoice
// unreachable, falling back to 'radio' would open the microphone for an agent
// that cannot hear it, which is the very thing dictation replaced. Doing nothing
// is the honest answer, and the card beside it says how to fix it. `ready` is
// null until the check comes back, which counts as ready — a hold in the first
// moment after launch should not be silently dropped.
export function holdMode({ isMac, enabled, thinkingThread, ready }) {
  if (!shouldDictate({ isMac, enabled, thinkingThread })) return 'radio';
  return ready === false ? 'none' : 'dictate';
}

export const ARM_MS = 250; // hold at least this long before the mic opens
export const MAX_DICTATION_MS = 120000; // a key held by accident is not a monologue
export const ERROR_CLEAR_MS = 5000;

export class DictationManager {
  constructor({ record, encode, transcribe, getDevices, onState, onResult, onError, onCue }) {
    this.record = record;
    this.encode = encode;
    this.transcribe = transcribe;
    this.getDevices = getDevices || (() => ({ audioInputId: null }));
    this.onState = onState || (() => {});
    this.onResult = onResult || (() => {});
    this.onError = onError || ((m) => console.error('[dictation]', m));
    this.onCue = onCue || (() => {});

    this.phase = 'idle'; // idle | arming | recording | transcribing | error
    this.threadId = null;
    this.startedAt = 0;
    this.error = null;
    this.handle = null;
    this.cancelled = false;
    // Bumped by every start() and cancel(). Async work compares the token it
    // captured against this one before it does anything visible, so a result
    // that arrives after its hold was abandoned is dropped rather than applied.
    this.token = 0;
    this.armTimer = null;
    this.maxTimer = null;
    this.errorTimer = null;
  }

  emit() {
    this.onState({
      phase: this.phase,
      threadId: this.threadId,
      startedAt: this.startedAt,
      error: this.error,
    });
  }

  set(phase, error = null) {
    this.phase = phase;
    this.error = error;
    this.emit();
  }

  // Held down. `threadId` is captured here and used for the whole round trip:
  // the transcript belongs to the conversation that was open when the words
  // were spoken, not to whichever one is open when they come back.
  //
  // `immediate` skips the arming window. That window exists only because the
  // push-to-talk key on macOS is Command, which is also the first half of ⌘C and
  // ⌘V (see the header) — a deliberate press of the button has no such ambiguity
  // to wait out, and waiting anyway would just read as lag.
  start(threadId, { immediate = false } = {}) {
    // A second hold mid-flight is not a second recording. A hold over a still
    // visible error is, though — an error that has to time out before you can
    // try again reads as the feature being broken rather than one attempt.
    if (this.phase !== 'idle' && this.phase !== 'error') return;
    this.token += 1;
    const token = this.token;
    this.threadId = threadId;
    this.cancelled = false;
    clearTimeout(this.errorTimer);
    this.set('arming');
    if (immediate) this.arm(token);
    else this.armTimer = setTimeout(() => this.arm(token), ARM_MS);
  }

  // Tapped rather than held: start if idle, stop if recording.
  //
  // The two gestures share every other piece of machinery — the same token, the
  // same cap, the same round trip — because the difference between them is only
  // what ends the recording, and duplicating the rest is how they would drift.
  // A tap while transcribing does nothing: the words are already on their way,
  // and the button is disabled in that state anyway.
  toggle(threadId) {
    if (this.phase === 'arming' || this.phase === 'recording') this.stop();
    else if (this.phase === 'idle' || this.phase === 'error') {
      this.start(threadId, { immediate: true });
    }
  }

  async arm(token) {
    if (token !== this.token || this.phase !== 'arming') return;
    // The cue plays before the mic opens, so it is a prompt to start speaking
    // rather than the first thing the recording contains.
    this.onCue('transmit');
    this.startedAt = Date.now();
    this.set('recording');
    let handle;
    try {
      handle = await this.record(this.getDevices());
    } catch (err) {
      if (token !== this.token) return;
      this.fail(`Cannot open the microphone: ${err.message}`);
      return;
    }
    // Released while getUserMedia was still pending — stop() had no handle to
    // act on, so honour it here instead of leaving the mic live.
    if (token !== this.token || this.cancelled) {
      handle.cancel();
      if (token === this.token) this.reset();
      return;
    }
    this.handle = handle;
    this.maxTimer = setTimeout(() => this.stop(), MAX_DICTATION_MS);
  }

  // Released.
  async stop() {
    if (this.phase === 'idle' || this.phase === 'transcribing') return;
    this.cancelled = true;
    clearTimeout(this.armTimer);
    clearTimeout(this.maxTimer);

    const handle = this.handle;
    this.handle = null;
    // Let go inside the arm window: no recorder was ever started, which is the
    // whole point of the window. Silent — a shortcut is not a failed dictation.
    if (!handle) {
      this.reset();
      return;
    }

    const token = this.token;
    const threadId = this.threadId;
    this.set('transcribing');
    try {
      const clip = await handle.stop();
      // Shorter than MIN_DURATION_MS, or empty. A tap is not a message.
      if (!clip) {
        if (token === this.token) this.reset();
        return;
      }
      const bytes = await this.encode(clip.blob);
      if (!bytes) {
        if (token === this.token) this.reset();
        return;
      }
      const text = await this.transcribe(bytes);
      if (token !== this.token) return;
      const trimmed = (text || '').trim();
      this.reset();
      if (trimmed) this.onResult(trimmed, threadId);
    } catch (err) {
      if (token !== this.token) return;
      this.fail(err.message);
    }
  }

  fail(message) {
    this.startedAt = 0;
    this.set('error', message);
    this.onError(message);
    // Cleared on its own: the card sits beside a conversation and a stale error
    // there reads as a broken feature rather than a failed attempt.
    clearTimeout(this.errorTimer);
    this.errorTimer = setTimeout(() => {
      if (this.phase === 'error') this.reset();
    }, ERROR_CLEAR_MS);
  }

  reset() {
    this.phase = 'idle';
    this.threadId = null;
    this.startedAt = 0;
    this.error = null;
    this.emit();
  }

  // Teardown. Invalidates anything in flight and always releases the mic.
  cancel() {
    this.token += 1;
    this.cancelled = true;
    clearTimeout(this.armTimer);
    clearTimeout(this.maxTimer);
    clearTimeout(this.errorTimer);
    try {
      this.handle?.cancel();
    } catch {}
    this.handle = null;
    this.reset();
  }
}
