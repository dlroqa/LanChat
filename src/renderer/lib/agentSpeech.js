import { useEffect, useMemo, useRef, useState } from 'react';
import { audioContext } from './sounds.js';
import { clampVolume } from './agentMusic.js';
import {
  VOICES,
  USER_VOICE,
  voicesFor,
  ringVoices,
  localVoicesFor,
  localUserVoice,
  voiceForTurn,
} from './agentVoice.js';

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
export const XAI = 'xai';
export const KOKORO = 'kokoro';
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

// How many words are in a string. A word is any run of non-space, which is what
// SpeechSynthesisUtterance's `word` boundary counts and what the bubble splits on
// to highlight — so the count here and the ranges there index the same words.
function wordsIn(s) {
  return (String(s == null ? '' : s).match(/\S+/g) || []).length;
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
    this.engine = null; // GEMINI | XAI | LOCAL | null
    // Whether a turn is being fetched right now. True only across the online
    // synthesis await in _speak, so the transport can show a loading bar for the
    // gap where the reading says "playing" but no sound has arrived yet. A cache
    // hit sets and clears it within a tick and never draws the bar — see the CSS
    // delay on .transport-load.
    this.pending = false;
    // Whether to synthesise the whole session before playing a word, so a
    // read-through has no gap between turns. A preference, set from Settings.
    this.preload = false;
    // The progress of that pre-synthesis while it runs: { done, total }, or null
    // when there is none. Distinct from `pending`, which is the per-turn gap of
    // an ordinary reading — the two never show at once.
    this.prefetch = null;
    // Which word of the current turn is being spoken, for the highlight that
    // traces the voice across the bubble. -1 is "no word": nothing is speaking,
    // or the turn just changed and the first boundary has not fired yet. Exact on
    // the local path (a boundary event per word) and estimated from audio time on
    // the online paths, which return one file with no timings. `_wordWeights`
    // holds the per-word char cumulatives the online estimate reads.
    this.wordAt = -1;
    this._wordWeights = null;
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
    // A piece of a turn, or a whole turn, that ended while the reading was
    // paused — and what should happen when it is resumed.
    //
    // The platform voice cannot be relied on to stop when it is told to:
    // speechSynthesis.pause() is a no-op on some engines and lets the utterance
    // already in flight run to its end on others, so `onend` arrives after a
    // pause more often than not. Nothing may move on the back of it. Without
    // this, pausing on the last piece of a turn started the *next* turn — the
    // reading carried on with the button saying it had stopped, and the cursor
    // walked forward under a paused transport.
    //
    // So the boundary is remembered rather than acted on, and resume() does what
    // it would have done. 'chunk' is more of this turn to say; 'turn' is that
    // this one is over and the next is due.
    this.held = null; // 'chunk' | 'turn' | null

    this.el = null;
    this.source = null;
    this.gain = null;
    // The tap the transport's meter reads, built lazily with the rest of the
    // graph. Optional: a context that cannot make one is a meter that stays
    // dark, never a session that will not speak. See _build().
    this.analyser = null;
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

    // What the transport's meter reads, and the only thing it reads.
    //
    // Built once, here, and never replaced, so the component holding it can keep
    // it for the life of the panel and start its animation loop once rather than
    // tearing one down and building another on every render.
    //
    // Nothing in it goes through React. _announce() re-renders the whole side
    // panel, and a meter that announced itself sixty times a second would
    // re-render it sixty times a second to paint a picture React is not
    // painting. The loop asks these questions per frame instead, straight off
    // the instance.
    this.tap = {
      // Which face the meter should be showing right now.
      //
      //   'signal' — an online voice through the graph, with an analyser to read
      //   'blind'  — the platform voice, which has no node in the graph at all
      //   'off'    — nothing to draw, and the row belongs to the loading bar
      //
      // `pending` and `prefetch` are 'off' on purpose: a turn being synthesised
      // is the bar's job, and the two must never be lit at once. The component
      // gates on the same rule from the React side; this is the half that cannot
      // lag a tick behind what is actually making noise.
      face: () => {
        if (this.status !== PLAYING || this.pending || this.prefetch) return 'off';
        if (this.mode === 'url' && this.analyser) return 'signal';
        return this.mode ? 'blind' : 'off';
      },
      // How big the caller's buffers must be. Two different lengths, and they are
      // not interchangeable: the FFT reports fftSize/2 bins, the time domain
      // reports fftSize samples.
      bins: () => this.analyser?.frequencyBinCount || 0,
      samples: () => this.analyser?.fftSize || 0,
      // Hz per bin comes from the device's real rate, which is 44.1k on some
      // machines and 48k on others — a mapping that assumed one would put the
      // whole spectrum in the wrong place on the other.
      rate: () => this.analyser?.context?.sampleRate || 48000,
      // Filled in place, never allocated: this is called every frame.
      read: (freq, time) => {
        const a = this.analyser;
        if (!a) return false;
        try {
          if (freq) a.getByteFrequencyData(freq);
          if (time) a.getByteTimeDomainData(time);
          return true;
        } catch {
          return false;
        }
      },
      // The platform voice fires a boundary per word, and that is a real signal
      // even though its audio is out of reach — the blind face pulses on it, so
      // what is drawn there still moves with the speech rather than being an
      // animation playing beside it.
      word: () => this.wordAt,
    };
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
      this._setPending(false);
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
    const from = at >= 0 ? at : 0;
    // With the preference on, warm the whole run first so nothing between the
    // turns is silent. Only worth it when there is an engine to fetch from — a
    // local reading has no gap to close, and _preloadThenPlay would await nothing.
    if (this.preload && this.synthesize) return this._preloadThenPlay(from);
    return this._goto(from);
  }

  // A turn has just been said, live. Read it only if nothing else is being read
  // — anything already under way reaches it in its own time, because it is
  // already in the list.
  //
  // Takes the whole turn, not just its id, and inserts it if the list does not
  // have it yet. That is the difference between this working and not: an arriving
  // turn is spoken from the message-arrived handler, in the same tick the message
  // is appended, before React has committed and before the sync effect has added
  // it to the list. Looking it up by id alone found nothing and gave up silently
  // (the live-reading regression). Inserting it here restores what the old queue
  // did. When sync runs a moment later it finds this same turn by id and keeps
  // the cursor on it, so the manual insert and the reconciliation agree.
  speakNow(turn) {
    if (this.status !== IDLE) return false;
    const id = turn && typeof turn === 'object' ? turn.id : turn;
    let at = this.list.findIndex((t) => t.id === id);
    if (at < 0) {
      const built = toTurn(turn);
      // A bare id with no turn behind it, or a full list: nothing to speak, same
      // answer this used to give.
      if (!built || this.list.length >= MAX_LIST) return false;
      this.list.push(built);
      this.seen.add(built.id);
      at = this.list.length - 1;
      this._announce();
    }
    return this._goto(at);
  }

  // Silence, without forgetting.
  //
  // The middle answer between pause and clear, and the one that was missing. A
  // discussion that was stopped — or paused — wants quiet *now*, but the list it
  // was reading is still the session on screen, and the transport must stay
  // live: press play and it carries on from the turn it was on.
  //
  // clear() is not that answer and never was. It empties the list, an empty list
  // is `empty` in Transport, and `empty` disables all three buttons and says
  // "Nothing to read yet" — which is why the transport went dead the moment a
  // discussion ended and only came back by leaving the session and returning.
  // clear() keeps its own job below: a different session, or the feature
  // switched off, where nothing of this reading survives.
  //
  // The cursor stops with the sound, in the same tick: _stopAudio() puts the
  // spoken-word trace out, and the generation bump means a boundary or a time
  // update arriving a moment later cannot light one again.
  stop() {
    // Already quiet. Worth the early return rather than the tidier
    // unconditional version: round views arrive several times a second while a
    // discussion runs, and _setStatus announces on every call, so a stop that
    // does nothing would still redraw the panel each time.
    if (this.status === IDLE) return false;
    // Everything in flight belongs to a reading nobody is listening to now: the
    // synthesis being awaited in _speak, the pre-synthesis loop, an `onend`
    // about to advance the cursor. One bump lands all three in a window that has
    // moved on, exactly as _goto's does.
    this.gen += 1;
    this._stopAudio();
    this._setStatus(IDLE);
    return true;
  }

  // Everything stops and nothing is remembered. Called when the session changes
  // and when the setting goes off — both of which mean the same thing: this
  // reading is not the one anybody is going to come back to.
  clear() {
    this.gen += 1;
    this._stopAudio();
    this.list = [];
    this.seen.clear();
    this.index = 0;
    this.engine = null;
    this._setPending(false);
    this.sessionId = null;
    this._setStatus(IDLE);
  }

  // ------------------------------------------------------------- the transport

  // Play, pause, or carry on — whichever the button means right now.
  toggle() {
    // Pressed while the session is still being pre-synthesised, the button means
    // "stop preparing". Cancelled to a standstill rather than paused: a
    // half-warmed run has nowhere to carry on from, and the list is kept so play
    // can start it again. The generation bump stops the loop at its next await.
    if (this.prefetch) {
      this.gen += 1;
      this._stopAudio();
      this._setStatus(IDLE);
      return false;
    }
    if (this.status === PLAYING) return this.pause();
    if (this.status === PAUSED) return this.resume();
    if (!this.list.length) return false;
    // A finished reading starts again from the top rather than replaying its
    // last turn, which is what pressing play on a finished thing should do.
    const from = this.index >= this.list.length ? 0 : this.index;
    if (this.preload && this.synthesize) return this._preloadThenPlay(from);
    return this._goto(from);
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
    // What finished while nothing was supposed to be happening. Taken before the
    // status moves, because both branches below act as a reading that is running
    // again.
    const held = this.held;
    this.held = null;
    this._setStatus(PLAYING);
    // The turn ended under the pause. Carrying on means the *next* turn, and
    // _finish is what knows whether there is one — it also arms the cap itself,
    // by way of _goto, so nothing is armed here.
    if (held === 'turn') {
      this._finish();
      return true;
    }
    this._arm();
    // A piece of the turn ended under the pause. synth.resume() cannot resume an
    // utterance that has already finished — that is the whole reason the reading
    // used to run on instead of holding — so the next piece is spoken outright.
    if (held === 'chunk') {
      this._speakChunk();
      return true;
    }
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
      this.analyser?.disconnect();
      this.gain?.disconnect();
      this.source?.disconnect();
    } catch {}
    this.el = null;
    this.source = null;
    this.gain = null;
    this.analyser = null;
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

  // Synthesise every turn from `from` to the end before playing a word, so a
  // read-through has no silent gap between turns. Each fetch warms main's disk
  // cache; the ordinary playback that follows reads from it in a tick, which is
  // why _goto below is the plain one — the gap it would have shown is already
  // gone. Cancellable at every await: a session change, a skip or the button
  // (see toggle) bumps the generation, and the loop leaves without playing.
  async _preloadThenPlay(from) {
    const gen = (this.gen += 1);
    this._stopAudio();
    this.index = from;
    // A reading is under way even while it is being prepared: this ducks the
    // music once, lights the first turn, and shows the pause button.
    this._setStatus(PLAYING);
    const total = this.list.length - from;
    this._setPrefetch({ done: 0, total });
    for (let i = from; i < this.list.length; i += 1) {
      if (gen !== this.gen) return;
      const turn = this.list[i];
      try {
        await this.synthesize(turn.text, turn.voice);
      } catch {
        // A turn that will not synthesise is one that reads locally at play time,
        // exactly as it would without this pass. Not a reason to abandon the rest.
      }
      if (gen !== this.gen) return;
      this._setPrefetch({ done: i - from + 1, total });
    }
    if (gen !== this.gen) return;
    // Everything is warm. Play it the ordinary way, from the top of the run.
    this._goto(from);
  }

  async _speak(turn, gen) {
    // What synthesize returns: a { url, engine } pair for an online turn, a bare
    // url string for a caller that does not report an engine (the Settings
    // audition), or null for "use the window's own voice". Both shapes are read
    // below so an older caller keeps working.
    let out = null;
    if (this.synthesize) {
      // A turn is being fetched. The transport shows a loading bar for exactly
      // this gap — the reading says "playing" but no sound has arrived yet.
      this._setPending(true);
      try {
        out = await this.synthesize(turn.text, turn.voice);
      } catch {
        out = null;
      } finally {
        // Cleared only if this synthesis is still the one being waited on. A
        // cursor that moved started another _speak which now owns the loading
        // state, and clearing it here would blank a bar that belongs to the next
        // turn. An abandoned synthesis needs no clearing: the _stopAudio that
        // abandoned it already reset the flag.
        if (gen === this.gen) this._setPending(false);
      }
    }
    // The cursor moved, or the session did, while the engine was thinking.
    // Whatever came back belongs to a turn nobody is waiting for.
    if (gen !== this.gen) return;
    // Paused before the audio arrived: hold it rather than overriding somebody
    // who has just asked for quiet.
    if (this.status === IDLE) return;

    const url = typeof out === 'string' ? out : out?.url || null;
    const engine = typeof out === 'string' ? null : out?.engine || null;
    if (url) this._playUrl(url, engine, turn);
    else this._playLocal(turn);
  }

  // The cumulative character count at the end of each word of a turn, and the
  // total — what the online estimate reads to turn an audio position into a word.
  // Weighting by characters rather than counting words evenly makes a long word
  // hold the highlight longer than a short one, which is roughly how a voice
  // spends its time. Null when there is nothing to weigh.
  _weighWords(text) {
    const words = String(text == null ? '' : text).match(/\S+/g) || [];
    if (!words.length) return null;
    const ends = [];
    let sum = 0;
    for (const w of words) {
      sum += w.length;
      ends.push(sum);
    }
    return { ends, total: sum };
  }

  _playUrl(url, engine, turn) {
    if (!this._build()) {
      this._finish();
      return;
    }
    this.mode = 'url';
    // Audio came back from an online engine. Which one is recorded from what main
    // answered — not read off the setting, which can say xAI while the key is
    // missing, and a fallback would then name the wrong voice. The default holds
    // only for a caller that reports no engine (the Settings audition), whose
    // engine field the transport never shows.
    this.engine = engine || GEMINI;
    try {
      this.el.src = url;
      this.gain.gain.value = this.volume;
      const done = () => this._finish();
      this.el.onended = done;
      // A file that will not decode is a turn skipped, not a reading stopped.
      this.el.onerror = done;
      // The online engines return one file with no word timings, so the word
      // being spoken is estimated from how far through the audio we are, weighted
      // by word length. Coarse — timeupdate fires a few times a second — but
      // enough to trace the voice. Guarded so a stale element cannot light a word
      // in a turn that has moved on.
      this._wordWeights = this._weighWords(turn?.text);
      const gen = this.gen;
      this.el.ontimeupdate = () => {
        if (gen !== this.gen || this.status !== PLAYING || !this._wordWeights) return;
        const dur = this.el.duration;
        if (!dur || !isFinite(dur)) return;
        const target = (this.el.currentTime / dur) * this._wordWeights.total;
        const { ends } = this._wordWeights;
        let i = 0;
        while (i < ends.length - 1 && ends[i] < target) i += 1;
        this._setWordAt(i);
      };
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
    // How many words come before each chunk, so a boundary event's word index
    // within its chunk can be turned into an index into the whole turn. Cuts fall
    // on spaces (see chunkText), so no word is split across chunks and the sum is
    // exact.
    this.chunkWordBase = [];
    let base = 0;
    for (const c of this.chunks) {
      this.chunkWordBase.push(base);
      base += wordsIn(c);
    }
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
        // Told to stop, and it finished anyway. Nothing moves on the back of an
        // event the platform should not have sent: the boundary is remembered
        // and resume() acts on it. See `held` in the constructor for why this
        // arrives at all.
        if (this.status === PAUSED) {
          this.held = this.chunkAt < this.chunks.length ? 'chunk' : 'turn';
          return;
        }
        if (this.chunkAt < this.chunks.length && this.status !== IDLE) this._speakChunk();
        else if (this.chunkAt >= this.chunks.length) this._finish();
      };
      u.onend = done;
      u.onerror = done;
      // The word being spoken, exact: the platform fires a `word` boundary as it
      // reaches each one, with the character it starts at within this chunk. The
      // words before this chunk plus the words before that character give the
      // index into the whole turn that the bubble highlights.
      u.onboundary = (e) => {
        if (gen !== this.gen || this.status !== PLAYING || (e && e.name && e.name !== 'word')) return;
        const within = wordsIn(this.chunks[this.chunkAt].slice(0, e ? e.charIndex : 0));
        this._setWordAt((this.chunkWordBase[this.chunkAt] || 0) + within);
      };
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
      // The tap the transport's meter draws from, after the gain rather than
      // before it, so what the meter shows is what is coming out of the speakers
      // — the volume slider moves it, which is the honest answer.
      //
      // Optional, and the audio does not depend on it. A context with no
      // createAnalyser falls through to the plain chain below and everything
      // plays exactly as it did; an analyser that will not build is a meter that
      // stays dark, not a session that will not speak.
      //
      // 2048 rather than the 512 audioMeter.js uses, and for a different job:
      // that one wants a single RMS number, this one draws eighty-odd bars
      // between 120Hz and 7kHz and a waveform band across a 250px canvas. At
      // 48kHz, 512 gives 94Hz bins — too coarse to separate the formants that
      // make a voice look like a voice — and 512 samples, about one per column,
      // which draws a line rather than a band. See lib/speechMeter.js.
      let analyser = null;
      if (typeof audio.createAnalyser === 'function') {
        try {
          analyser = audio.createAnalyser();
          analyser.fftSize = 2048;
          analyser.smoothingTimeConstant = 0.7;
        } catch {
          analyser = null;
        }
      }
      if (analyser) {
        source.connect(gain);
        gain.connect(analyser);
        analyser.connect(audio.destination);
      } else {
        source.connect(gain).connect(audio.destination);
      }
      this.el = el;
      this.source = source;
      this.gain = gain;
      this.analyser = analyser;
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
    // Paused. A turn ending is not permission to start the next one — the
    // cursor stays exactly where the pause left it, and resume() moves it on.
    // Same reason as the hold in _speakChunk: the platform voice ends turns it
    // was told to stop.
    if (this.status === PAUSED) {
      this.held = 'turn';
      return;
    }
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
        this.el.ontimeupdate = null;
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
    // Nothing is waiting to be carried on. A boundary held under a pause belongs
    // to the reading being silenced here, and resuming after a stop must not act
    // on it — which is how stop(), clear() and _goto() all get this for free.
    this.held = null;
    // No turn is in flight once the audio is silenced. _speak arms this again for
    // the one it is about to fetch; anything stopped is not being fetched. A
    // pre-synthesis pass is stopped the same way — this is the one place both
    // loading states are put down, so cancelling a reading cannot leave either on.
    this._setPending(false);
    this._setPrefetch(null);
    // Nothing is being spoken, so no word is lit. The next turn arms it again.
    this._wordWeights = null;
    this._setWordAt(-1);
  }

  // Which word is being spoken, announced only when it changes so the bubble
  // re-highlights once per word rather than on every boundary or time update.
  _setWordAt(n) {
    if (n === this.wordAt) return;
    this.wordAt = n;
    this._announce();
  }

  // The loading state, announced only when it changes so a cache hit — which sets
  // it true and false within a tick — cannot drive a render storm.
  _setPending(next) {
    const value = Boolean(next);
    if (value === this.pending) return;
    this.pending = value;
    this._announce();
  }

  // The pre-synthesis progress, announced only when it moves.
  _setPrefetch(next) {
    const same =
      next === this.prefetch ||
      (next && this.prefetch && next.done === this.prefetch.done && next.total === this.prefetch.total);
    if (same) return;
    this.prefetch = next;
    this._announce();
  }

  // Whether to synthesise the whole session before playing it.
  setPreload(v) {
    this.preload = Boolean(v);
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
  // The active provider's roster, or null for Gemini's, which is the one this
  // window holds. xAI's is fetched from its API because its published lists
  // disagree with each other.
  ring = null,
  // Synthesise the whole session before playing it, so a read-through has no gap
  // between turns. A preference, off by default.
  preload = false,
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
  // Who speaks in what, on whichever provider is active. Gemini's ring is the
  // one written down; anything else deals from the roster it was given and keeps
  // its last voice back for you.
  const ringKey = (ring || []).join(' ');
  const dealt = useMemo(
    () =>
      ring && ring.length
        ? ringVoices(ids, ring)
        : { voices: voicesFor(ids), userVoice: USER_VOICE, ring: VOICES },
    [key, ringKey] // eslint-disable-line react-hooks/exhaustive-deps
  );
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

  useEffect(() => {
    player.setPreload(preload);
  }, [player, preload]);

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
      voice: voiceForTurn({ agentId: msg.agentId, mine }, dealt.voices, dealt.ring, dealt.userVoice),
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
  }, [player, enabled, sessionId, turns, key, ringKey, myLocalVoice, localVoices]);

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
    // Whether the next turn is being fetched right now. The transport draws a
    // loading bar for this, so the silent gap between "playing" and the first
    // sound is not mistaken for a reading that has stalled.
    pending: player.pending,
    // The progress of pre-synthesising a whole session before it plays, when
    // that preference is on: { done, total } while it runs, else null. The
    // transport fills the same bar to this proportion and names it.
    prefetch: player.prefetch,
    // Which word of the current turn is being spoken, or -1. The bubble being
    // read lights this word and traces it along as the voice moves.
    wordAt: player.wordAt,
    // The audio the transport's meter draws. Built once with the player and
    // never replaced, so the canvas loop that reads it sixty times a second can
    // be started once and left alone — and so none of that reading goes anywhere
    // near React. See the tap in the constructor.
    meter: player.tap,

    // The live path: an agent has just answered. Built into a turn here and
    // handed whole, so the player can speak it even in the tick before the sync
    // effect has added it to the list — which is the tick this is called in.
    speak: (msg) => (enabled ? player.speakNow(turnOf(msg)) : false),
    // Both buttons. `startId` is the only difference between the transport's
    // play and a bubble's.
    play: (startId = null) => (enabled ? player.playFrom(startId) : false),
    toggle: () => player.toggle(),
    next: () => player.next(),
    prev: () => player.prev(),
    // Quiet now, list kept — see stop(). Deliberately the only way to silence
    // this from outside: clear() belongs to the session-change effect above, and
    // handing it out is exactly how the transport came to be emptied by a
    // discussion ending.
    stop: () => player.stop(),
  };
}
