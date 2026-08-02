'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Finding a word in a conversation.
//
// The counter says "5 of 17" and the arrows walk those 17 in the order they are
// read on screen. That is one claim made in two places — the pane counts, the
// bubbles mark — so what is pinned here is that both are counting the same
// things in the same order, and that marking a message never changes a
// character of what it says.
//
// The scanner runs in the renderer (ESM for the browser), so the `export`
// keywords come off, the same way test/linkify.test.js loads the link scanner.
const SRC = path.join(__dirname, '..', 'src', 'renderer');
const { matchRanges, searchableFields, countHits, fieldHits, threadHits, sliceRuns } = new Function(
  `${fs.readFileSync(path.join(SRC, 'lib', 'findInThread.js'), 'utf8').replace(/^export\s+/gm, '')}
   return { matchRanges, searchableFields, countHits, fieldHits, threadHits, sliceRuns };`
)();

const { linkify } = new Function(
  `${fs.readFileSync(path.join(SRC, 'lib', 'linkify.js'), 'utf8').replace(/^export\s+/gm, '')}
   return { linkify };`
)();

const joined = (runs) => runs.map((r) => r.text).join('');

// ------------------------------------------------------------------ the scanner

test('a word is found however it was capitalised, and counted once per occurrence', () => {
  const text = 'Kangkong is water spinach. kangkong grows fast. KANGKONG again.';
  assert.equal(matchRanges(text, 'kangkong').length, 3);
  assert.equal(matchRanges(text, 'KaNgKoNg').length, 3);
  // The offsets point at the original text, not at a lowercased copy of it.
  for (const range of matchRanges(text, 'kangkong')) {
    assert.equal(text.slice(range.start, range.end).toLowerCase(), 'kangkong');
  }
});

test('overlapping occurrences are counted once each, so every hit can be visited', () => {
  // "aaaa" contains "aa" three times if they may overlap. The arrows can only
  // stop at two of them, so two is what the counter must say.
  assert.equal(matchRanges('aaaa', 'aa').length, 2);
  assert.deepEqual(matchRanges('aaaa', 'aa'), [
    { start: 0, end: 2 },
    { start: 2, end: 4 },
  ]);
});

test('nothing is a search for nothing', () => {
  assert.deepEqual(matchRanges('kangkong', ''), []);
  assert.deepEqual(matchRanges('kangkong', '   '), []);
  assert.deepEqual(matchRanges('', 'kangkong'), []);
  assert.deepEqual(matchRanges(null, 'a'), []);
});

test('a space typed at the end is a space searched for, as it is in a browser', () => {
  assert.equal(matchRanges('kangkong plant', 'kangkong ').length, 1);
  assert.equal(matchRanges('kangkong.', 'kangkong ').length, 0);
});

test('a character that grows when lowercased never shifts the offsets', () => {
  // 'İ'.toLowerCase() is two code units. Marking by offsets taken from that copy
  // would put the highlight on the wrong letters, so the scan falls back to
  // matching exactly as typed rather than lying about where the word is.
  const text = 'İstanbul kangkong';
  for (const range of matchRanges(text, 'kangkong')) {
    assert.equal(text.slice(range.start, range.end), 'kangkong');
  }
});

// ------------------------------------------------------------------ the ordering

const bubble = (over) => ({ id: 'm1', ts: 1, direction: 'in', kind: 'text', text: 'plain', ...over });

test('a message is searched in the order it is read: quote, then documents, then what was said', () => {
  const msg = bubble({
    context: { speaker: 'Tessie', text: 'about kangkong' },
    docs: [
      { name: 'kangkong.pdf', bytes: 10 },
      { name: 'notes.txt', bytes: 10 },
    ],
    text: 'more kangkong here',
  });
  assert.deepEqual(
    searchableFields(msg).map((f) => f.key),
    ['context', 'doc:0', 'doc:1', 'text']
  );
  assert.equal(countHits(msg, 'kangkong'), 3);

  const hits = fieldHits(msg, 'kangkong', 0);
  assert.equal(hits.get('context').base, 0, 'the quote is read first, so it is numbered first');
  assert.equal(hits.get('doc:0').base, 1);
  assert.equal(hits.get('doc:1').base, 2, 'a document with no hit still holds its place');
  assert.deepEqual(hits.get('doc:1').ranges, []);
  assert.equal(hits.get('text').base, 2, 'and the message itself picks up where the documents left off');
});

