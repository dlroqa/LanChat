'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The connection light: how long it stays up, and the two structural facts about
// where it is mounted that a running window would show you immediately and a unit
// test would not.
//
// It replaces two things that used to be reported in words — a connection
// reported by silence, and a run that came back empty reported as the string
// "(no output)". So the assertions here are about it being *shown*, once, without
// costing anything else on screen.

const SRC = path.join(__dirname, '..', 'src', 'renderer');

// ESM for the browser, and it calls no hooks at module scope, so the export
// keywords come off and it evaluates in plain node. Same trick as
// statusMotion.test.js.
const timing = new Function(
  `${fs.readFileSync(path.join(SRC, 'lib', 'connectFlash.js'), 'utf8').replace(/^export\s+/gm, '')}
   return { CONNECT_MIN_MS, CONNECT_MAX_MS, EMPTY_MS, REDUCED_CONNECT_MS, connectDuration, flashDuration };`
)();

const { CONNECT_MIN_MS, CONNECT_MAX_MS, EMPTY_MS, REDUCED_CONNECT_MS, connectDuration, flashDuration } = timing;

const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');

// ------------------------------------------------------------------- the timing

test('the light lasts somewhere between four and eight seconds, and varies per play', () => {
  assert.equal(CONNECT_MIN_MS, 4000);
  assert.equal(CONNECT_MAX_MS, 8000);

  assert.equal(connectDuration(false, () => 0), 4000, 'the short end');
  assert.equal(connectDuration(false, () => 1), 8000, 'the long end');
  assert.equal(connectDuration(false, () => 0.5), 6000, 'and it scales across the range');

  // Two plays in a row should not be the same length, or it stops feeling like an
  // event and starts feeling like a cutscene.
  const draws = new Set();
  for (let i = 0; i < 200; i += 1) draws.add(connectDuration(false));
  assert.ok(draws.size > 1, 'the length actually varies');
});

test('nothing a caller can pass produces a light that never leaves', () => {
  // Whatever comes out of here becomes a setTimeout delay. A value outside the
  // range — from a seeded pick in a test, or a future refactor handing this
  // something that is not Math.random — would be a light sitting over somebody's
  // conversation until they restarted the app.
  const hostile = [() => -1, () => 2, () => NaN, () => Infinity, () => undefined, () => 'x', null, 'nope'];
  for (const pick of hostile) {
    const ms = connectDuration(false, pick);
    assert.ok(Number.isFinite(ms), `${String(pick)} produced ${ms}`);
    assert.ok(ms >= CONNECT_MIN_MS && ms <= CONNECT_MAX_MS, `${String(pick)} produced ${ms}`);
  }

  for (let i = 0; i < 2000; i += 1) {
    const ms = connectDuration(false);
    assert.ok(ms >= CONNECT_MIN_MS && ms <= CONNECT_MAX_MS, `random draw produced ${ms}`);
  }
});

test('reduced motion shortens the wait as well as removing the movement', () => {
  // With the rotation and the sheen gone there is no choreography left to watch,
  // so holding the full length would be no motion *and* the whole wait. CSS can
  // drop the animation but cannot shorten the unmount timer, which is why this
  // number is read in JS too.
  assert.equal(connectDuration(true), REDUCED_CONNECT_MS);
  assert.ok(REDUCED_CONNECT_MS < CONNECT_MIN_MS, 'and it is genuinely shorter');
  assert.equal(connectDuration(true, () => 1), REDUCED_CONNECT_MS, 'the pick is not consulted');
});

test('an empty run gets one short pass, whatever else is asked for', () => {
  assert.equal(flashDuration('empty', false), EMPTY_MS);
  assert.equal(flashDuration('empty', true), EMPTY_MS, 'a report on something that happened, not a state');
  assert.ok(EMPTY_MS < CONNECT_MIN_MS);
  assert.equal(flashDuration('connected', true), REDUCED_CONNECT_MS);
});

// --------------------------------------------------------------- the CSS contract

test('the light is driven by the duration the component resolves, not a hardcoded one', () => {
  // If the CSS held its own number the two would drift, and the light would either
  // vanish mid-animation or sit finished on screen waiting for the timer.
  const block = css.slice(css.indexOf('.agent-flash {'), css.indexOf('/* Approval card.'));
  assert.ok(block.length > 500, 'found the connection light block');

  const durations = [...block.matchAll(/animation:[^;]*?var\(--flash-ms[^;]*;/g)];
  assert.ok(durations.length >= 4, 'every animated layer takes its length from --flash-ms');
  assert.doesNotMatch(
    block.replace(/var\(--flash-ms[^)]*\)/g, ''),
    /animation:[^;]*\d+m?s/,
    'no layer carries a hardcoded duration alongside it'
  );
});

