import { useEffect, useMemo, useRef, useState } from 'react';
import { audioContext } from './sounds.js';
import { clampVolume } from './agentMusic.js';
import { voicesFor, localVoicesFor, localUserVoice, voiceForTurn } from './agentVoice.js';

// Reading a session aloud, turn by turn.
//
// A dialogue puts four agents in a room and keeps them talking for a dozen
// turns. Watching that arrive as text means sitting and reading; this is the
// same conversation listened to instead, each agent in a voice of its own (see
// agentVoice.js for which voice, and why it is the same slot as its colour) and
// your own questions in a voice kept back for you.
//
// Sessions only, deliberately. A thread with a person has an ear at the far end
// already, and an agent answering a direct question is one answer rather than a
// conversation — there is nothing there to follow by listening.
//
// **This is a track list with a cursor, not a queue.** It began as a queue, and
// a queue can only go forwards: it could speak a turn as it landed but it could
// never be asked to go back one, which is what a transport needs. So the list is
// the session and `index` is where the reading has got to. Everything follows
// from that — live turns append to the end, the transport moves the cursor, and
// the button on a bubble is the same cursor moved to that bubble. One position
// and one play/pause state, so two controls can never disagree about what is
// speaking.
//
// It plays through the same shared AudioContext as everything else in the app
// (see sounds.js), on a gain node of its own, so the volume slider is
// sample-accurate and does not fight the music. Structured like AgentMusic —
// its collaborators are constructor arguments so the state machine can be driven
// by a test with no renderer, no audio device, no network and no key.

// A single turn that never reports finishing must not gag the rest of the
// session for the rest of the day. Nothing should hit this: the online path is
// bounded by speech.js's own character cap, and the local path by the platform.
// It is here because a reading that cannot advance is worse than one that skips
// something. A paused turn is not subject to it — see pause().
export const MAX_UTTERANCE_MS = 5 * 60 * 1000;

// How long a track list may be. A session's history is bounded at 2000 messages
// by the store, and a list of 500 turns is already some hours of listening; the
// cap is here so that neither a very long session nor a run of live turns can
// grow this without limit.
export const MAX_LIST = 500;

// What the reading is doing. Three states rather than a pair of booleans,
// because "paused" and "idle" differ in exactly one way that matters — a paused
// reading has somewhere to carry on from — and two booleans allow a fourth
// combination that means nothing.
export const IDLE = 'idle';
export const PLAYING = 'playing';
export const PAUSED = 'paused';

// Which voice actually said it. Reported from what happened rather than from the
// setting: Gemini switched on but unreachable still reads locally, and a person
// listening should be told which of the two they are hearing rather than left to
// work it out.
export const GEMINI = 'gemini';
export const LOCAL = 'local';

// How much text goes into one utterance on the local path.
//
// This is a workaround for a named Chromium fault, not a style choice. Long text
// handed to speechSynthesis fails silently *and wedges the API for the whole
// window* (crbug 41346274), after which cancel() and the next speak() do nothing
// — which is what made a session change appear to leave the previous session
// still playing. Agent turns are long, and nothing bounded this path: the cap in
// main/speech.js bounds only what is sent to Gemini.
//
// So a turn is spoken in sentence-sized pieces. Two hundred characters is far
// below where the fault appears, and it also keeps each piece well inside the
// ~15s window after which Chromium stops a long utterance — which is why no
// pause/resume keepalive is needed on top.
export const LOCAL_CHUNK_CHARS = 200;

// How often to ask the synth whether it is still speaking, and how long to wait
// before the first ask.
//
// The watchdog exists because `onend` is not reliable — see the utterance held
// in _playLocal — and an event that never arrives cannot be waited for. The
// grace period is what stops an utterance that has not started yet from being
// mistaken for one that has finished; 100ms is the interval the same workaround
// is documented with elsewhere, for exactly that false positive.
export const SYNTH_POLL_MS = 250;
export const SYNTH_GRACE_MS = 100;