test('a file bubble is searched by the only thing it shows: the name of the file', () => {
  const msg = bubble({ kind: 'file', text: '', file: { name: 'kangkong-photo.jpg', size: 9 } });
  assert.deepEqual(
    searchableFields(msg).map((f) => f.key),
    ['file']
  );
  assert.equal(countHits(msg, 'kangkong'), 1);
});

test('the thread numbers its hits from the top, message by message', () => {
  const messages = [
    bubble({ id: 'a', text: 'kangkong' }),
    bubble({ id: 'b', text: 'nothing here' }),
    bubble({ id: 'c', text: 'kangkong and kangkong' }),
  ];
  const { total, bases } = threadHits(messages, 'kangkong');
  assert.equal(total, 3);
  assert.deepEqual([bases.get('a'), bases.get('b'), bases.get('c')], [0, 1, 1]);
  assert.equal(threadHits(messages, '').total, 0, 'and an empty box finds nothing at all');
});

// ------------------------------------------------------------------ the marking

test('marking a message never changes a character of it', () => {
  const text = 'See https://example.com/kangkong-guide for kangkong, and kangkong again.';
  const runs = linkify(text);
  const ranges = matchRanges(text, 'kangkong');
  assert.equal(ranges.length, 3);

  const pieces = sliceRuns(runs, ranges, 0);
  // linkify's invariant, kept through a second cut: what is rendered is exactly
  // what was said.
  assert.equal(joined(pieces), text);
  assert.equal(joined(sliceRuns(runs, [], 0)), text);

  // Every piece is wholly inside a hit or wholly outside one.
  const marked = pieces.filter((p) => p.hit != null);
  assert.equal(new Set(marked.map((p) => p.hit)).size, 3, 'three occurrences, three ordinals');
  assert.deepEqual([...new Set(marked.map((p) => p.hit))].sort(), [0, 1, 2]);
});

test('a word that begins in a sentence and ends inside a link stays one occurrence', () => {
  const text = 'go to www.kangkong.example now';
  const runs = linkify(text);
  assert.ok(
    runs.some((r) => r.type === 'link'),
    'the link is found first, which is what makes this two runs'
  );
  // "to www.kang" straddles the boundary between the text and the link.
  const ranges = matchRanges(text, 'to www.kang');
  const pieces = sliceRuns(runs, ranges, 0);
  assert.equal(joined(pieces), text);

  const marked = pieces.filter((p) => p.hit != null);
  assert.ok(marked.length > 1, 'it comes back in more than one piece');
  assert.deepEqual(new Set(marked.map((p) => p.hit)), new Set([0]), 'all carrying the one ordinal');
  // The half inside the link is still a link, and still points where it did.
  const inLink = marked.find((p) => p.type === 'link');
  assert.ok(inLink && inLink.href.startsWith('https://www.kangkong.example'));
});

test('ordinals are counted from the base the thread handed out', () => {
  const runs = [{ type: 'text', text: 'kangkong kangkong' }];
  const pieces = sliceRuns(runs, matchRanges('kangkong kangkong', 'kangkong'), 7);
  assert.deepEqual(
    pieces.filter((p) => p.hit != null).map((p) => p.hit),
    [7, 8]
  );
});

// ------------------------------------------------------------------ the components

// The real components, transformed the way vite would and rendered to markup, so
// what is asserted below is what the app mounts rather than a fixture of it.
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const cache = new Map();

