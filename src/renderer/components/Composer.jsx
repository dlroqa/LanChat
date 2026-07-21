import React, { useRef, useState, useEffect } from 'react';
import { Send, Paperclip } from '../lib/icons.jsx';

// Message composer: auto-growing textarea, Enter to send, attach button.
export default function Composer({ onSend, onAttach, onTyping, disabled }) {
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
      <button className="icon-btn" onClick={onAttach} disabled={disabled} title="Send file, photo or video">
        <Paperclip size={20} />
      </button>
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
      <button className="send-btn" onClick={submit} disabled={!text.trim()} title="Send">
        <Send size={20} />
      </button>
    </div>
  );
}
