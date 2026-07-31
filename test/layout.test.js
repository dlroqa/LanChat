'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The window's frame: three columns as tall as the window, each holding a
// scrolling panel, with the compose box below the conversation.
//
// v0.4.24 shipped with the compose box unreachable. `.app` is a grid and had
// `grid-template-columns` but no rows, so its items landed in an implicit row —
// and an implicit row is `auto`, sized to its items' max-content, which for the
// chat column is the full unscrolled height of every message. The row grew past
// the window, and everything below the scroller went with it: the typing row and
// the composer, off the bottom, into `body { overflow: hidden }`. The peer list
// did the same on the other side.
//
// Nothing about that is visible in the rules of the chat column, which were
// already careful and already correct. It is a property of the whole assembly,
// so most of what is checked here is checked by laying the real stylesheet out in
// a real browser. The two text assertions below are for the pieces where knowing
// the rule is there is worth more than measuring its effect once.

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');

function block(selector) {
  const m = css.match(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  return m ? m[2] : null;
}

// --------------------------------------------------------------- the rules

test('the grid gives its columns a row to sit in, and one that can shrink', () => {
  const app = block('.app');
  assert.ok(app, '.app should still be in styles.css');

  // The line the composer's presence rests on. `1fr` on its own would look right
  // and do nothing — a flex track's automatic minimum is its max-content size,
  // which is the whole conversation again — so the `minmax(0, ...)` is the part
  // being pinned, not the row declaration.
  assert.match(app, /grid-template-rows:\s*minmax\(0,\s*1fr\)/);

  // And any row the grid grows on its own is bounded the same way, so a child
  // added in front of the three panels cannot reintroduce a max-content row.
  assert.match(app, /grid-auto-rows:\s*minmax\(0,\s*1fr\)/);
});

test('every scroller in a column may shrink below what is in it', () => {
  // A `flex: 1` element that scrolls needs `min-height: 0`, or it refuses to go
  // below its content height and pushes its siblings out of the window instead
  // of scrolling. Both of the app's long lists are one of these.
  for (const selector of ['.messages', '.peer-list']) {
    const rules = block(selector);
    assert.ok(rules, `${selector} should still be in styles.css`);
    assert.match(rules, /min-height:\s*0/, `${selector} needs min-height: 0 to scroll instead of spilling`);
  }
});

test('the composer is never the thing that gives way', () => {
  assert.match(block('.composer-wrap'), /flex:\s*none/);
});

test('the input has one ceiling, and it knows how tall the window is', () => {
  // Two copies of this number is how it drifts: the stylesheet clamped at 160px
  // and Composer.jsx clamped at 160 again, in JavaScript, where nothing would
  // ever tell you they had stopped agreeing.
  assert.match(block('.composer textarea'), /max-height:\s*min\(160px,\s*var\(--composer-max\)\)/);

  const composer = fs.readFileSync(path.join(SRC, 'components', 'Composer.jsx'), 'utf8');
  assert.doesNotMatch(composer, /Math\.min\(el\.scrollHeight/, 'the cap belongs to the stylesheet alone');
  // And the height is re-measured when the window changes, not only when the
  // text does — the same words wrap onto more lines in a narrower window.
  assert.match(composer, /new ResizeObserver/);
  assert.match(composer, /observer\.disconnect\(\)/, 'the observer must not outlive the component');

  // The observer is built once for the life of the component, not per keystroke.
  // Its effect must not depend on the text: reading geometry after a style write
  // is a forced synchronous layout of the whole window, and it measured 2.6ms a
  // character with a long conversation open against 0.8ms without.
  const observerEffect = composer.match(/useEffect\(\(\) => \{[^]*?new ResizeObserver[^]*?\}, \[([^\]]*)\]\)/);
  assert.ok(observerEffect, 'the observer should live in its own effect');
  assert.doesNotMatch(observerEffect[1], /\btext\b/, 'the observer must not be rebuilt when the text changes');
});

test('the responsive override comes after the rule it overrides', () => {
  // A media query adds no specificity. `.side-panel { display: none }` written
  // above `.side-panel { display: flex }` loses on source order and does nothing
  // — which is what had happened: on a narrow window the panel did not go away,
  // it wrapped onto a second grid row below the fold.
  const narrow = css.lastIndexOf('@media (max-width: 980px)');
  const panel = css.indexOf('\n.side-panel {');
  assert.ok(narrow > -1 && panel > -1);
  assert.ok(narrow > panel, 'the narrow-window override must come after .side-panel');
});

test('the status row takes its type scale from the panel it sits in', () => {
  // The panel used to be one of two fixed widths and --label-fit was a matching
  // pair of measured constants. It is a clamp now, so a two-value step function
  // would size the type for a 300px panel across most of the range it is
  // actually drawn at — 374px at 1440, where the phrase would set ~3px smaller
  // than it needed to. Deriving both from --side-w keeps them in step.
  assert.match(block('.agent-state'), /--label-fit:\s*calc\(8\.625 \* var\(--side-w\)/);
  assert.match(block(':root'), /--side-w:\s*clamp\(300px, 26vw, 380px\)/);
  assert.doesNotMatch(css, /@media \(max-width: 1460px\)/, 'the breakpoint it replaces should be gone');
});

test('the harness mirrors the nesting the app actually renders', () => {
  // The browser checks below measure hand-written markup. If ChatPane stops
  // putting the composer inside .chat, or moves the scroller out of
  // .messages-wrap, every assertion here would keep passing against a structure
  // the app no longer has. Same guard connectFlash.test.js keeps over its own
  // harness.
  const pane = fs.readFileSync(path.join(SRC, 'components', 'ChatPane.jsx'), 'utf8');
  const chat = pane.slice(pane.indexOf('className="chat"'));
  const wrap = chat.indexOf('className="messages-wrap"');
  const list = chat.indexOf('className="messages"');
  const composer = chat.indexOf('<Composer');
  assert.ok(wrap > -1 && list > wrap, '.messages should still be inside .messages-wrap');
  assert.ok(composer > list, 'the composer should still follow the conversation inside .chat');

  // The sidebar's vertical stack, for the same reason: the profile block, the
  // row of actions under it, the search box and the list are four rows in a
  // column, and a harness missing one of them measures a sidebar the app does
  // not have.
  const sidebar = fs.readFileSync(path.join(SRC, 'components', 'Sidebar.jsx'), 'utf8');
  const order = ['className="me"', 'className="me-actions"', 'className="sidebar-search"', 'className="peer-list"'];
  let at = -1;
  for (const marker of order) {
    const next = sidebar.indexOf(marker);
    assert.ok(next > at, `${marker} should still come after the row above it in Sidebar.jsx`);
    at = next;
  }

  const markup = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'layout-harness.js'), 'utf8');
  for (const cls of ['chat-wrap', 'chat-header', 'messages-wrap', 'messages', 'typing', 'composer-wrap', 'me-actions']) {
    assert.match(markup, new RegExp(`class="${cls}"`), `the harness should still build .${cls}`);
  }
});

