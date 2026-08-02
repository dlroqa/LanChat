'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The card the user actually reads, rendered from the real component.
//
// Everything else about dictation is asserted through pure functions, which is
// the right level for the decisions — but the two defects reported against this
// feature were both things only the rendered card shows: a second "Listening"
// sitting on top of the session card's, and an unreachable state with a dead
// button and no way back. Neither is visible from a decision function, so they
// are pinned here instead.

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// No navigator stub: every key these tests name resolves straight out of
// PTT_KEYS or from a recorded code, so defaultPttKey() — the only thing in this
// path that reads navigator.platform — is never reached. Node 22 exposes a
// getter-only global navigator, so a stub here would throw rather than help.

// Same loader as findInThread.test.js: the real files, transformed the way vite
// would, so what is asserted is what the app mounts rather than a fixture of it.
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const esbuild = require('esbuild');
  const { code } = esbuild.transformSync(fs.readFileSync(file, 'utf8'), {
    loader: 'jsx',
    format: 'cjs',
  });
  const mod = { exports: {} };
  cache.set(file, mod.exports);
  new Function('module', 'exports', 'require', code)(mod, mod.exports, (id) => {
    if (id === 'react') return React;
    if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id));
    return require(id);
  });
  cache.set(file, mod.exports);
  return mod.exports;
}

const PttBar = load(path.join(SRC, 'components', 'PttBar.jsx')).default;

const peer = { id: 'agent:1', name: 'Tessie', online: true };
const idleState = { transmitting: false, connecting: false, talkers: [] };

// renderToStaticMarkup escapes apostrophes to &#x27;, so a literal "isn't" would
// never match. Decoded here rather than escaped in the assertions, so what the
// tests quote is what a person reads on screen.
const readable = (html) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

function card(dictation, extra = {}) {
  return readable(
    renderToStaticMarkup(
      React.createElement(PttBar, {
        peer,
        state: idleState,
        keyName: 'meta',
        customCode: null,
        dictation: { phase: 'idle', threadId: null, startedAt: 0, error: null, ...dictation },
        cliReady: true,
        onHoldStart: () => {},
        onHoldEnd: () => {},
        onDictateToggle: () => {},
        ...extra,
      })
    )
  );
}

test('the dictate card never says "Listening", which means something else next to it', () => {
  // The session card directly below this one says "Listening" to mean the agents
  // are free. Two unrelated senses of the word, stacked, read as one status
  // arguing with itself — so the recording state is "Recording".
  const recording = card({ phase: 'recording', startedAt: Date.now() });
  assert.ok(recording.includes('Recording'), 'the recording state says Recording');
  assert.ok(!recording.includes('Listening'), 'and never Listening');

  for (const phase of ['idle', 'transcribing', 'error']) {
    assert.ok(!card({ phase }).includes('Listening'), `${phase} must not say Listening either`);
  }
});

test('an unreachable FluidVoice leaves the button live, so it can be retried', () => {
  const html = card({ phase: 'idle' }, { cliReady: false });

  assert.ok(html.includes("FluidVoice isn't reachable"), 'it says what is wrong');
  assert.ok(html.includes('Tap to retry'), 'and that tapping asks again');
  // The reported defect: disabled here meant the only way out was restarting the
  // app, while Settings was simultaneously reporting "Connected".
  assert.ok(!html.includes('disabled'), 'the button must not be dead');
});

test('the card names the key that actually dictates', () => {
  // Sharing the push-to-talk key: it names that one.
  assert.ok(card({ phase: 'idle' }).includes('⌘'), 'the borrowed key');

  // Given a key of its own, it must name that instead — a card still advertising
  // ⌘ after dictation moved to F13 is telling the user to press the wrong key.
  const own = card({ phase: 'idle' }, { dictateKeyName: 'custom', dictateCustomCode: 'F13' });
  assert.ok(own.includes('F13'), 'the dedicated key');
  assert.ok(!own.includes('⌘'), 'and not the one it no longer uses');
});

test('transcribing disables the button, because there is nothing to press it for', () => {
  assert.ok(card({ phase: 'transcribing' }).includes('disabled'));
  assert.ok(card({ phase: 'transcribing' }).includes('Transcribing'));
});

test('with no dictation in play the card is still the radio', () => {
  const html = renderToStaticMarkup(
    React.createElement(PttBar, {
      peer,
      state: idleState,
      keyName: 'meta',
      dictation: null,
      onHoldStart: () => {},
      onHoldEnd: () => {},
    })
  );
  // Windows and Linux never pass a dictation prop, so this is also the assertion
  // that they render exactly what they always did.
  assert.ok(html.includes('Hold'), 'hold to talk');
  assert.ok(html.includes('Push to talk'));
  assert.ok(!html.includes('FluidVoice'));
});