function load(file) {
  if (cache.has(file)) return cache.get(file);
  const esbuild = require('esbuild');
  const { code } = esbuild.transformSync(fs.readFileSync(file, 'utf8'), { loader: 'jsx', format: 'cjs' });
  const mod = { exports: {} };
  cache.set(file, mod.exports);
  new Function('module', 'exports', 'require', code)(mod, mod.exports, (id) => {
    if (id === 'react') return React;
    if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id));
    return require(id);
  });
  // The cached placeholder is replaced by whatever the module actually exported.
  cache.set(file, mod.exports);
  return mod.exports;
}

const FindBar = load(path.join(SRC, 'components', 'FindBar.jsx')).default;
const MessageBubble = load(path.join(SRC, 'components', 'MessageBubble.jsx')).default;

const bar = (props) =>
  renderToStaticMarkup(
    React.createElement(FindBar, {
      query: '',
      count: 0,
      index: -1,
      onQuery: () => {},
      onNext: () => {},
      onPrev: () => {},
      onClose: () => {},
      ...props,
    })
  );

test('the bar says how many, and says it to somebody who cannot see it', () => {
  const markup = bar({ query: 'kangkong', count: 17, index: 2 });
  assert.match(markup, /role="search"/);
  assert.match(markup, /3\/17/, 'counted from one, the way it is read aloud');
  assert.match(markup, /role="status"/);
  assert.match(markup, /aria-live="polite"/, 'polite, so it waits for the keystroke being read');
  assert.match(markup, /aria-label="Find in this conversation"/);
  assert.match(markup, /aria-label="Previous match"/);
  assert.match(markup, /aria-label="Next match"/);
  assert.match(markup, /aria-label="Close find"/, 'every icon-only button says what it is');
  assert.doesNotMatch(markup, /#[0-9a-fA-F]{3,8}\b/, 'no raw hex in the component');
});

test('a word that is not there says so, and the arrows go dead rather than lying', () => {
  const markup = bar({ query: 'zzz', count: 0, index: -1 });
  assert.match(markup, /no matches/);
  assert.equal((markup.match(/disabled/g) || []).length, 2, 'both arrows');

  const empty = bar({ query: '', count: 0, index: -1 });
  assert.doesNotMatch(
    empty.slice(empty.indexOf('find-count')),
    /no matches/,
    'an empty box has found nothing yet'
  );
});

const msg = (over) => ({
  id: 'm1',
  ts: Date.UTC(2026, 6, 31, 12),
  direction: 'in',
  kind: 'text',
  text: 'Kangkong is water spinach. Kangkong grows fast.',
  ...over,
});

const render = (over, find) =>
  renderToStaticMarkup(
    React.createElement(MessageBubble, {
      msg: msg(over),
      grouped: false,
      progress: undefined,
      onOpen: () => {},
      onReveal: () => {},
      onOpenLink: () => {},
      find,
    })
  );

test('a bubble with nothing being searched is the bubble that was always there', () => {
  const markup = render({});
  assert.doesNotMatch(markup, /<mark/, 'no marking at all when nobody is searching');
  assert.match(markup, /Kangkong is water spinach/);
});

test('every occurrence is marked, and exactly one of them is the one being pointed at', () => {
  const markup = render({}, { query: 'kangkong', base: 0, current: 1 });
  const marks = markup.match(/<mark[^>]*>/g) || [];
  assert.equal(marks.length, 2, 'both occurrences are shown, not only the current one');
  assert.equal(marks.filter((m) => /current/.test(m)).length, 1);
  assert.match(marks[1], /class="find-hit current"/, 'the second one, which is the one asked for');
  assert.match(marks[0], /data-hit="0"/);
  assert.match(marks[1], /data-hit="1"/, 'numbered so the pane can find this one on screen');
  // Marking splits the text; it must not eat any of it.
  assert.equal(
    markup.replace(/<[^>]+>/g, '').includes('Kangkong is water spinach. Kangkong grows fast.'),
    true
  );
});

test('the name of a file and the excerpt a fork pinned are searched too', () => {
  const file = render(
    { kind: 'file', text: '', file: { name: 'kangkong-photo.jpg', size: 12 } },
    { query: 'kangkong', base: 0, current: 0 }
  );
  assert.match(file, /<mark class="find-hit current" data-hit="0">kangkong<\/mark>-photo\.jpg/);

  const quoted = render(
    { context: { speaker: 'Tessie', text: 'the kangkong question' }, text: 'and kangkong again' },
    { query: 'kangkong', base: 4, current: 5 }
  );
  const marks = quoted.match(/data-hit="(\d+)"/g) || [];
  assert.deepEqual(marks, ['data-hit="4"', 'data-hit="5"'], 'the quote is numbered before the question');
});

// ------------------------------------------------------------------ the stylesheet

const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');
const block = (selector) => {
  const at = css.indexOf(selector);
  assert.ok(at > 0, `${selector} exists`);
  return css.slice(at, css.indexOf('}', at));
};

test('the bar floats over the conversation instead of pushing it down', () => {
  const rule = block('.find-bar {');
  assert.match(rule, /position:\s*absolute/);
  assert.match(rule, /z-index:\s*3/);
  // .messages sits at z-index 1 in the same stacking context, so 3 is above it.
  assert.match(block('.messages {'), /z-index:\s*1/);
});

test('the harness mirrors what the pane renders', () => {
  // The browser checks below measure hand-written markup. If ChatPane stops
  // putting the bar inside .messages-wrap, or above the scroller, the numbers
  // would keep coming back green for a layout the app no longer has.
  const pane = fs.readFileSync(path.join(SRC, 'components', 'ChatPane.jsx'), 'utf8');
  const wrap = pane.indexOf('className="messages-wrap"');
  const bar = pane.indexOf('<FindBar');
  const list = pane.indexOf('className="messages"', wrap);
  assert.ok(wrap > -1 && bar > wrap, 'the find bar should be inside .messages-wrap');
  assert.ok(list > bar, 'and above the scroller it floats over');

  const harness = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'find-harness.js'), 'utf8');
  for (const cls of ['find-bar', 'find-count', 'find-btn on', 'messages-wrap', 'bubble']) {
    assert.match(harness, new RegExp(`class="${cls}`), `the harness should still build .${cls}`);
  }
  assert.match(harness, /class="find-hit"/);
  assert.match(harness, /class="find-hit current"/);
});

