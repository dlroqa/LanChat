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

const RUN = { width: 760, height: 1000, budget: 8000, args: ['--hide-scrollbars'] };

function entry() {
  return `
import React from 'react';
import { createRoot } from 'react-dom/client';
import SoundSettings from ${JSON.stringify(path.join(SRC, 'components', 'SoundSettings.jsx'))};
import MessageBubble from ${JSON.stringify(path.join(SRC, 'components', 'MessageBubble.jsx'))};
window.__lanchat = { React, createRoot, SoundSettings, MessageBubble };
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

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${css}</style></head>
<body><div id="root" class="app">
  <div class="modal" id="settings"></div>
  <div class="messages-wrap" id="thread"></div>
</div>
<pre id="result"></pre>
<script>
// The preload surface, stubbed. Only what this section actually calls: main is
// the authority on the engine, so setSpeechEngine answers the way ipc.js does.
let engine = 'local';
window.lanchat = {
  pickSound: async () => null,
  speechStatus: async () => ({ engine, hasKey: false, model: 'test-model' }),
  // The preload signature, not the IPC one: preload.js takes the engine as a
  // plain string and wraps it into { engine } on the way through.
  setSpeechEngine: async (next) => {
    engine = next === 'gemini' ? 'gemini' : 'local';
    return { agentSpeechEngine: engine, speech: { engine, hasKey: false, model: 'test-model' } };
  },
  setSpeechKey: async () => ({ ok: true, speech: { engine, hasKey: true, model: 'test-model' } }),
  speak: async () => ({ ok: false, reason: 'local', fallback: true }),
};
</script>
<script>${bundle}</script>
<script>
const { React, createRoot, SoundSettings, MessageBubble } = window.__lanchat;
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
let speechEngine = 'local';
const settings = createRoot($('#settings'));
const drawSettings = () => new Promise((r) => {
  settings.render(h(SoundSettings, {
    value: sounds,
    speechEngine,
    soundUrl: () => null,
    onChange: (patch) => { sounds = { ...sounds, ...patch }; drawSettings(); },
  }));
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
const drawThread = (onSpeak) => new Promise((r) => {
  thread.render(h('div', { className: 'messages' }, [
    h(MessageBubble, { key: 'a', msg: AGENT_TURN, color: '#88ddb3', onSpeak }),
    h(MessageBubble, { key: 'b', msg: MY_QUESTION, onSpeak }),
  ]));
  setTimeout(r, 80);
});

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

const out = {};
(async () => {
  await drawSettings();

  const row = (label) => [...document.querySelectorAll('.switch')]
    .find((s) => s.textContent.includes(label));

  out.hasToggle = Boolean(row('Read discussions aloud'));
  out.engineChoices = [...$('#speech-engine').options].map((o) => o.value);
  out.volumeRow = [...document.querySelectorAll('.volume-field label')]
    .some((l) => l.textContent.includes('Speech volume'));

  // Local engine: no key box, and no warning about sending anything. The absent
  // warning matters as much as the present one — a notice shown when nothing is
  // being sent is a notice people learn to scroll past.
  out.localKeyBox = Boolean($('#speech-key'));
  out.localSaysNothingSent = panelText().includes('Nothing is sent anywhere');
  out.localSaysSentToGoogle = panelText().includes('sent to Google');

  // Switching to the online voice is what brings both of them in.
  setSelect($('#speech-engine'), 'gemini');
  await wait(250);

  out.engineAfterSwitch = $('#speech-engine').value;
  out.geminiKeyBox = Boolean($('#speech-key'));
  out.keyIsPassword = $('#speech-key') ? $('#speech-key').type : null;
  out.keyAutocomplete = $('#speech-key') ? $('#speech-key').getAttribute('autocomplete') : null;
  out.geminiSaysSentToGoogle = panelText().includes('sent to Google');

  // Switched off, the whole section is inert rather than gone — the same
  // treatment the music picker gets above it.
  sounds = { ...sounds, agentSpeechEnabled: false };
  await drawSettings();
  await wait(80);
  out.engineDisabledWhenOff = $('#speech-engine').disabled;
  out.keyDisabledWhenOff = $('#speech-key') ? $('#speech-key').disabled : null;

  // ---- the replay button ----
  await drawThread(() => {});
  const speak = $('.bubble-speak');
  out.speakOnAgentTurn = Boolean(speak);
  // One button, on the agent's bubble only: reading your own question back to
  // you is not a thing anybody wants.
  out.speakButtons = document.querySelectorAll('.bubble-speak').length;
  out.speakLabel = speak ? speak.getAttribute('aria-label') : null;
  out.hiddenAtRest = seen(speak);

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
