'use strict';

// Drives the speech settings and the replay button in a real browser.
//
// Two things here can only be checked by rendering. The first is the Settings
// section's shape: which rows exist in which engine, that the key box is a
// password box, that the sentence saying where the words go is actually on
// screen next to the switch that sends them — and that it is *not* there when
// the engine is local, because a warning shown when nothing is being sent
// teaches people to ignore it. The second is the replay button: it is hidden at
// rest and revealed on hover and on keyboard focus, which is opacity resolved
// through three selectors and a custom property, and a DOM stand-in would only
// measure our own guess.
//
// So this mounts the real components against a stubbed window.lanchat and does
// what a person would do: switches the engine, tabs to the button.
//
//   node scripts/speech-harness.js [outDir]

const fs = require('node:fs');
const path = require('node:path');
const { chromiumPath, render, withScratchDir } = require('./lib/chromium.js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer');

// Wide enough for the right column to exist: below the 980px break the whole
// side panel is `display: none`, and a transport measured inside a hidden column
// reports zero-sized rectangles that make geometry assertions pass for the wrong
// reason.
const RUN = { width: 1280, height: 1040, budget: 8000, args: ['--hide-scrollbars'] };

function entry() {
  return `
import React from 'react';
import { createRoot } from 'react-dom/client';
import SpeechSettings from ${JSON.stringify(path.join(SRC, 'components', 'SpeechSettings.jsx'))};
import MessageBubble from ${JSON.stringify(path.join(SRC, 'components', 'MessageBubble.jsx'))};
import ConnectionPanel from ${JSON.stringify(path.join(SRC, 'components', 'ConnectionPanel.jsx'))};
window.__lanchat = { React, createRoot, SpeechSettings, MessageBubble, ConnectionPanel };
`;
}

// The bundled track list is built by a Vite glob, which esbuild leaves as a call
// to a function no browser has. It is not what this harness is about — the real
// module is covered by agentMusic.test.js, which swaps the same expression for a
// fixture — so it is stood in for here and everything else is the real code.
const TRACKS_STUB = `
export const TRACKS = { universe: { label: 'Universe' } };
export const TRACK_KEYS = ['universe'];
export const HAS_TRACK = true;
export const DEFAULT_TRACK = 'universe';
export const trackUrl = () => null;
export const trackKey = (p) => p;
export const trackLabel = (k) => k;
`;

// Async rather than buildSync, because standing the track list down needs a
// resolver plugin and esbuild refuses plugins on the synchronous API.
async function buildBundle(dir) {
  const esbuild = require('esbuild');
  const entryFile = path.join(dir, 'entry.jsx');
  const outFile = path.join(dir, 'bundle.js');
  const stubFile = path.join(dir, 'agentMusicTrack.js');
  fs.writeFileSync(entryFile, entry());
  fs.writeFileSync(stubFile, TRACKS_STUB);
  await esbuild.build({
    entryPoints: [entryFile],
    bundle: true,
    outfile: outFile,
    format: 'iife',
    loader: { '.js': 'jsx' },
    define: { 'process.env.NODE_ENV': '"production"' },
    absWorkingDir: ROOT,
    nodePaths: [path.join(ROOT, 'node_modules')],
    logLevel: 'silent',
    plugins: [
      {
        name: 'stub-track-glob',
        setup(build) {
          build.onResolve({ filter: /agentMusicTrack\.js$/ }, () => ({ path: stubFile }));
        },
      },
    ],
  });
  return fs.readFileSync(outFile, 'utf8');
}