// What the rules add up to once a browser has composited them. A highlight is a
// colour on top of another colour, and which colours those turn out to be is not
// something a stylesheet can be read for — so this photographs it and measures
// the picture.
let findRun = null;
function photographed() {
  const { runFindHarness } = require('../scripts/find-harness.js');
  findRun ||= runFindHarness();
  return findRun;
}

test('photographed in a browser: a marked word is readable in either kind of bubble', async () => {
  const result = await photographed();
  if (result.skipped) {
    console.log(`# skipped browser checks: ${result.skipped}`);
    return;
  }

  // The controls first. These are the app's own message text, whose contrast has
  // always shipped — if the method cannot see them passing, its answer about the
  // highlights means nothing.
  assert.ok(
    result.colours['plain-in'].contrast > 10,
    `unmarked text on a surface bubble: ${result.colours['plain-in'].contrast}`
  );
  assert.ok(
    result.colours['plain-out'].contrast >= 4.5,
    `unmarked text on a primary bubble: ${result.colours['plain-out'].contrast}`
  );

  for (const id of ['hit-in', 'cur-in', 'hit-out', 'cur-out']) {
    const seen = result.colours[id];
    assert.ok(seen.inkShare > 0.01, `${id}: the sample found no text to measure`);
    assert.ok(seen.contrast >= 4.5, `${id}: marked text is ${seen.contrast}:1 against its highlight`);
  }

  // The same pair of colours either way. A tint would composite with the bubble
  // and give two different answers, one of which was 4.16:1.
  assert.deepEqual(result.colours['hit-in'].fill, result.colours['hit-out'].fill);
  assert.deepEqual(result.colours['cur-in'].fill, result.colours['cur-out'].fill);
  assert.notDeepEqual(
    result.colours['hit-in'].fill,
    result.colours['cur-in'].fill,
    'the current hit has to look different from the rest'
  );
});

