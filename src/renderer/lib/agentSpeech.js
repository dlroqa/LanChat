import { useEffect, useMemo, useRef, useState } from 'react';
import { audioContext } from './sounds.js';
import { clampVolume } from './agentMusic.js';
import { voicesFor, localVoicesFor } from './agentVoice.js';

// Reading a session's discussion aloud, one turn at a time.
//
// A dialogue puts four agents in a room and keeps them talking for a dozen
// turns. Watching that arrive as text means sitting and reading; this is the
// same discussion listened to instead, each agent in a voice of its own (see
// agentVoice.js for which voice, and why it is the same slot as its colour).
//
// Sessions only, deliberately. A thread with a person has an ear at the far end
// already, and an agent answering a direct question is one answer rather than a
// conversation — there is nothing there to follow by listening.
//
// The whole of this file is a queue, and the queue is the feature. Two agents in
// one round answer whenever their transports happen to finish, which is to say
// at the same moment; without somewhere to line them up they would talk over
// each other and neither would be understood. So a turn is spoken, then the next
// one, in the order the answers arrived — which is also the order they are
// written down the screen, so what you hear and what you read agree.
//
// It plays through the same shared AudioContext as everything else in the app
// (see sounds.js), on a gain node of its own, so the volume slider is
// sample-accurate and does not fight the music. Structured like AgentMusic —
// its collaborators are constructor arguments so the state machine can be driven
// by a test with no renderer, no audio device, no network and no key.

// A single turn that never reports finishing must not gag the rest of the
// discussion for the rest of the day. Nothing should hit this: the online path
// is bounded by speech.js's own character cap, and the local path by the
// platform. It is here because a queue that cannot advance is worse than one
// that skips something.
export const MAX_UTTERANCE_MS = 5 * 60 * 1000;

// How many turns may be waiting. A discussion runs to a turn budget, so this is
// never reached in normal use; it exists so that walking away from a long
// session cannot build an unbounded backlog of things to say to an empty room.
export const MAX_QUEUE = 24;

export class AgentSpeech {
  // `synthesize` is the online path: given text and a voice name it resolves to
  // a playable URL, or to null when the online engine is off or unreachable —
  // which is not an error, it is the signal to use the window's own voice.
  constructor({
    synthesize = null,
    context = audioContext,
    element = (url) => new Audio(url),
    synth = typeof window === 'undefined' ? null : window.speechSynthesis,
    utterance = (text) => new SpeechSynthesisUtterance(text),
    onSpeaking = null,
  } = {}) {
    this.synthesize = synthesize;
    this.makeContext = context;
    this.makeElement = element;
    this.synth = synth;
    this.makeUtterance = utterance;
    this.onSpeaking = onSpeaking;

    this.queue = [];
    this.current = null; // the turn being spoken
    this.el = null;
    this.source = null;
    this.gain = null;
    this.timer = null;
    this.volume = 0.9;
    // Ids already queued or spoken in this run, so a re-render or a message
    // arriving twice cannot make an agent say the same thing twice. Bounded by
    // the same rule as the queue.
    this.seen = new Set();
    // Bumped by every clear(). A synthesis in flight when the session changes
    // resolves into a window that has moved on, and this is how it knows to
    // throw its result away rather than speak it. Without it, leaving a session
    // mid-turn would be followed by a sentence from the session you left.
    this.epoch = 0;
    this.speaking = false;
  }

  // ------------------------------------------------------------------ queueing

  // A turn to read out. `id` is the message id; `voice` is the Gemini voice for
  // this agent and `localVoice` the name of the platform voice standing in for
  // it. Returns whether it was taken, which is what the replay button uses to
  // know the click did something.
  enqueue({ id, text, voice, localVoice }) {
    const body = String(text == null ? '' : text).trim();
    if (!body) return false;
    if (id != null) {
      // Already waiting, or being said right now. Checked separately from
      // `seen` because replay() below clears the memory of a turn on purpose,
      // and without this a second press of the button would line the same
      // sentence up twice.
      if (this.current?.id === id || this.queue.some((t) => t.id === id)) return false;
      if (this.seen.has(id)) return false;
      this.seen.add(id);
    }
    if (this.queue.length >= MAX_QUEUE) return false;
    this.queue.push({ id, text: body, voice, localVoice });
    this._pump();
    return true;
  }