// Splitting a turn into utterance-sized pieces, at sentence ends.
//
// The rule is boundText's in main/speech.js — break after `. `, `! ` or `? ` —
// so the two paths cut text the same way and a turn does not stop mid-clause in
// one engine and not the other. A sentence longer than the budget is broken at
// the last space inside it rather than mid-word, and a single unbroken run of
// characters is cut where it must be.
export function chunkText(raw, limit = LOCAL_CHUNK_CHARS) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return [];
  if (text.length <= limit) return [text];

  const out = [];
  let rest = text;
  while (rest.length > limit) {
    const head = rest.slice(0, limit);
    const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
    // +1 keeps the full stop with the sentence it ends.
    let at = stop > 0 ? stop + 1 : head.lastIndexOf(' ');
    if (at <= 0) at = limit;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

// A turn, in the one shape the list holds. Anything without words is not a turn:
// a file, a notice and an empty string are all things there is nothing to say
// about.
function toTurn(turn) {
  if (!turn) return null;
  const text = String(turn.text == null ? '' : turn.text).trim();
  if (!text) return null;
  return {
    id: turn.id ?? null,
    text,
    voice: turn.voice || null,
    localVoice: turn.localVoice || null,
    mine: turn.mine === true,
  };
}

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
    onChange = null,
    // The watchdog's clock, injectable for the same reason everything else here
    // is: a test should be able to drive it without waiting out real seconds.
    setInterval: setIntervalFn = (fn, ms) => setInterval(fn, ms),
    clearInterval: clearIntervalFn = (id) => clearInterval(id),
    now = () => Date.now(),
  } = {}) {
    this.synthesize = synthesize;
    this.makeContext = context;
    this.makeElement = element;
    this.synth = synth;
    this.makeUtterance = utterance;
    this.onSpeaking = onSpeaking;
    this.onChange = onChange;
    this.setInterval = setIntervalFn;
    this.clearInterval = clearIntervalFn;
    this.now = now;

    this.list = [];
    // Where the reading has got to. Ranges over 0..list.length, and the value
    // one past the end is what "finished" looks like — the ordinary iterator
    // convention, and it is what makes prev() from a finished reading land on
    // the last thing said rather than on nothing.
    this.index = 0;
    this.status = IDLE;
    // Which path is making noise, so resume() knows what to resume.
    this.mode = null; // 'url' | 'local' | null
    // Which voice really said the last thing said — not which one is configured.
    // Gemini switched on but unreachable reads locally, and the window says so
    // rather than leaving somebody to wonder which they are hearing.
    this.engine = null; // GEMINI | LOCAL | null
    // The session this list belongs to. Held here so that being handed a
    // different one is what resets the player, rather than the caller having
    // remembered to clear it first — see sync().
    this.sessionId = null;
    // The utterance being spoken, held so Chromium cannot collect it before it
    // finishes. See _speakChunk.
    this.utterance = null;
    this.chunks = [];
    this.chunkAt = 0;
    this.localVoice = null;
    this.watchdog = null;
    this.chunkDone = null;

    this.el = null;
    this.source = null;
    this.gain = null;
    this.timer = null;
    this.volume = 0.9;
    // Ids already in the list, so a re-render or a message arriving twice cannot
    // put the same turn in it twice.
    this.seen = new Set();
    // Bumped by everything that changes what should be playing. A synthesis in
    // flight when the cursor moves — or when the session changes — resolves into
    // a window that has moved on, and this is how it knows to throw its result
    // away rather than speak it. Without it, pressing Forward twice quickly
    // would be followed by the turn you skipped.
    this.gen = 0;
    this.speaking = false;
  }

  // What the window draws from.
  get count() {
    return this.list.length;
  }

  // The turn being read, or null. Only while there is one: a finished reading
  // has a cursor but nothing to point at.
  get currentTurn() {
    return this.status === IDLE ? null : this.list[this.index] || null;
  }

  get speakingId() {
    return this.currentTurn?.id ?? null;
  }

  // ------------------------------------------------------------------ the list

  // The list is always the whole session, kept current as messages arrive.
  //
  // One list rather than two, and that is the point. An earlier draft had a live
  // queue and a separate "play it all" list, which meant that after a turn had
  // been read live, pressing Forward found an empty list and did nothing — the
  // two controls were looking at different things. Here there is one list and
  // one cursor, so the transport, the bubbles and the live reading are all
  // moving the same thing.
  //
  // The cursor follows the *turn* it was on rather than the index, so a message
  // arriving above it — or an error being swept out of the transcript — cannot
  // silently move the reading onto a different sentence.
  sync(turns, { sessionId = undefined } = {}) {
    // A different session is a different conversation, and nothing of the last
    // one survives it: not the list, not the cursor, not the audio, and not the
    // window's shared synth queue.
    //
    // Done here, by the player, rather than by a caller remembering to clear
    // first. The refresh used to depend on two React effects firing in the right
    // order, which is invisible and easy to break; holding the session next to
    // the list it belongs to makes it a property of the thing itself.
    if (sessionId !== undefined && sessionId !== this.sessionId) {
      this.sessionId = sessionId;
      this.gen += 1;
      this._stopAudio();
      this.list = [];
      this.seen.clear();
      this.index = 0;
      this.engine = null;
      this._setStatus(IDLE);
    }

    const next = (turns || []).map(toTurn).filter(Boolean).slice(0, MAX_LIST);
    const onId = this.currentTurn?.id ?? null;
    const before = this.list.length;
    this.list = next;
    this.seen = new Set(next.map((t) => t.id).filter((id) => id != null));

    if (onId != null) {
      const at = next.findIndex((t) => t.id === onId);
      // The turn being read is gone from the transcript. Stop rather than carry
      // on reading whatever slid into its place.
      if (at < 0) {
        this._stopAudio();
        this.index = Math.min(this.index, next.length);
        this._setStatus(IDLE);
        return;
      }
      this.index = at;
    } else if (this.index > next.length) {
      this.index = next.length;
    }
    if (before !== next.length) this._announce();
  }

  // Read from a given turn, or from the top. What the transport's play button
  // and a bubble's play button both call — the only difference between them is
  // `startId`, which is why the two cannot disagree about what is playing.
  playFrom(startId = null) {
    if (!this.list.length) return false;
    const at = startId == null ? 0 : this.list.findIndex((t) => t.id === startId);
    return this._goto(at >= 0 ? at : 0);
  }

  // A turn has just been said, live. Read it only if nothing else is being read
  // — anything already under way reaches it in its own time, because it is
  // already in the list.
  speakNow(id) {
    if (this.status !== IDLE) return false;
    const at = this.list.findIndex((t) => t.id === id);
    if (at < 0) return false;
    return this._goto(at);
  }

  // Everything stops and nothing is remembered. Called when the session changes,
  // when a round is stopped or paused, and when the setting goes off — all of
  // which mean the same thing: nobody is listening to this any more.
  clear() {
    this.gen += 1;
    this._stopAudio();
    this.list = [];
    this.seen.clear();
    this.index = 0;
    this.engine = null;
    this.sessionId = null;
    this._setStatus(IDLE);
  }

  // ------------------------------------------------------------- the transport

  // Play, pause, or carry on — whichever the button means right now.
  toggle() {
    if (this.status === PLAYING) return this.pause();
    if (this.status === PAUSED) return this.resume();
    if (!this.list.length) return false;
    // A finished reading starts again from the top rather than replaying its
    // last turn, which is what pressing play on a finished thing should do.
    return this._goto(this.index >= this.list.length ? 0 : this.index);
  }

  pause() {
    if (this.status !== PLAYING) return false;
    this._setStatus(PAUSED);
    // Neither clock runs while nothing is being said. Without this, a turn
    // paused for six minutes would be skipped the moment it was resumed, and the
    // watchdog would be polling a synth that is quiet on purpose.
    clearTimeout(this.timer);
    this.timer = null;
    this._stopWatchdog();
    try {
      if (this.mode === 'local') this.synth?.pause();
      else this.el?.pause();
    } catch {}
    return true;
  }

  resume() {
    if (this.status !== PAUSED) return false;
    this._setStatus(PLAYING);
    this._arm();
    try {
      if (this.mode === 'local') {
        this.synth?.resume();
        // The watchdog was stopped while nothing was being said; it goes back on
        // the piece it left, or a chunk whose `onend` never fires would leave a
        // resumed reading stuck exactly as it did before.
        if (this.chunkDone) this._startWatchdog(this.gen, this.chunkDone);
      } else {
        this.el?.play();
      }
    } catch {
      this._finish();
    }
    return true;
  }

  next() {
    return this._goto(this.index + 1);
  }

  prev() {
    return this._goto(this.index - 1);
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

  // Move the cursor and read what it lands on. The single way playback ever
  // starts, so there is one place that decides what "off the end" means.
  _goto(at) {
    this.gen += 1;
    this._stopAudio();
    if (!this.list.length || at < 0 || at >= this.list.length) {
      // Clamped rather than refused: walking off either end leaves the cursor
      // somewhere sensible to come back from.
      this.index = Math.max(0, Math.min(at, this.list.length));
      this._setStatus(IDLE);
      return false;
    }
    this.index = at;
    this._setStatus(PLAYING);
    this._speak(this.list[at], this.gen);
    return true;
  }

  async _speak(turn, gen) {
    let url = null;
    if (this.synthesize) {
      try {
        url = await this.synthesize(turn.text, turn.voice);
      } catch {
        url = null;
      }
    }
    // The cursor moved, or the session did, while Gemini was thinking. Whatever
    // came back belongs to a turn nobody is waiting for.
    if (gen !== this.gen) return;
    // Paused before the audio arrived: hold it rather than overriding somebody
    // who has just asked for quiet.
    if (this.status === IDLE) return;

    if (url) this._playUrl(url);
    else this._playLocal(turn);
  }

  _playUrl(url) {
    if (!this._build()) {
      this._finish();
      return;
    }
    this.mode = 'url';
    // Audio came back, so this turn really was Gemini. Recorded here rather than
    // read off the setting, which can say Gemini while the key is missing.
    this.engine = GEMINI;
    try {
      this.el.src = url;
      this.gain.gain.value = this.volume;
      const done = () => this._finish();
      this.el.onended = done;
      // A file that will not decode is a turn skipped, not a reading stopped.
      this.el.onerror = done;
      // Paused while the audio was being fetched: it is loaded and ready, and
      // resume() will start it. The cap stays unarmed, because nothing is being
      // said for it to be a cap on.
      if (this.status === PAUSED) return;
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
    this.mode = 'local';
    this.engine = LOCAL;
    // Sentence-sized pieces, because a whole agent turn wedges the API. See
    // LOCAL_CHUNK_CHARS.
    this.chunks = chunkText(turn.text);
    this.chunkAt = 0;
    this.localVoice = turn.localVoice || null;
    if (!this.chunks.length) {
      this._finish();
      return;
    }
    if (this.status !== PAUSED) this._arm();
    this._speakChunk();
  }

  // One piece of a turn. Calls itself through to the next, and only the last
  // finishes the turn.
  _speakChunk() {
    const gen = this.gen;
    let u;
    try {
      u = this.makeUtterance(this.chunks[this.chunkAt]);
      u.volume = this.volume;
      // The platform's voices are objects, not names, so the caller passes the
      // name it chose and it is matched here against what the window has now —
      // the list can arrive late, and a voice that has gone is a default voice
      // rather than a failure.
      if (this.localVoice && typeof this.synth.getVoices === 'function') {
        const found = (this.synth.getVoices() || []).find((v) => v && v.name === this.localVoice);
        if (found) u.voice = found;
      }
      const done = () => {
        // The cursor moved, or the session did, while this was being said.
        if (gen !== this.gen) return;
        this._stopWatchdog();
        this.utterance = null;
        this.chunkAt += 1;
        if (this.chunkAt < this.chunks.length && this.status !== IDLE) this._speakChunk();
        else if (this.chunkAt >= this.chunks.length) this._finish();
      };
      u.onend = done;
      u.onerror = done;
      // Kept so resume() can put the watchdog back on the piece it left.
      this.chunkDone = done;

      // **The utterance is held on the instance, and that is the whole of the
      // fix for the reading stopping after the first bubble.** Chromium can
      // garbage-collect an utterance that only its own handlers reference, and
      // when it does, `onend` never fires and nothing ever advances the reading
      // (crbug 41380697). A local variable is exactly that case.
      this.utterance = u;

      // The window has one speechSynthesis queue, shared by everything in it. A
      // wedged or stale utterance left in it is what bled across a session
      // change, so it is emptied before anything new goes in.
      this.synth.cancel();
      this.synth.speak(u);
      if (this.status === PAUSED) this.synth.pause();
      else this._startWatchdog(gen, done);
    } catch {
      this._finish();
    }
  }

  // Asking the synth whether it is still going, because it cannot be relied on
  // to say so. If it reports neither speaking nor pending, the piece is over
  // whatever the events did — see SYNTH_POLL_MS.
  _startWatchdog(gen, done) {
    this._stopWatchdog();
    if (typeof this.synth.speaking !== 'boolean') return;
    const first = this.now() + SYNTH_GRACE_MS;
    this.watchdog = this.setInterval(() => {
      if (gen !== this.gen || this.status !== PLAYING) return;
      // Not yet: an utterance that has not started is not one that has ended.
      if (this.now() < first) return;
      if (this.synth.speaking || this.synth.pending) return;
      done();
    }, SYNTH_POLL_MS);
  }

  _stopWatchdog() {
    if (this.watchdog == null) return;
    this.clearInterval(this.watchdog);
    this.watchdog = null;
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

  // This turn is over, however it ended. On to the next, or done.
  _finish() {
    if (this.status === IDLE) return;
    this._stopAudio();
    if (this.index + 1 < this.list.length) {
      this._goto(this.index + 1);
      return;
    }
    // One past the end: the reading is finished, and prev() still knows where
    // the last thing said was.
    this.index = this.list.length;
    this._setStatus(IDLE);
  }

  // Silence whatever is making noise, without moving the cursor or deciding
  // what happens next.
  _stopAudio() {
    clearTimeout(this.timer);
    this.timer = null;
    this.mode = null;
    this._stopWatchdog();
    try {
      if (this.el) {
        this.el.onended = null;
        this.el.onerror = null;
        this.el.pause();
      }
    } catch {}
    // Dropped only once the synth has been told to stop. Released the other way
    // round, a collected utterance could still fire into a reading that has
    // moved on.
    try {
      this.synth?.cancel();
    } catch {}
    this.utterance = null;
    this.chunkDone = null;
    this.chunks = [];
    this.chunkAt = 0;
  }

  _setStatus(next) {
    this.status = next;
    // The duck is announced only when it changes: a reading of twelve turns
    // should duck the music once and lift it once, not flap it twelve times.
    // Pausing lifts it, because a pause is a request for quiet.
    const speaking = next === PLAYING;
    if (speaking !== this.speaking) {
      this.speaking = speaking;
      try {
        this.onSpeaking?.(speaking);
      } catch {}
    }
    // The window, on the other hand, is told every time — moving from turn three
    // to turn four leaves the status on `playing` and changes the position, the
    // lit bubble and nothing else. Announcing only on a status change would
    // freeze both of those at the first turn.
    this._announce();
  }

  // The window needs redrawing: the icon, the position, which bubble is lit.
  _announce() {
    try {
      this.onChange?.();
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
  player.sync([{ id: 'preview', text, voice }]);
  player.playFrom();
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

// The player, wired to a session.
//
// `agentIds` is the session's **resolved** cast — who it actually asks, which
// for a session set to "all agents" is not what the record stores. Passing the
// stored list is the bug that sent every turn to the local voice however good
// the API key was; voiceForTurn() now guarantees a voice either way, and this
// only decides whether they are all different.
export function useAgentSpeech({
  enabled = false,
  volume = 0.9,
  sessionId = null,
  agentIds = null,
  turns = null,
  synthesize = null,
} = {}) {
  const ref = useRef(null);
  const [, bump] = useState(0);
  const vol = clampVolume(volume);
  const localVoices = useLocalVoices(enabled);

  const ids = useMemo(() => [...new Set((agentIds || []).filter(Boolean))].sort(), [agentIds]);
  const key = ids.join(' ');

  // Who speaks in what. Recomputed only when the cast or the machine's voices
  // change, and both rings at once so the online and local paths agree about
  // which agent is which.
  const voices = useMemo(() => voicesFor(ids), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const lang = typeof navigator === 'undefined' ? null : navigator.language;
  const myLocalVoice = useMemo(() => localUserVoice(localVoices, lang), [localVoices, lang]);
  const locals = useMemo(
    () => localVoicesFor(ids, localVoices, lang, { exclude: myLocalVoice }),
    [key, localVoices, lang, myLocalVoice] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Held in a ref so a re-render caused by anything else cannot rebuild the
  // player and drop a reading half way through.
  const synthRef = useRef(synthesize);
  synthRef.current = synthesize;

  if (!ref.current) {
    ref.current = new AgentSpeech({
      synthesize: (text, voice) => synthRef.current?.(text, voice) ?? null,
      onChange: () => bump((n) => n + 1),
    });
  }
  const player = ref.current;

  useEffect(() => {
    player.setVolume(vol);
  }, [player, vol]);

  // Leaving the session, or switching the feature off, stops it talking.
  useEffect(() => {
    player.clear();
  }, [player, sessionId, enabled]);

  useEffect(
    () => () => {
      ref.current?.dispose();
      ref.current = null;
    },
    []
  );

  // A message as the player wants it. One conversion, used by the live path and
  // by both buttons, so what is spoken cannot depend on which one asked.
  const turnOf = (msg) => {
    const mine = msg.direction === 'out' && !msg.agentId;
    return {
      id: msg.id,
      text: msg.text,
      mine,
      voice: voiceForTurn({ agentId: msg.agentId, mine }, voices),
      localVoice: mine ? myLocalVoice : locals.get(msg.agentId) || myLocalVoice || null,
    };
  };

  // The list follows the conversation. Done in an effect rather than during
  // render because it mutates the player, and re-run whenever the messages or
  // the cast change — a new voice for an agent has to reach turns already in
  // the list, or a cast that resolves late would leave the first few turns
  // speaking in the wrong voice.
  useEffect(() => {
    if (!enabled) return;
    // The session travels with the list. Handing the player a different one is
    // what resets it, so a switch cannot leave the previous session's reading
    // behind however the effects happen to be ordered.
    player.sync((turns || []).map(turnOf), { sessionId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, enabled, sessionId, turns, key, myLocalVoice, localVoices]);

  return {
    status: player.status,
    playing: player.status === PLAYING,
    paused: player.status === PAUSED,
    speakingId: player.speakingId,
    // One-based for reading out: "3 of 12". Clamped, because a finished reading
    // leaves the cursor one past the end.
    position: Math.min(player.index + 1, player.count),
    count: player.count,
    speaking: player.speaking,
    // Which voice actually said the last thing said. Not the setting: Gemini
    // switched on without a usable key still reads locally, and this is what
    // lets the window say so rather than claim otherwise.
    engine: player.engine,

    // The live path: an agent has just answered. The turn is already in the list
    // (the effect above put it there); this only decides whether to start.
    speak: (msg) => (enabled ? player.speakNow(msg.id) : false),
    // Both buttons. `startId` is the only difference between the transport's
    // play and a bubble's.
    play: (startId = null) => (enabled ? player.playFrom(startId) : false),
    toggle: () => player.toggle(),
    next: () => player.next(),
    prev: () => player.prev(),
    clear: () => player.clear(),
  };
}