test('the light animates nothing that can cost a frame', () => {
  // Several seconds of this plays while somebody is typing and scrolling. Anything
  // outside transform/opacity means layout or paint work every frame, and the blur
  // in here is only free because it sits on a layer that merely rotates.
  const keyframes = [...css.matchAll(/@keyframes\s+(agent-flash-[\w-]+)\s*\{([\s\S]*?)\n\}/g)];
  assert.ok(keyframes.length >= 4, 'found the light’s keyframes');

  const allowed = /^(transform|opacity)$/;
  for (const [, name, body] of keyframes) {
    for (const [, prop] of body.matchAll(/^\s{4}([a-z-]+):/gm)) {
      assert.match(prop, allowed, `@keyframes ${name} animates ${prop}`);
    }
  }
});

test('reduced motion stops the movement rather than only slowing it', () => {
  const idx = css.lastIndexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('/* Approval card.'));
  const block = css.slice(idx, css.indexOf('/* Approval card.'));
  for (const layer of ['.agent-flash-prism', '.agent-flash-sheen', '.agent-flash-frames i']) {
    assert.ok(block.includes(layer), `${layer} is quieted under reduced motion`);
  }
  assert.match(block, /animation:\s*none/, 'and quieted by stopping, not by retiming');
});

test('the scroller is a sibling of the light, and can still shrink', () => {
  // Two bugs live here. Inside .messages the light would resolve `inset: 0` against
  // the scrolled content — as tall as the whole conversation, sliding out of view
  // as you read. And a flex child holding a scroller refuses to shrink without
  // min-height: 0, which pushes the composer off the bottom of the window.
  const wrap = css.slice(css.indexOf('.messages-wrap {'), css.indexOf('.messages {'));
  assert.match(wrap, /position:\s*relative/);
  assert.match(wrap, /min-height:\s*0/);
  assert.match(wrap, /isolation:\s*isolate/, 'the blend modes stay inside the chat');

  const messages = css.slice(css.indexOf('.messages {'), css.indexOf('.day-sep {'));
  assert.match(messages, /overflow-y:\s*auto/, '.messages is still the scroller');
  assert.match(messages, /z-index:\s*1/, 'and sits above the light');

  const pane = fs.readFileSync(path.join(SRC, 'components', 'ChatPane.jsx'), 'utf8');
  const wrapAt = pane.indexOf('className="messages-wrap"');
  const scrollerAt = pane.indexOf('className="messages"');
  const closeAt = pane.indexOf('</div>', pane.indexOf('<AgentApproval'));
  const flashAt = pane.indexOf('<AgentFlash');
  const typingAt = pane.indexOf('className="typing"');
  const composerAt = pane.indexOf('<Composer');
  assert.ok(wrapAt > 0 && scrollerAt > wrapAt, 'the scroller is inside the wrapper');
  assert.ok(flashAt > closeAt, 'and the light is outside the scroller, after it closes');
  // The typing row belongs to the lit area too. Left outside it, the light stops
  // short of the composer and leaves a black band — which is what v0.4.23 shipped.
  assert.ok(typingAt > closeAt && typingAt < flashAt, 'the typing row is inside the wrapper');
  assert.ok(composerAt > flashAt, 'and the composer is outside it, below the light');

  // The column that lets the scroller and the typing row share the box.
  assert.match(wrap, /flex-direction:\s*column/);
  const typingCss = css.slice(css.indexOf('.typing {'), css.indexOf('.typing {') + 400);
  assert.match(typingCss, /z-index:\s*1/, 'and the typing text sits above the light');
});

test('the light never takes pointer events, so chatting continues underneath it', () => {
  const block = css.slice(css.indexOf('.agent-flash {'), css.indexOf('.agent-flash-art'));
  assert.match(block, /pointer-events:\s*none/);
  assert.match(block, /position:\s*absolute/);
  assert.match(block, /inset:\s*0/, 'and fills the box it is given');
});

// ------------------------------------------------------------------ the component

// The real component, transformed the way vite would and rendered to markup, so
// what is asserted below is what the app mounts rather than a fixture of it.
function renderFlash(props) {
  const esbuild = require('esbuild');
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const src = fs.readFileSync(path.join(SRC, 'components', 'AgentFlash.jsx'), 'utf8');
  const { code } = esbuild.transformSync(src, { loader: 'jsx', format: 'cjs' });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', code)(mod, mod.exports, (id) =>
    id === 'react' ? React : require(id)
  );
  const AgentFlash = mod.exports.default;
  return { markup: renderToStaticMarkup(React.createElement(AgentFlash, props)), React, AgentFlash };
}

