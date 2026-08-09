import React, { useEffect, useRef, useState } from 'react';
import { Play, Stop } from '../lib/icons.jsx';
import { previewVoice } from '../lib/agentSpeech.js';
import { VOICES } from '../lib/agentVoice.js';

const api = window.lanchat;

// Reading a session aloud: whether to, in whose voice, and with whose key.
//
// Its own panel rather than a corner of the Sounds one, because it is its own
// thing now — an engine, a key, a bill and its own ways of failing — and because
// SettingsModal gives it a heading of its own, like every other category.
//
// The providers, in the order the dropdown offers them. A table rather than
// three branches, so a fourth engine is a row: the label a person reads, the
// name of the key field, and the sentence saying where the words go.
const PROVIDERS = [
  {
    id: 'local',
    label: 'This computer’s voices',
    // No key, nothing sent, nothing to warn about.
    key: null,
  },
  {
    id: 'gemini',
    label: 'Gemini — Google',
    key: { label: 'Gemini API key', id: 'speech-key-gemini' },
    sends: 'Google',
  },
  {
    id: 'xai',
    label: 'xAI — Grok',
    key: { label: 'xAI API key', id: 'speech-key-xai' },
    sends: 'xAI',
  },
];

const byId = (id) => PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];

export default function SpeechSettings({ value, onChange, soundUrl }) {
  // The engine and the keys do not travel on `onChange` with the volume slider.
  // They have channels of their own in main, because between them they decide
  // whether the agents' words leave this machine, and a switch like that must
  // never move as a side effect of saving an unrelated preference.
  //
  // Seeded from main rather than from the window's copy of the config: because
  // this setting travels on its own channel, that copy is not refreshed when it
  // changes, and a panel seeded from it showed the old engine again the next
  // time it was opened. Asking main, which is the authority, is what makes the
  // dropdown's selection true rather than merely likely.
  const [engine, setEngineState] = useState('local');
  const [keys, setKeys] = useState({});
  const [active, setActive] = useState('local');
  const [keyDraft, setKeyDraft] = useState('');
  const [keyError, setKeyError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [auditioning, setAuditioning] = useState(false);
  const stopVoice = useRef(null);

  const provider = byId(engine);
  const hasKey = Boolean(keys[engine]);
  const on = value.agentSpeechEnabled === true;

  // Everything main knows and this panel may see: which engine is chosen, which
  // providers have a key, and which one is really going to speak. Never a key.
  function absorb(status) {
    if (!status) return;
    setEngineState(byId(status.engine).id);
    setKeys(status.keys || {});
    setActive(status.active || 'local');
  }

  useEffect(() => {
    let live = true;
    api.speechStatus?.().then((s) => live && absorb(s));
    return () => {
      live = false;
    };
  }, []);

  async function setEngine(next) {
    setBusy(true);
    setKeyError(null);
    // A half-typed key belongs to the provider it was being typed for.
    setKeyDraft('');
    try {
      const res = await api.setSpeechEngine(next);
      absorb(res?.speech);
    } finally {
      setBusy(false);
    }
  }

  async function saveKey() {
    setBusy(true);
    setKeyError(null);
    try {
      const res = await api.setSpeechKey(engine, keyDraft);
      if (!res?.ok) {
        setKeyError(res?.error || 'The key could not be saved.');
        return;
      }
      absorb(res.speech);
      // Never left in the box: it is saved, and a key sitting in a form is a key
      // waiting to be read over somebody's shoulder.
      setKeyDraft('');
    } finally {
      setBusy(false);
    }
  }

  async function forgetKey() {
    setBusy(true);
    setKeyError(null);
    try {
      const res = await api.setSpeechKey(engine, '');
      absorb(res?.speech);
      setKeyDraft('');
    } finally {
      setBusy(false);
    }
  }

  // What will actually happen, which is not always what the dropdown says: a
  // provider chosen without a key reads locally, and being told so is the
  // difference between a setting that looks broken and one that is waiting for
  // something.
  const working = active !== 'local';
  const line = !on
    ? 'Nothing is read aloud.'
    : working
      ? `Reading with ${byId(active).label.split(' — ')[0]}.`
      : engine === 'local'
        ? 'Reading with this computer’s voices.'
        : `No ${provider.label.split(' — ')[0]} key saved — reading with this computer’s voices until you add one.`;

  function endVoicePreview() {
    stopVoice.current?.();
    stopVoice.current = null;
    setAuditioning(false);
  }

  function toggleVoicePreview() {
    if (auditioning) return endVoicePreview();
    stopVoice.current = previewVoice({
      voice: VOICES[0],
      volume: value.agentSpeechVolume ?? 0.9,
      // The audition takes the same route a real turn does, so a key that does
      // not work is found out here rather than in the middle of a discussion.
      synthesize: async (text, voice) => {
        const res = await api.speak(text, voice, navigator.language);
        return res?.ok ? soundUrl(res.path) : null;
      },
    });
    setAuditioning(true);
  }

  // Closing Settings mid-audition must not leave a voice talking behind it, and
  // changing engine ends whatever is mid-sentence in the old one.
  useEffect(() => () => stopVoice.current?.(), []);
  useEffect(() => {
    if (auditioning) endVoicePreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, value.agentSpeechEnabled]);

  return (
    <div>
      <div className="switch">
        <div>
          <div style={{ fontWeight: 500 }}>Read discussions aloud</div>
          <div style={{ fontSize: 12, color: 'var(--fg-faint)' }}>
            In a session set to Discussion, each agent&rsquo;s turn is spoken as it arrives, in a voice of its
            own.
          </div>
        </div>
        <button
          className={`toggle ${on ? 'on' : ''}`}
          onClick={() => onChange({ agentSpeechEnabled: !on })}
          aria-pressed={on}
          aria-label="Read discussions aloud"
        />
      </div>

      <div className="field">
        <label htmlFor="speech-engine">Voice</label>
        <div className="row">
          <select
            id="speech-engine"
            value={engine}
            onChange={(e) => setEngine(e.target.value)}
            style={{ flex: 1 }}
            disabled={!on || busy}
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <button
            className="btn"
            title={auditioning ? 'Stop' : 'Hear a voice'}
            disabled={!on}
            onClick={toggleVoicePreview}
          >
            {auditioning ? <Stop size={15} /> : <Play size={15} />}
          </button>
        </div>
        <div className={`speech-engine-state ${working ? 'on' : ''}`} role="status">
          {line}
        </div>
      </div>

      {provider.key && (
        <div className="field">
          <label htmlFor={provider.key.id}>{provider.key.label}</label>
          <div className="row">
            <input
              id={provider.key.id}
              type="password"
              placeholder={hasKey ? 'A key is saved' : 'Paste your key'}
              value={keyDraft}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setKeyDraft(e.target.value)}
              style={{ flex: 1 }}
              disabled={!on || busy}
            />
            <button className="btn" disabled={!on || busy || !keyDraft.trim()} onClick={saveKey}>
              Save
            </button>
            {hasKey && (
              <button className="btn ghost" disabled={!on || busy} onClick={forgetKey}>
                Forget
              </button>
            )}
          </div>
          {/* The one sentence that has to be here. LanChat has no central server
              and this is the setting that changes that, so it says where the
              words go, in words, beside the field that sends them. Each key is
              kept apart from the other: choosing a provider never hands it
              somebody else's credentials. */}
          <div style={{ fontSize: 12, color: 'var(--fg-faint)', marginTop: 6 }}>
            The agents&rsquo; replies in a discussion are sent to {provider.sends} to be read. Nothing else
            is, and nothing at all is while this is set to your computer&rsquo;s voices.
          </div>
          {keyError && <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 6 }}>{keyError}</div>}
        </div>
      )}

      <div className="field volume-field">
        <label htmlFor="Speech volume">
          Speech volume{' '}
          <span className="volume-pct">{Math.round((value.agentSpeechVolume ?? 0.9) * 100)}%</span>
        </label>
        <input
          id="Speech volume"
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={value.agentSpeechVolume ?? 0.9}
          disabled={!on}
          onChange={(e) => onChange({ agentSpeechVolume: Number(e.target.value) })}
        />
      </div>
    </div>
  );
}