test('photographed in a browser: the bar floats, and the header keeps its height', async () => {
  const result = await photographed();
  if (result.skipped) return;

  assert.equal(Math.round(result.header.height), 67, 'the header is pinned to --header-h');
  assert.equal(Math.round(result.findBar.top), 67, 'the bar hangs directly under it');
  assert.ok(result.overlaps, 'over the conversation rather than pushing it down');
  assert.ok(Number(result.barZ) > Number(result.messagesZ), 'and above it in the same stacking context');
  assert.equal(result.animation, 'find-in', 'it arrives by moving, which is what says where it came from');
  assert.equal(result.countFont, 'tabular-nums');
});

// The pane itself, mounted and used. Everything above is either a pure function
// or a photograph of a stylesheet; what is left — that Ctrl+F opens the bar, that
// the arrows walk the hits in reading order, that the view moves to the hit, and
// that an answer arriving mid-search does not drag the reader back to the bottom
// — only exists once React state, a scroller and a keyboard are in the same room.
let mounted = null;
function driven() {
  const { runFindMountHarness } = require('../scripts/find-mount-harness.js');
  mounted ||= runFindMountHarness();
  return mounted;
}

test('mounted in a browser: a word is found, counted, and walked through', async () => {
  const result = await driven();
  if (result.skipped) {
    console.log(`# skipped browser checks: ${result.skipped}`);
    return;
  }
  const { steps } = result;

  // The conversation has to be longer than the window, or nothing below is
  // testing anything: a hit that was already on screen never had to be found.
  assert.ok(result.scrolls, 'the conversation should be overflowing');
  assert.ok(result.startedAtBottom, 'and open at its newest message, the way the app opens it');

  assert.ok(steps.openedByShortcut, 'Ctrl+F should open the bar');
  assert.equal(steps.count, '5/5', 'five occurrences, starting at the last one');
  assert.equal(steps.marks, 5, 'and every one of them is marked, not only the current');
  assert.equal(steps.landedOn, '4', 'the last hit is the fifth, numbered from zero');
  assert.ok(Math.abs(steps.landedCentred) <= 2, `the hit is ${steps.landedCentred}px off the middle`);
  assert.ok(steps.movedOffBottom, 'and the view left the bottom to get to it');

  // Up is back through the conversation. The count says so and the view follows.
  assert.equal(steps.afterPrev.count, '4/5');
  assert.equal(steps.afterPrev.hit, '3');
  assert.ok(Math.abs(steps.afterPrev.offCentre) <= 2, 'the previous hit is centred too');

  assert.equal(steps.afterShiftEnter.count, '3/5', 'Shift+Enter is the same thing from the keyboard');
  assert.equal(steps.afterShiftEnter.hit, '2');
  assert.ok(steps.keyboardMovedToo, 'and it moved the view, not just the number');

  // Eight steps forward from the third of five ends on the first: the walk wraps
  // rather than stopping at the end.
  assert.equal(steps.afterWrapping.count, '1/5');
  assert.equal(steps.afterWrapping.hit, '0');
});

test('mounted in a browser: an answer arriving mid-search leaves the reader where they are', async () => {
  const result = await driven();
  if (result.skipped) return;
  const { steps } = result;

  // The pane jumps to the newest message whenever the conversation changes. That
  // is right for reading and wrong for searching: without the guard, an agent
  // answering while somebody is walking through matches pulls the conversation
  // out from under the one they were reading.
  assert.ok(steps.heldPosition, 'the view should not have moved when a message arrived');
  assert.ok(steps.stillAwayFromBottom, 'and should still be up in the history');
  assert.equal(steps.countAfterArrival, '3/5', 'with the walk still where it was');
});