test('the light says what it means, for somebody who cannot see it', () => {
  // The visuals are aria-hidden, so on their own this would be a state conveyed by
  // motion and colour alone.
  const { markup } = renderFlash({ mode: 'connected', ms: 5000, name: 'Tessie', onDone: () => {} });
  assert.match(markup, /role="status"/);
  assert.match(markup, /aria-live="polite"/, 'polite, so it never cuts across what is being read');
  assert.match(markup, /Connected to Tessie/);
  assert.match(markup, /aria-hidden="true"/, 'and the decoration is skipped');

  const empty = renderFlash({ mode: 'empty', ms: 1400, name: 'Tessie', onDone: () => {} });
  assert.match(empty.markup, /finished with no output/);
  // Not the words this whole change removed.
  assert.doesNotMatch(empty.markup, /\(no output\)/);
});

test('the duration it was given is the duration it uses', () => {
  const { markup } = renderFlash({ mode: 'connected', ms: 7321, name: 'A', onDone: () => {} });
  assert.match(markup, /--flash-ms:\s*7321ms/, 'handed to the CSS rather than re-derived there');
  assert.match(markup, /class="agent-flash connected"/);
});

test('every frame of the corridor is placed and lit, and the reflection matches it', () => {
  const { markup } = renderFlash({ mode: 'connected', ms: 5000, name: 'A', onDone: () => {} });
  const frames = [...markup.matchAll(/--z:\s*(-?\d+)px/g)].map((m) => Number(m[1]));
  assert.ok(frames.length >= 12, 'the frames and their reflection are both drawn');
  assert.equal(frames.length % 2, 0, 'and the reflection holds the same set');
  const half = frames.length / 2;
  assert.deepEqual(frames.slice(0, half), frames.slice(half), 'in the same order');
  assert.ok(new Set(frames).size > 1, 'at different depths, which is what makes it a corridor');

  // The hues come from the palette that was already matched to the reference, not
  // from a second set of near-identical tokens.
  assert.match(markup, /--edge:\s*var\(--streak-(violet|magenta|amber)\)/);
  assert.doesNotMatch(markup, /--edge:\s*#/, 'no raw hex in the component');
});

// The behaviour that only exists once it is mounted in something that can lay it
// out and run its effects. Driven in a real browser rather than a DOM stand-in,
// because the things being checked here — that it fills the box it is given, that
// it lets clicks through, that it holds still under reduced motion — are all
// resolved by a layout engine and would have to be faked otherwise.
//
// The harness lives in scripts/ so it can be run by hand while working on the
// light; this test is the same run, with assertions.
test('mounted in a browser: one light, filling its box, letting everything through', async () => {
  const { runFlashHarness } = require('../scripts/flash-harness.js');
  const result = await runFlashHarness();
  if (result.skipped) {
    // Chromium is not always present. Say so rather than reporting a pass that
    // never happened — everything above still runs.
    console.log(`# skipped browser checks: ${result.skipped}`);
    return;
  }

  // Fills the whole visible message area, to the border. A decorative light that
  // stops short of the edges reads as a misplaced box rather than as the room
  // lighting up.
  assert.ok(result.coversBox, `the light did not fill its box: ${JSON.stringify(result.rects)}`);

  // And its box is the whole conversation area, not just the scroller. Measuring
  // the light against its own wrapper cannot see a gap below that wrapper — both
  // grow together and it passes. v0.4.23 shipped a black band across the bottom
  // because the typing row sat outside the box, so the neighbours are checked too.
  assert.equal(result.gapAbove, 0, 'a dark band between the header and the light');
  assert.equal(result.gapBelow, 0, 'a dark band between the light and the composer');
  assert.equal(result.typingCovered, true, 'the typing row sits inside the lit area');
  assert.equal(result.pointerEvents, 'none', 'clicks must reach the conversation underneath');
  assert.equal(result.clickReachedBelow, true, 'and they actually do');

  // Two plays in a row replace each other. Two overlapping runs at different
  // phases is the one way this effect could look broken.
  assert.equal(result.lightsAfterSecondPlay, 1);

  // Unmounted before its time is up: nothing fires afterwards.
  assert.equal(result.doneAfterUnmount, 0, 'the timer went with the component');
  // And it does finish on its own when left alone.
  assert.equal(result.doneAfterFullRun, 1);

  // Under reduced motion the layers hold still.
  assert.deepEqual(result.reducedMotionAnimations, [], 'nothing animates under reduced motion');

  // The text over it keeps the contrast it had. Measured from the pixels as a
  // ratio rather than byte-for-byte: a composited layer underneath makes chromium
  // drop subpixel antialiasing, which moves every glyph edge without touching how
  // readable any of it is. See compareGlyphs in the harness.
  assert.ok(
    result.bubbleContrastDelta < 0.02,
    `text contrast shifted by ${(result.bubbleContrastDelta * 100).toFixed(1)}% with the light behind it`
  );
});