  // Saying a turn again, because somebody asked for it.
  //
  // The only difference from enqueue() is that having said it before stops being
  // a reason not to. It still will not stack: a turn already queued or in the
  // middle of being spoken is refused by the check above.
  replay(turn) {
    if (turn?.id != null) this.seen.delete(turn.id);
    return this.enqueue(turn || {});
  }

  // Everything stops and nothing is remembered. Called when the session changes,
  // when a round is stopped or paused, and when the setting goes off — all of
  // which mean the same thing: nobody is listening to this any more.
  clear() {
    this.epoch += 1;
    this.queue = [];
    this.seen.clear();
    this._end();
  }

  setVolume(v) {
    this.volume = clampVolume(v);
    if (this.gain) {
      try {
        this.gain.gain.value = this.volume;
      } catch {}
    }
    // The platform voice has no gain node to follow the slider; its volume is
    // fixed for the utterance in flight and picked up by the next one.
  }

  dispose() {
    this.clear();
    try {
      this.gain?.disconnect();
      this.source?.disconnect();
    } catch {}
    this.el = null;
    this.source = null;
    this.gain = null;
  }

  // ------------------------------------------------------------------ speaking

  async _pump() {
    if (this.current || !this.queue.length) return;
    const turn = this.queue.shift();
    this.current = turn;
    this._setSpeaking(true);

    const epoch = this.epoch;
    let url = null;
    if (this.synthesize) {
      try {
        url = await this.synthesize(turn.text, turn.voice);
      } catch {
        url = null;
      }
    }
    // The session moved on while Gemini was thinking. Whatever came back belongs
    // to a discussion nobody is watching.
    if (epoch !== this.epoch) return;

    if (url) this._playUrl(url);
    else this._playLocal(turn);
  }

  _playUrl(url) {
    if (!this._build()) {
      this._finish();
      return;
    }
    try {
      this.el.src = url;
      this.gain.gain.value = this.volume;
      const done = () => this._finish();
      this.el.onended = done;
      // A file that will not decode is a turn skipped, not a queue stopped.
      this.el.onerror = done;
      this._arm();
      const p = this.el.play();
      if (p && typeof p.catch === 'function') p.catch(() => this._finish());
    } catch {
      this._finish();
    }
  }

  _playLocal(turn) {
    if (!this.synth) {
      this._finish();
      return;
    }
    try {
      const u = this.makeUtterance(turn.text);
      u.volume = this.volume;
      // The platform's voices are objects, not names, so the caller passes the
      // name it chose and it is matched here against what the window has now —
      // the list can arrive late, and a voice that has gone is a default voice
      // rather than a failure.
      if (turn.localVoice && typeof this.synth.getVoices === 'function') {
        const found = (this.synth.getVoices() || []).find((v) => v && v.name === turn.localVoice);
        if (found) u.voice = found;
      }
      u.onend = () => this._finish();
      u.onerror = () => this._finish();
      this._arm();
      this.synth.speak(u);
    } catch {
      this._finish();
    }
  }

  // Built on first use, so a window where nothing is ever spoken never claims the
  // output device. Same reasoning as AgentMusic._build().
  _build() {
    if (this.el) return true;
    try {
      const audio = this.makeContext();
      if (!audio) return false;
      const el = this.makeElement('');
      el.preload = 'auto';
      const source = audio.createMediaElementSource(el);
      const gain = audio.createGain();
      gain.gain.value = this.volume;
      source.connect(gain).connect(audio.destination);
      this.el = el;
      this.source = source;
      this.gain = gain;
      return true;
    } catch {
      // Audio unavailable — never let a voice break a session.
      return false;
    }
  }

  _arm() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this._finish();
    }, MAX_UTTERANCE_MS);
  }

  // This turn is over, however it ended. On to the next.
  _finish() {
    if (!this.current) return;
    this.current = null;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.queue.length) {
      this._pump();
      return;
    }
    this._setSpeaking(false);
  }

  // Stopping whatever is making noise right now, without advancing the queue.
  _end() {
    clearTimeout(this.timer);
    this.timer = null;
    this.current = null;
    try {
      if (this.el) {
        this.el.onended = null;
        this.el.onerror = null;
        this.el.pause();
      }
    } catch {}
    try {
      this.synth?.cancel();
    } catch {}
    this._setSpeaking(false);
  }

  // One announcement per change, not per turn: a discussion of twelve turns
  // should duck the music once and lift it once, not flap it twelve times.
  _setSpeaking(on) {
    const next = Boolean(on);
    if (next === this.speaking) return;
    this.speaking = next;
    try {
      this.onSpeaking?.(next);
    } catch {}
  }
}

