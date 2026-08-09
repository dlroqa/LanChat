import React, { useEffect, useRef, useState } from 'react';
import { Play, Stop, Download } from '../lib/icons.jsx';
import { previewVoice } from '../lib/agentSpeech.js';
import { VOICES } from '../lib/agentVoice.js';
import { formatBytes } from '../lib/util.js';

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
  {
    // The fourth engine, and the first that is neither the platform's nor
    // somebody's API: an open model that runs here. No key, because there is no
    // account — what stands between it and speaking is 93 MB on disk, which is
    // why this row shows a download where the two above show a key field.
    id: 'kokoro',
    label: 'Kokoro — on this computer',
    key: null,
    local: true,
  },
];

const byId = (id) => PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];

export default function SpeechSettings({ value, onChange, soundUrl, onEngineChange }) {
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
  // The active provider's roster, so the audition asks for a voice that provider
  // owns rather than a Gemini name every engine was once given. Empty for Gemini
  // and local, which the audition already covers with its own default; only xAI
  // publishes a list, and main answers [] for anything else.
  const [roster, setRoster] = useState([]);
  // What the audition is doing and what actually spoke, so pressing the button
  // is not a leap of faith: a key that xAI refuses reads locally, and this is
  // where that becomes visible instead of sounding like success.
  const [preview, setPreview] = useState(null); // { state, engine, error } | null
  const stopVoice = useRef(null);

  // The offline model: whether it is here, how much of it, and what went wrong
  // getting it. Seeded from the same status call as everything else, then kept
  // current by the progress events below.
  const [model, setModel] = useState({ ready: false, supported: true, bytes: 0, total: 0 });
  const [fetching, setFetching] = useState(false);
  const [got, setGot] = useState(null); // { received, total } while downloading
  const [modelError, setModelError] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

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
    if (status.kokoro) setModel(status.kokoro);
  }

  useEffect(() => {
    let live = true;
    api.speechStatus?.().then((s) => live && absorb(s));
    return () => {
      live = false;
    };
  }, []);

  // Download progress, on the one event channel main reports every long job on —
  // the same one UpdateSection watches. Subscribed for the life of the panel
  // rather than only while downloading, so a download that was already running
  // when Settings opened shows its progress instead of looking stalled.
  useEffect(() => {
    if (!api.onEvent) return undefined;
    return api.onEvent((evt) => {
      if (evt?.type === 'tts-progress') setGot(evt.payload);
    });
  }, []);

  // The voice the audition asks for. Fetched per engine, and per key, because a
  // provider gains a roster the moment a key is saved. Main keeps it for the
  // life of the process, so this is a socket only the first time. A provider
  // that publishes no list (Gemini, local) answers [], and the audition falls
  // back to its own default voice below.
  useEffect(() => {
    let live = true;
    api
      .speechVoices?.()
      .then((res) => live && setRoster(res?.voices?.length ? res.voices : []))
      .catch(() => live && setRoster([]));
    return () => {
      live = false;
    };
    // `hasKey` rather than keys[engine] directly: the roster changes the moment a
    // provider gains or loses its key, and a member expression cannot be checked
    // statically here.
  }, [engine, hasKey]);

  async function setEngine(next) {
    setBusy(true);
    setKeyError(null);
    // A half-typed key belongs to the provider it was being typed for.
    setKeyDraft('');
    try {
      const res = await api.setSpeechEngine(next);
      absorb(res?.speech);
      // App holds no copy of the engine — it moved on its own channel — so it is
      // told directly, here, to re-ask for the new provider's roster rather than
      // waiting for this modal to close.
      onEngineChange?.();
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

  // Getting the model. The only thing in this panel that downloads anything, and
  // it happens on a press rather than on a launch.
  async function fetchModel() {
    setFetching(true);
    setModelError(null);
    setGot({ received: model.bytes || 0, total: model.total });
    try {
      const res = await api.downloadSpeechModel?.();
      if (!res?.ok) {
        // The cause and the way out, rather than "failed" — the button beside
        // this line becomes Retry.
        setModelError(
          res?.detail ? `${res.error} ${res.detail}` : res?.error || 'The download did not finish.'
        );
        return;
      }
      absorb(res.speech);
      // Main selects this engine once the weights are whole, so the panel asks
      // App to re-fetch the roster exactly as changing the dropdown does.
      onEngineChange?.();
    } finally {
      setFetching(false);
      setGot(null);
    }
  }

  function cancelModel() {
    api.cancelSpeechModel?.();
  }

  async function removeModel() {
    setConfirmRemove(false);
    setBusy(true);
    setModelError(null);
    try {
      const res = await api.removeSpeechModel?.();
      if (!res?.ok) {
        setModelError(res?.error || 'The model could not be removed.');
        return;
      }
      absorb(res.speech);
      onEngineChange?.();
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
        : provider.local
          ? // The same sentence shape as a missing key, because it is the same
            // situation: an engine chosen but not yet able to speak, reading
            // locally in the meantime rather than failing. Except when this
            // machine could never run it, which is not something waiting to be
            // fixed and should not be worded as though it were.
            model.supported === false
            ? 'Kokoro cannot run on this computer — reading with this computer’s voices.'
            : 'Kokoro is not downloaded yet — reading with this computer’s voices until it is.'
          : `No ${provider.label.split(' — ')[0]} key saved — reading with this computer’s voices until you add one.`;

  // What to call a voice in a sentence: "this computer’s voices" for the local
  // engine, and the provider's short name otherwise. The one place that maps an
  // engine id to a name, so the audition line and the setting line agree.
  const spokeName = (id) => (id === 'local' ? 'this computer’s voices' : byId(id).label.split(' — ')[0]);

  // What the audition did, in words. Absent until the button is pressed; while
  // it plays it names what it is trying, and when the reply lands it names what
  // actually spoke — which is not always the same engine, and that gap is the
  // whole reason this line exists.
  const previewLine = !preview
    ? null
    : preview.state === 'pending'
      ? `Auditioning ${spokeName(engine)}…`
      : preview.state === 'spoke'
        ? `Spoken by ${spokeName(preview.engine)}.`
        : `${preview.error} This computer’s voices read it instead.`;
  const previewWorking = preview?.state === 'spoke' && preview.engine !== 'local';

  // How far the download has got. Counted against the manifest's total rather
  // than the reply's, so resuming a part-finished download starts at the share
  // already on disk instead of at zero.
  const modelTotal = got?.total || model.total || 0;
  const modelPct = modelTotal ? Math.min(100, Math.round(((got?.received || 0) / modelTotal) * 100)) : 0;

  function endVoicePreview() {
    stopVoice.current?.();
    stopVoice.current = null;
    setAuditioning(false);
    setPreview(null);
  }

  function toggleVoicePreview() {
    if (auditioning) return endVoicePreview();
    setPreview({ state: 'pending', engine: null, error: null });
    stopVoice.current = previewVoice({
      // A voice the chosen engine actually owns. xAI rejects a Gemini name and
      // reads locally, which used to make an xAI audition sound like the system
      // voice; roster[0] is one of its own. Gemini and local publish no roster,
      // so they keep the default.
      voice: roster[0] || VOICES[0],
      volume: value.agentSpeechVolume ?? 0.9,
      // The audition takes the same route a real turn does, so a key that does
      // not work is found out here rather than in the middle of a discussion.
      synthesize: async (text, voice) => {
        const res = await api.speak(text, voice, navigator.language);
        if (res?.ok) {
          setPreview({ state: 'spoke', engine: res.engine, error: null });
          return soundUrl(res.path);
        }
        // A real failure carries a sentence; a chosen-local or no-key engine
        // carries none, and reading locally is its expected outcome rather than
        // a fall from anything.
        if (res?.error) {
          setPreview({ state: 'fell-back', engine: null, error: res.error });
          return null;
        }
        setPreview({ state: 'spoke', engine: 'local', error: null });
        return null;
      },
    });
    setAuditioning(true);
  }

  // Closing Settings mid-audition must not leave a voice talking behind it, and
  // changing engine ends whatever is mid-sentence in the old one.
  useEffect(() => () => stopVoice.current?.(), []);
  useEffect(() => {
    if (auditioning) endVoicePreview();
    else setPreview(null);
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
        {previewLine && (
          <div
            className={`speech-engine-state ${previewWorking ? 'on' : ''}`}
            role="status"
            aria-live="polite"
          >
            {previewLine}
          </div>
        )}
      </div>

      {/* A machine with no native library for its platform and architecture is
          not offered a download it could never use.

          Every platform LanChat ships has one — the runtime is pinned to a
          version that publishes all of them, and test/ttsPackaging.test.js holds
          that pin — so this is a guard against a broken build rather than a
          state anybody should reach. It still says so plainly instead of hiding
          the row: a missing feature with no explanation is worse than a missing
          feature with one. */}
      {provider.local && model.supported === false && (
        <div className="field">
          <div className="hint" role="status">
            This build has no Kokoro for {navigator.platform || 'this computer'}. That is a fault in the build
            rather than a limit of your machine — the other voices all still work.
          </div>
        </div>
      )}

      {provider.local && model.supported !== false && (
        <div className="field">
          <label htmlFor="speech-model">Voice model</label>
          <div className="row" id="speech-model">
            {/* One primary action at a time, and it says which of the four
                states this is in rather than being a button that means
                different things silently. */}
            {model.ready ? (
              confirmRemove ? (
                <>
                  <button className="btn danger" disabled={busy} onClick={removeModel}>
                    Remove {formatBytes(model.total)}?
                  </button>
                  <button className="btn ghost" disabled={busy} onClick={() => setConfirmRemove(false)}>
                    Keep
                  </button>
                </>
              ) : (
                // An ordinary button rather than the primary one: destructive,
                // so it should not be the loudest thing on the row — but not a
                // ghost either, because alone on its row a borderless button
                // reads as a caption rather than as something you can press.
                // The danger colour arrives on the confirmation below, which is
                // where the destruction actually is.
                <button className="btn" disabled={!on || busy} onClick={() => setConfirmRemove(true)}>
                  Remove
                </button>
              )
            ) : fetching ? (
              <button className="btn ghost" onClick={cancelModel}>
                Stop
              </button>
            ) : (
              <button className="btn primary" disabled={!on || busy} onClick={fetchModel}>
                <Download size={16} />
                {modelError ? 'Try again' : `Download ${formatBytes(model.total)}`}
              </button>
            )}
          </div>

          {/* The bar keeps its space whether or not it is filling, so the panel
              does not jump a row taller the moment a download starts. */}
          <div style={{ marginTop: 10, minHeight: 22 }}>
            {fetching && (
              <>
                <div
                  className="progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={modelPct}
                  aria-label="Downloading the voice model"
                >
                  <span style={{ width: `${modelPct}%` }} />
                </div>
                <div className="hint" aria-live="polite">
                  {modelPct}% of {formatBytes(model.total)}
                </div>
              </>
            )}
            {!fetching && model.ready && (
              <div className="hint">
                {formatBytes(model.total)} on this computer. {model.voices?.length ?? 13} voices.
                {/* Said only when it is the slower of the two, because on every
                    other machine the runtime is an implementation detail nobody
                    needs to think about. Where it does apply it is the answer to
                    "why is this slower than my colleague's" — which is otherwise
                    an unanswerable question. */}
                {model.backend === 'wasm' &&
                  ' Running through WebAssembly on this platform, which is slower than usual.'}
              </div>
            )}
          </div>

          {/* The sentence that is the reason to choose this engine at all — the
              exact counterpart of "sent to Google" beside the key fields above.
              LanChat's promise is that peers talk directly and nothing goes
              through anybody's server; this is the reading voice that keeps it. */}
          <div style={{ fontSize: 12, color: 'var(--fg-faint)', marginTop: 6 }}>
            Kokoro runs on this computer. The agents&rsquo; replies are read without a word of them leaving
            it, and it keeps working with no network at all. The model is downloaded once, from Hugging Face,
            and checked against a known fingerprint before it is used.
          </div>

          {/* Below the control it belongs to, in the danger colour *and* in
              words, so the failure is not carried by colour alone. */}
          {modelError && (
            <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 6 }} role="alert">
              {modelError}
            </div>
          )}
        </div>
      )}

      {provider.local && model.ready && model.supported !== false && (
        <div className="field volume-field">
          <label htmlFor="speech-speed">
            Reading speed <span className="volume-pct">{(value.agentSpeechSpeed ?? 1).toFixed(2)}×</span>
          </label>
          <input
            id="speech-speed"
            type="range"
            min="0.5"
            max="2"
            step="0.05"
            value={value.agentSpeechSpeed ?? 1}
            disabled={!on}
            onChange={(e) => onChange({ agentSpeechSpeed: Number(e.target.value) })}
          />
        </div>
      )}

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

      {/* Trading a wait at the start for none in the middle. Off by default,
          because the ordinary reading starts the moment you press play; this is
          for a read-through where the silence between turns matters more than
          getting the first word out quickly. Only an online voice has a gap to
          close, so the note says so rather than leaving it to be discovered. */}
      <div className="switch">
        <div>
          <div style={{ fontWeight: 500 }}>Prepare the whole session first</div>
          <div style={{ fontSize: 12, color: 'var(--fg-faint)' }}>
            Synthesises every turn before playing, so there is no pause between them. It waits once at the
            start instead. Does nothing for this computer&rsquo;s own voices, which have nothing to fetch.
          </div>
        </div>
        <button
          className={`toggle ${value.agentSpeechPreload === true ? 'on' : ''}`}
          onClick={() => onChange({ agentSpeechPreload: !(value.agentSpeechPreload === true) })}
          disabled={!on}
          aria-pressed={value.agentSpeechPreload === true}
          aria-label="Prepare the whole session first"
        />
      </div>
    </div>
  );
}