// --------------------------------------------------- laid out in a browser

// What the rules above add up to, measured rather than inferred. Every one of
// these was true of the broken build in the sense that the rules were there; the
// only thing that could have caught it is asking a layout engine where the
// composer actually ended up.
//
// The harness lives in scripts/ so it can be run by hand, with screenshots, while
// working on the frame; these tests are the same run, with assertions.
//
// One run, shared. It is four browser launches and about twelve seconds, and its
// answer is a pure function of the stylesheet on disk — so the two checks below
// ask different questions of the same numbers rather than measuring twice.
let browserRun = null;
function laidOut() {
  const { runLayoutHarness } = require('../scripts/layout-harness.js');
  browserRun ||= runLayoutHarness();
  return browserRun;
}

// Chromium is not always present. Say so rather than reporting a pass that never
// happened — everything above still runs.
function skipped(result) {
  if (!result.skipped) return false;
  console.log(`# skipped browser checks: ${result.skipped}`);
  return true;
}

test('laid out in a browser: the composer is on screen at every window size', async () => {
  const result = await laidOut();
  if (skipped(result)) return;

  for (const [name, m] of Object.entries(result.sizes)) {
    const where = `${name} (${m.viewport.w}x${m.viewport.h})`;

    // The conversation and the peer list are both longer than the window. If
    // they were not, everything below would pass for the wrong reason — the bug
    // only exists once there is more content than there is room.
    assert.ok(m.messagesScrolls, `${where}: the conversation should be overflowing`);
    assert.ok(m.peersScroll, `${where}: the peer list should be overflowing`);

    // Nothing extends the page. body is overflow:hidden, so a page taller than
    // the window is content that has been pushed somewhere nobody can reach.
    assert.equal(m.pageOverflow, 0, `${where}: ${m.pageOverflow}px of the window is off screen`);

    // The composer sits on the bottom edge — present, whole, and not scrolled to.
    assert.equal(m.composer.bottom, m.viewport.h, `${where}: the composer is not at the bottom of the window`);
    assert.ok(m.composer.h > 0, `${where}: the composer has no height`);

    // And it is a composer, not a panel: the conversation keeps most of the room
    // even in the shortest window the app will open at.
    const share = m.composer.h / m.viewport.h;
    assert.ok(share < 0.4, `${where}: the composer takes ${Math.round(share * 100)}% of the height`);

    // Every panel is bounded by the window rather than by its own contents.
    for (const part of ['sidebar', 'chatWrap', 'peerList', 'messages']) {
      assert.ok(m[part].bottom <= m.viewport.h + 1, `${where}: .${part} runs ${m[part].bottom - m.viewport.h}px past the bottom`);
    }
  }
});