// What Settings says when you press the play button. Long enough to hear the
// character of a voice rather than just that sound comes out, and it says what
// the feature is so an audition doubles as an explanation.
export const PREVIEW_LINE = 'This is how an agent will sound when it takes its turn in a discussion.';

// Auditions a voice with the same player the real thing uses, so what you hear
// in Settings is what a session sounds like. Returns the stop function, exactly
// as previewTrack does in agentMusic.js.
export function previewVoice({ synthesize = null, voice = null, volume = 0.9, text = PREVIEW_LINE } = {}) {
  const player = new AgentSpeech({ synthesize });
  player.setVolume(volume);
  player.enqueue({ id: 'preview', text, voice });
  return () => player.dispose();
}

// ---------------------------------------------------------------- the window
//
// What the platform can say, and in which voices. getVoices() is famously empty
// on the first call in a fresh window and filled in later behind a
// `voiceschanged` event, so this waits for it rather than asking once and
// concluding the machine has no voices.
export function useLocalVoices(enabled) {
  const [voices, setVoices] = useState([]);

  useEffect(() => {
    if (!enabled) return undefined;
    const synth = typeof window === 'undefined' ? null : window.speechSynthesis;
    if (!synth || typeof synth.getVoices !== 'function') return undefined;
    const read = () => setVoices(synth.getVoices() || []);
    read();
    synth.addEventListener?.('voiceschanged', read);
    return () => synth.removeEventListener?.('voiceschanged', read);
  }, [enabled]);

  return voices;
}

// The queue, wired to a session.
//
// `agentIds` is everybody in the discussion, which is what makes the voices
// distinct rather than merely stable — see agentVoice.js. `sessionId` is the
// thread being listened to; changing it clears the queue, because a sentence
// from the session you just left is the one thing this must never do.
export function useAgentSpeech({
  enabled = false,
  volume = 0.9,
  sessionId = null,
  agentIds = null,
  synthesize = null,
} = {}) {
  const ref = useRef(null);
  const [speaking, setSpeaking] = useState(false);
  const vol = clampVolume(volume);
  const localVoices = useLocalVoices(enabled);

  const ids = useMemo(() => [...new Set((agentIds || []).filter(Boolean))].sort(), [agentIds]);
  const key = ids.join(' ');

  // Who speaks in what. Recomputed only when the cast changes, and both rings at
  // once so the online and local paths agree about which agent is which.
  const voices = useMemo(() => voicesFor(ids), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const locals = useMemo(
    () => localVoicesFor(ids, localVoices, typeof navigator === 'undefined' ? null : navigator.language),
    [key, localVoices] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Held in a ref so a re-render caused by anything else cannot rebuild the
  // player and drop a queue mid-discussion.
  const synthRef = useRef(synthesize);
  synthRef.current = synthesize;

  if (!ref.current) {
    ref.current = new AgentSpeech({
      synthesize: (text, voice) => synthRef.current?.(text, voice) ?? null,
      onSpeaking: setSpeaking,
    });
  }

  useEffect(() => {
    ref.current?.setVolume(vol);
  }, [vol]);

  // Leaving the session, or switching the feature off, stops it talking.
  useEffect(() => {
    ref.current?.clear();
  }, [sessionId, enabled]);

  useEffect(
    () => () => {
      ref.current?.dispose();
      ref.current = null;
    },
    []
  );

  const turnOf = ({ id, text, agentId }) => ({
    id,
    text,
    voice: voices.get(agentId) || null,
    localVoice: locals.get(agentId) || null,
  });

  const speak = (msg) => (enabled && ref.current ? ref.current.enqueue(turnOf(msg)) : false);
  const replay = (msg) => (enabled && ref.current ? ref.current.replay(turnOf(msg)) : false);
  const clear = () => ref.current?.clear();

  return { speak, replay, clear, speaking };
}
