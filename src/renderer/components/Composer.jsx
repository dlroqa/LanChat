import React, { useRef, useState, useEffect } from 'react';
import { Send, Paperclip, Mic } from '../lib/icons.jsx';
import { startRecording, pickFormat, formatDuration } from '../lib/voice.js';

// Message composer: auto-growing textarea, Enter to send, attach and voice.
export default function Composer({ onSend, onAttach, onTyping, onVoice, disabled, canAttach = true }) {
  // Recording needs MediaRecorder with an Opus-capable container; hide the
  // affordance entirely where that is missing rather than failing on press.
  const canRecord = Boolean(onVoice) && Boolean(pickFormat());
  const [text, setText] = useState('');
  const ref = useRef(null);
  const typingRef = useRef(false);
  const typingTimer = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  function signalTyping(active) {
    if (active === typingRef.current) return;
    typingRef.current = active;
    onTyping(active);
  }

  function handleChange(e) {
    setText(e.target.value);
    signalTyping(true);
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => signalTyping(false), 1500);
  }

  function submit() {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText('');
    signalTyping(false);
    clearTimeout(typingTimer.current);
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="composer">
      {canAttach && (
        <button className="icon-btn" onClick={onAttach} disabled={disabled} title="Send file, photo or video">
          <Paperclip size={20} />
        </button>
      )}
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={disabled ? 'Peer is offline' : 'Type a message…  (Enter to send, Shift+Enter for newline)'}
        onChange={handleChange}
        onKeyDown={onKeyDown}
        disabled={disabled}
        aria-label="Message"
      />
      {/* The mic replaces Send until there is text to send, so the primary
          action stays unambiguous rather than two buttons competing. */}
      {canRecord && !text.trim() ? (
        <VoiceButton disabled={disabled} onRecorded={onVoice} />
      ) : (
        <button className="send-btn" onClick={submit} disabled={!text.trim()} title="Send">
          <Send size={20} />
        </button>
      )}
    </div>
  );
}

// Hold to record, release to send. Pointer capture is what makes "release
// anywhere" work — without it, letting go outside the button never fires
// pointerup and the microphone would stay open.
function VoiceButton({ disabled, onRecorded }) {
  const [elapsed, setElapsed] = useState(null);
  const handle = useRef(null);
  const timer = useRef(null);
  const cancelled = useRef(false);

  const stopTimer = () => {
    clearInterval(timer.current);
    timer.current = null;
    setElapsed(null);
  };

  // A recording must never outlive the component, or the mic stays live.
  useEffect(() => () => {
    handle.current?.cancel();
    clearInterval(timer.current);
  }, []);

  async function begin(e) {
    if (disabled || handle.current) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    cancelled.current = false;
    try {
      handle.current = await startRecording();
    } catch (err) {
      onRecorded(null, err);
      return;
    }
    // Released before the mic opened — don't start a recording nobody wants.
    if (cancelled.current) {
      handle.current.cancel();
      handle.current = null;
      return;
    }
    const started = Date.now();
    setElapsed(0);
    timer.current = setInterval(() => setElapsed(Date.now() - started), 200);
  }

  async function end() {
    cancelled.current = true;
    const h = handle.current;
    if (!h) return;
    handle.current = null;
    stopTimer();
    const result = await h.stop();
    if (result) onRecorded(result);
  }

  return (
    <button
      className={`send-btn voice-btn ${elapsed != null ? 'recording' : ''}`}
      disabled={disabled}
      onPointerDown={begin}
      onPointerUp={end}
      onPointerCancel={end}
      title="Hold to record a voice message"
      aria-label="Hold to record a voice message"
    >
      {elapsed != null ? <span className="voice-timer">{formatDuration(elapsed)}</span> : <Mic size={20} />}
    </button>
  );
}