test('laid out in a browser: the four actions under the name are whole at every width', async () => {
  const result = await laidOut();
  if (skipped(result)) return;

  for (const [name, m] of Object.entries(result.sizes)) {
    const where = `${name} (${m.viewport.w}x${m.viewport.h})`;
    assert.equal(m.actionButtons.length, 4, `${where}: all four actions should be in the row`);

    for (const b of m.actionButtons) {
      // Full-size targets. The row exists because three of these were already
      // crowded against the window edge beside the name; a fourth that only fits
      // by shrinking would have been no better than leaving them there.
      assert.equal(b.w, 34, `${where}: an action button is ${b.w}px wide`);
      assert.equal(b.h, 34, `${where}: an action button is ${b.h}px tall`);
      assert.ok(
        b.right <= m.sidebar.x + m.sidebar.w,
        `${where}: an action button runs ${b.right - (m.sidebar.x + m.sidebar.w)}px past the sidebar`
      );
    }

    // Eight of the 34px sit inside each button, so the first glyph lands on the
    // same left edge as the avatar above it rather than a few pixels in.
    assert.equal(m.actionButtons[0].x, m.sidebar.x + 6, `${where}: the row does not line up with the name above it`);

    // And the row is a row: the search box follows it, rather than being pushed
    // out of the sidebar by it.
    assert.ok(m.search.top >= m.meActions.bottom, `${where}: the search box overlaps the actions above it`);
    assert.ok(m.peerList.top >= m.search.bottom, `${where}: the list overlaps the search box`);
  }
});

test('laid out in a browser: the columns share the width as it grows', async () => {
  const result = await laidOut();
  if (skipped(result)) return;
  const { min, default: dflt, wide, widest } = result.sizes;

  // Narrowest: two columns, and the third is gone rather than wrapped below.
  assert.equal(min.sidePanel, null, 'the side panel should be hidden at 820px');

  // Through the middle the side columns grow with the window instead of standing
  // still while the conversation takes every added pixel.
  assert.ok(wide.sidebar.w > dflt.sidebar.w, 'the sidebar should grow with the window');
  assert.ok(wide.sidePanel.w > dflt.sidePanel.w, 'the side panel should grow with the window');

  // And they stop. A 1920px window gets a wider conversation, not a 500px list
  // of eight people.
  assert.equal(widest.sidebar.w, 340, 'the sidebar stops growing at its cap');
  assert.equal(widest.sidePanel.w, 380, 'the side panel stops growing at its cap');
  assert.ok(widest.chatWrap.w > wide.chatWrap.w, 'the conversation takes what is left');

  // The status row's type scale follows the panel it is drawn in. A step
  // function would have set the same size across the whole clamped range,
  // pitching the type for a 300px panel at 1440, where it is actually 374.
  const panels = [dflt, wide, widest];
  for (let i = 1; i < panels.length; i += 1) {
    assert.ok(
      panels[i].labelFontSize >= panels[i - 1].labelFontSize,
      `the status phrase should not shrink as the panel widens: ${panels.map((p) => p.labelFontSize)}`
    );
  }
  assert.ok(wide.labelFontSize > dflt.labelFontSize, 'a wider panel should carry larger type');

  // Within its bounds either way — the 11px floor and the 17px cap the row was
  // designed around — and the row itself never grows to accommodate the phrase.
  for (const [name, m] of Object.entries(result.sizes)) {
    if (!m.sidePanel) continue;
    assert.ok(
      m.labelFontSize >= 11 && m.labelFontSize <= 17,
      `${name}: the status phrase set at ${m.labelFontSize}px, outside its 11-17px range`
    );
    assert.equal(m.labelRow.h, 90, `${name}: the status row should hold its height whatever the phrase is`);
  }

  // And the input's ceiling follows the window's height, not just a fixed 160px:
  // in the shortest window the app opens at, the viewport half of the min() is
  // what should be in force.
  assert.ok(
    parseFloat(min.textareaMaxHeight) < 160,
    `the input should be capped below 160px in a ${min.viewport.h}px window, was ${min.textareaMaxHeight}`
  );
});