function buildPage(bundle) {
  const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');

  // Transitions are settled rather than animated. Under --virtual-time-budget a
  // CSS transition never advances, so a transitioned property reads back at its
  // starting value forever — measuring opacity through one would report every
  // revealed button as invisible. The rules that decide the value are still the
  // real ones; only the travel to it is removed.
  const settle = `* { transition: none !important; animation: none !important; }`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${css}</style><style>${settle}</style></head>
<body><div id="root" class="app">
  <div class="modal" id="settings"></div>
  <div class="messages-wrap" id="thread"></div>
  <aside class="side-panel" id="panel"></aside>
</div>
<pre id="result"></pre>
<script>
// The preload surface, stubbed. Only what this section actually calls: main is
// the authority on the engine, so setSpeechEngine answers the way ipc.js does.
let engine = 'local';
const keys = { gemini: false, xai: false };
// What main really answers: the chosen engine, which providers hold a key, and
// which one can actually speak — a provider chosen without a key reads locally.
const status = () => ({
  engine,
  keys: { ...keys },
  active: engine !== 'local' && keys[engine] ? engine : 'local',
  model: 'test-model',
});
window.lanchat = {
  pickSound: async () => null,
  speechStatus: async () => status(),
  // The preload signature, not the IPC one: preload.js takes these as plain
  // arguments and wraps them on the way through. engineOf() in main is what
  // refuses an unknown engine, so the stub refuses one the same way.
  setSpeechEngine: async (next) => {
    engine = ['gemini', 'xai'].includes(next) ? next : 'local';
    return { agentSpeechEngine: engine, speech: status() };
  },
  setSpeechKey: async (provider, key) => {
    if (!(provider in keys)) return { ok: false, error: 'Unknown speech provider.', speech: status() };
    keys[provider] = Boolean(key && key.trim());
    return { ok: true, speech: status() };
  },
  speechVoices: async () => ({ ok: true, provider: engine, voices: [] }),
  speak: async () => ({ ok: false, reason: 'local', fallback: true }),
};
</script>
<script>${bundle}</script>
<script>
const { React, createRoot, SpeechSettings, MessageBubble, ConnectionPanel } = window.__lanchat;
const h = React.createElement;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => document.querySelector(s);
const seen = (el) => Boolean(el) && Math.round(parseFloat(getComputedStyle(el).opacity) * 100) / 100;

// ---- Settings ----
let sounds = {
  ringtone: 'classic', ringtoneVolume: 0.8, notificationSound: 'ping', notificationVolume: 0.7,
  muteNotifications: false, agentMusicEnabled: true, agentMusic: null, agentMusicVolume: 0.5,
  agentSpeechEnabled: true, agentSpeechVolume: 0.9,
};
const settings = createRoot($('#settings'));
const drawSettings = () => new Promise((r) => {
  // Rendered under its own heading, exactly as SettingsModal does it, so the
  // rule beneath the title is the real one rather than a mock-up of it.
  settings.render(h('div', null, [
    h('div', { key: 'h', className: 'section-head' }, 'TTS'),
    h(SpeechSettings, {
      key: 's',
      value: sounds,
      soundUrl: () => null,
      onChange: (patch) => { sounds = { ...sounds, ...patch }; drawSettings(); },
    }),
  ]));
  setTimeout(r, 80);
});

// ---- a bubble ----
const AGENT_TURN = {
  id: 'm1', peerId: 'session:1', direction: 'in', kind: 'text',
  text: 'I think we should start with the smaller of the two.',
  ts: Date.now(), speaker: 'Beacon', agentId: 'agent-7',
};
const MY_QUESTION = {
  id: 'm2', peerId: 'session:1', direction: 'out', kind: 'text',
  text: 'Which one first?', ts: Date.now(),
};
const thread = createRoot($('#thread'));
const drawThread = (onSpeak, speakingId, speechPaused) => new Promise((r) => {
  const state = (m) => (speakingId && m.id === speakingId ? (speechPaused ? 'paused' : 'playing') : undefined);
  thread.render(h('div', { className: 'messages' }, [
    h(MessageBubble, { key: 'a', msg: AGENT_TURN, color: '#88ddb3', onSpeak, speakState: state(AGENT_TURN) }),
    h(MessageBubble, { key: 'b', msg: MY_QUESTION, onSpeak, speakState: state(MY_QUESTION) }),
  ]));
  setTimeout(r, 80);
});

// ---- the Activity Panel's transport ----
const SESSION = {
  id: 'session:1', kind: 'session', name: 'New Session', online: true,
  mode: 'dialogue', agentNames: ['Mac', 'Zima', 'Tessie'], agentId: 'agent-7', agentName: 'Mac',
};
const panel = createRoot($('#panel'));
const drawPanel = (speech) => new Promise((r) => {
  panel.render(h(ConnectionPanel, {
    peer: SESSION, stats: null, agentStatus: null,
    awaiting: false, typing: false, streaming: false, commits: 1,
    speech,
  }));
  setTimeout(r, 80);
});
const TRANSPORT = {
  playing: false, paused: false, position: 0, count: 12,
  onToggle: () => {}, onNext: () => {}, onPrev: () => {},
};

// Only what is on the panel. document.body.textContent would also pick up the
// inline bundle, which contains every one of these strings as source — a check
// against it passes no matter what is rendered.
const panelText = () => $('#settings').textContent;

// React tracks a controlled input's value on the node itself and skips its
// onChange when the value it sees has not moved. Assigning through the
// prototype's setter is what makes a dispatched event look like a real edit.
function setSelect(el, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function setInput(el, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

const row = (label) =>
  [...document.querySelectorAll('.switch')].find((s) => s.textContent.includes(label));
const toggleIn = (label) => row(label) && row(label).querySelector('.toggle');
const state = () => $('.speech-engine-state').textContent;

const out = {};
(async () => {
  await drawSettings();

  out.hasToggle = Boolean(row('Read discussions aloud'));
  out.volumeRow = [...document.querySelectorAll('.volume-field label')]
    .some((l) => l.textContent.includes('Speech volume'));

  // Its own category, with the same rule under the title every other category
  // in Settings has.
  const head = [...document.querySelectorAll('.section-head')].find((h2) => h2.textContent.trim() === 'TTS');
  out.ttsHeading = Boolean(head);
  out.ttsHeadingRule = head ? getComputedStyle(head).borderBottomStyle : null;
  out.ttsHeadingWidth = head ? getComputedStyle(head).borderBottomWidth : null;

  // A dropdown again, because there are three engines now and a boolean cannot
  // name three things.
  const select = $('#speech-engine');
  out.engineIsSelect = Boolean(select);
  out.engineChoices = [...select.options].map((o) => o.value);
  out.engineLabels = [...select.options].map((o) => o.textContent);
  out.engineAtRest = select.value;

  // Local: no key box anywhere, and no warning about sending anything. The
  // absent warning matters as much as the present one — a notice shown when
  // nothing is being sent is one people learn to scroll past.
  out.localKeyBoxes = document.querySelectorAll('input[type=password]').length;
  out.localSaysSent = /sent to (Google|xAI)/.test(panelText());
  out.localState = state();

  // Gemini: its own key box, its own sentence, and — with no key saved — a line
  // saying plainly that it is still reading locally. That is the case the old
  // dropdown could not express and the one that caused the confusion.
  setSelect(select, 'gemini');
  await wait(250);
  out.geminiSelected = $('#speech-engine').value;
  out.geminiKeyBox = Boolean($('#speech-key-gemini'));
  out.geminiKeyLabel = document.querySelector('label[for=speech-key-gemini]')?.textContent || null;
  out.geminiKeyIsPassword = $('#speech-key-gemini')?.type || null;
  out.geminiSaysGoogle = panelText().includes('sent to Google');
  out.geminiNoKeyState = state();
  out.geminiNoKeyAccented = $('.speech-engine-state').classList.contains('on');

  setInput($('#speech-key-gemini'), 'a-gemini-key');
  await wait(120);
  [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save').click();
  await wait(250);
  out.geminiWithKeyState = state();
  out.geminiWithKeyAccented = $('.speech-engine-state').classList.contains('on');

  // xAI: a key box of its own, and its own destination named. Choosing it must
  // not inherit Gemini's saved key — the two are kept apart in main, and the
  // panel has to reflect that.
  setSelect($('#speech-engine'), 'xai');
  await wait(250);
  out.xaiSelected = $('#speech-engine').value;
  out.xaiKeyBox = Boolean($('#speech-key-xai'));
  out.xaiKeyLabel = document.querySelector('label[for=speech-key-xai]')?.textContent || null;
  out.geminiBoxGoneOnXai = document.querySelectorAll('#speech-key-gemini').length;
  out.xaiSaysXai = panelText().includes('sent to xAI');
  out.xaiSaysGoogle = panelText().includes('sent to Google');
  out.xaiNoKeyState = state();

  setInput($('#speech-key-xai'), 'an-xai-key');
  await wait(120);
  [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save').click();
  await wait(250);
  out.xaiWithKeyState = state();

  // Back to Gemini: its key is still saved, which is the point of holding them
  // apart rather than in one field.
  setSelect($('#speech-engine'), 'gemini');
  await wait(250);
  out.geminiKeyKept = $('#speech-key-gemini').getAttribute('placeholder');

  // Switched off, the section is inert rather than gone.
  sounds = { ...sounds, agentSpeechEnabled: false };
  await drawSettings();
  await wait(80);
  out.selectDisabledWhenOff = $('#speech-engine').disabled;
  out.keyDisabledWhenOff = $('#speech-key-gemini') ? $('#speech-key-gemini').disabled : null;
  out.offState = state();

  sounds = { ...sounds, agentSpeechEnabled: true };
  await drawSettings();
  await wait(80);

  // ---- the bubble's play/pause ----
  await drawThread(() => {});
  const speak = $('.bubble-speak');
  out.speakOnAgentTurn = Boolean(speak);
  // Both sides now: the read-through covers the whole conversation, so your own
  // questions carry the button too.
  out.speakButtons = document.querySelectorAll('.bubble-speak').length;
  out.speakLabel = speak ? speak.getAttribute('aria-label') : null;
  out.hiddenAtRest = seen(speak);

  // One button doing both jobs. The bubble being read swaps its icon, says so,
  // and stays visible without being pointed at — it is the control you need to
  // find in order to stop it.
  await drawThread(() => {}, 'm1', false);
  const playingBtn = $('.bubble-speak');
  out.bubblePlayingLabel = playingBtn.getAttribute('aria-label');
  out.bubblePlayingPressed = playingBtn.getAttribute('aria-pressed');
  out.bubblePlayingVisible = seen(playingBtn);
  out.bubblePlayingIsPause = playingBtn.querySelectorAll('rect').length === 2;
  out.litBubbles = document.querySelectorAll('.bubble-speak.on').length;

  await drawThread(() => {}, 'm1', true);
  out.bubblePausedLabel = $('.bubble-speak').getAttribute('aria-label');

  // ---- the transport ----
  await drawPanel(TRANSPORT);
  out.transportButtons = document.querySelectorAll('.conn-transport .transport-btn').length;
  out.transportLabels = [...document.querySelectorAll('.conn-transport .transport-btn')]
    .map((b) => b.getAttribute('aria-label'));
  out.transportPos = $('.transport-pos').textContent;
  // Below the stat tiles, which is where it belongs: it is about the session as
  // a whole, not about any one message. Measured only once the bar is really on
  // screen — a hidden column reports zeroes, and 0 <= 0 would pass.
  const statsBox = $('.conn-stats').getBoundingClientRect();
  const barBox = $('.conn-transport').getBoundingClientRect();
  out.transportRendered = barBox.height > 0 && barBox.width > 0;
  out.transportBelowStats = out.transportRendered && statsBox.bottom <= barBox.top;
  // And the note that explains the session sits below both of them.
  out.transportAboveNote = barBox.bottom <= $('.conn-note').getBoundingClientRect().top;

  await drawPanel({ ...TRANSPORT, playing: true, position: 3, engine: 'gemini' });
  out.playingLabel = $('.transport-play').getAttribute('aria-label');
  out.playingIsPause = $('.transport-play').querySelectorAll('rect').length === 2;
  // The engine is named while reading, so what you are hearing is answerable
  // without opening Settings.
  out.playingPos = $('.transport-pos').textContent;

  await drawPanel({ ...TRANSPORT, playing: true, position: 3, engine: 'local' });
  out.playingPosLocal = $('.transport-pos').textContent;

  await drawPanel({ ...TRANSPORT, paused: true, position: 3, engine: 'gemini' });
  out.pausedPos = $('.transport-pos').textContent;
  out.pausedLabel = $('.transport-play').getAttribute('aria-label');

  // An empty session says why it is off rather than leaving it to be guessed.
  await drawPanel({ ...TRANSPORT, count: 0 });
  out.emptyDisabled = [...document.querySelectorAll('.transport-btn')].every((b) => b.disabled);
  out.emptyWhy = $('.transport-play').getAttribute('title');
  out.emptyPos = $('.transport-pos').textContent;

  // No transport at all where reading aloud is off, so the panel is untouched
  // everywhere else.
  await drawPanel(null);
  out.transportWhenOff = document.querySelectorAll('.conn-transport').length;

  // Left in a reading state for the screenshot.
  await drawPanel({ ...TRANSPORT, playing: true, position: 3, engine: 'gemini' });

  // The two ways it comes back are :hover and :focus-visible, and headless
  // chromium can drive neither honestly — there is no pointer, and a
  // programmatic focus() deliberately does not set :focus-visible. So the rules
  // themselves are read out of the stylesheet the page actually parsed. That
  // catches the regression that really happens: the class renamed on one side
  // and not the other, leaving a button nothing can ever reveal.
  const rules = [...document.styleSheets]
    .flatMap((s) => [...s.cssRules])
    .filter((r) => r.selectorText && r.selectorText.includes('.bubble-speak'));
  out.revealSelectors = rules
    .filter((r) => r.style.opacity === '1')
    .map((r) => r.selectorText)
    .sort();
  out.reachableByKeyboard = (speak.focus(), document.activeElement === speak);

  // Without a handler there is no button at all, so every other thread in the
  // app renders exactly as it always has.
  await drawThread(undefined);
  out.speakWithoutHandler = document.querySelectorAll('.bubble-speak').length;

  $('#result').textContent = JSON.stringify(out, null, 2);
})().catch((err) => {
  // A harness that dies silently reports a passing run of nothing. Whatever went
  // wrong comes back through the same channel the findings do.
  $('#result').textContent = JSON.stringify({ error: String(err && err.stack ? err.stack : err) });
});
</script>
</body></html>`;
}

async function main() {
  const chrome = chromiumPath();
  if (!chrome) {
    console.log(JSON.stringify({ skipped: 'no chromium on this machine' }));
    return;
  }
  await withScratchDir(process.argv[2], 'lanchat-speech-', async (dir, keep) => {
    const bundle = await buildBundle(dir);
    const pageFile = path.join(dir, 'page.html');
    fs.writeFileSync(pageFile, buildPage(bundle));
    const png = keep ? path.join(dir, 'speech-settings.png') : null;
    const found = render(chrome, dir, pageFile, { ...RUN, png });
    console.log(JSON.stringify(found, null, 2));
    if (keep) console.log(`\nwrote ${png}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
