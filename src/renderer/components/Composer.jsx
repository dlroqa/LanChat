import React, { useRef, useState, useEffect } from 'react';
import { Send, Paperclip, Mic, FileIcon, X } from '../lib/icons.jsx';
import { startRecording, pickFormat, formatDuration } from '../lib/voice.js';
import { formatBytes } from '../lib/util.js';

// Message composer: auto-growing textarea, Enter to send, attach and voice.
export default function Composer({
  draft,
  onSend,
  onAttach,
  onTyping,
  onVoice,
  disabled,
  offline = false,
  canAttach = true,
  attachTitle = 'Send file, photo or video',
  // Documents staged against the next message. Held by App rather than here,
  // because a file can also arrive by being dropped anywhere on the window.
  docs = [],
  onRemoveDoc,
  placeholder,
}) {
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

  // A refused message comes back here rather than being lost. Keyed on the nonce
  // and not the text, so asking the same thing twice restores it twice — and the
  // cursor goes to the end, since the likely next move is to add to it, not to
  // start over.
  useEffect(() => {
    if (!draft) return;
    setText(draft.text);
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(draft.text.length, draft.text.length);
  }, [draft?.nonce]);

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

  // A document on its own is a complete thing to send — "here, read this" — so
  // the send is allowed with no words, but never with neither.
  const canSend = Boolean(text.trim() || docs.length);

  function submit() {
    if (!canSend) return;
    onSend(text.trim());
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
    <div className="composer-wrap">
      {/* Staged documents sit above the input rather than inside it: they are
          part of the message being written, and stay visible while it is. */}
      {docs.length > 0 && (
        <div className="composer-docs">
          {docs.map((doc) => (
            <span key={doc.path} className="composer-doc" title={doc.path}>
              <FileIcon size={14} />
              <span className="composer-doc-name">{doc.name}</span>
              <span className="composer-doc-size">{formatBytes(doc.bytes)}</span>
              <button
                className="composer-doc-remove"
                onClick={() => onRemoveDoc(doc.path)}
                title={`Remove ${doc.name}`}
                aria-label={`Remove ${doc.name}`}
              >
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer">
        {canAttach && (
          <button className="icon-btn" onClick={onAttach} disabled={disabled} title={attachTitle}>
            <Paperclip size={20} />
          </button>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={
            disabled
              ? 'Unavailable'
              : offline
                ? 'They are offline — your message will send when they are back'
                : placeholder || 'Type a message…  (Enter to send, Shift+Enter for newline)'
          }
          onChange={handleChange}
          onKeyDown={onKeyDown}
          disabled={disabled}
          aria-label="Message"
        />
        {/* The mic replaces Send until there is something to send, so the
            primary action stays unambiguous rather than two buttons competing. */}
        {canRecord && !canSend ? (
          <VoiceButton disabled={disabled} onRecorded={onVoice} />
        ) : (
          <button className="send-btn" onClick={submit} disabled={!canSend} title="Send">
            <Send size={20} />
          </button>
        )}
      </div>
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