test('mounted in a browser: Escape puts the bar away and the cursor back', async () => {
  const result = await driven();
  if (result.skipped) return;
  const { steps } = result;

  assert.ok(steps.closed, 'Escape closes the bar');
  assert.equal(steps.marksCleared, 0, 'and takes the highlighting with it');
  assert.equal(steps.focusAfterClose, 'TEXTAREA', 'leaving the cursor where typing happens');

  // And the button beside the name opens it again.
  assert.ok(steps.reopened.open);
  assert.equal(steps.reopened.count, '5/5');
});

test('the current hit is marked by more than its colour, and the count does not wobble', () => {
  // One treatment for one event: the roster's search marks its hits with this
  // same rule, so a word found in a name looks like a word found in a message
  // and neither needed a second pair of colours measured. The block therefore
  // begins at the shared selector rather than at find-hit's own.
  assert.match(css, /mark\.find-hit,\s*\n\s*mark\.result-hit \{/, 'the two searches should share one mark');
  assert.match(block('mark.result-hit {'), /background:\s*color-mix/);
  const current = block('mark.find-hit.current {');
  assert.match(current, /background:\s*var\(--warn\)/);
  assert.match(current, /box-shadow/, 'a fill and a ring — never colour alone');
  assert.match(block('.find-count {'), /font-variant-numeric:\s*tabular-nums/);
  // Motion is offered, not imposed.
  assert.match(
    css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('.find-bar {'))),
    /\.find-bar/
  );
});

// ------------------------------------------------- searching a markdown message
//
// Reading markdown changed what a bubble *draws* but not what a message *is*,
// and the search is built entirely on the second. The runs still add up to the
// stored text, so the counter, the ordinals and the arrows all keep counting the
// same string they always counted.

test('reading markdown does not change what a message says', () => {
  const png = '/home/agent/share/graph.png';
  const text = `Here is the [kangkong graph](sandbox:${png}) and the [notes](https://example.com/kangkong).`;
  const media = [{ name: 'graph.png', path: png, size: 40, mime: 'image/png' }];

  assert.equal(joined(linkify(text, media)), text, 'the runs are still the message');
  // Counted off the stored text, which is what the bubble re-cuts: once in the
  // first link's label, once inside the second link's target. Reading the
  // markdown neither added an occurrence nor hid one.
  assert.equal(countHits({ kind: 'text', text }, 'kangkong'), 2);
});

test('a hit inside a markdown target is still a hit that can be pointed at', () => {
  // The one thing reading markdown could have broken. The target is punctuation
  // and the bubble does not normally draw it — but the search numbered it, and
  // an ordinal on something that was never rendered is an arrow that scrolls
  // nowhere. So the piece carrying it has to survive the second cut intact, for
  // MessageText to be able to reveal exactly that piece.
  const text = 'see [the notes](https://example.com/kangkong)';
  const runs = linkify(text);
  const ranges = matchRanges(text, 'kangkong');
  assert.equal(ranges.length, 1);

  const pieces = sliceRuns(runs, ranges, 0);
  assert.equal(joined(pieces), text);
  const marked = pieces.filter((p) => p.hit != null);
  assert.equal(marked.length, 1);
  assert.equal(marked[0].type, 'syntax', 'the hit landed in the target');
  assert.equal(marked[0].text, 'kangkong');
});

test('a word straddling a markdown label and its target is one occurrence in two pieces', () => {
  const text = '[kangkong](https://example.com/x)';
  const runs = linkify(text);
  // "kangkong](" spans the label run and the syntax run after it.
  const ranges = matchRanges(text, 'kangkong](');
  const pieces = sliceRuns(runs, ranges, 7);

  assert.equal(joined(pieces), text, 'nothing is dropped at the seam');
  const marked = pieces.filter((p) => p.hit != null);
  assert.equal(marked.length, 2, 'two pieces');
  assert.deepEqual([...new Set(marked.map((p) => p.hit))], [7], 'carrying one ordinal');
  assert.equal(joined(marked), 'kangkong](');
});
