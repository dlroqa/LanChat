'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The search box, and the two places what it finds is shown.
//
// The matching itself is pinned in test/sidebarSections.test.js, where it is a
// pure function over fixtures. What is left is everything that only exists once
// the panel, the pane and the results are mounted together: whether the sidebar
// and the middle panel agree, whether aiming the box at one category quietens
// the others without silencing one that has news, whether a device that is not
// running LanChat stays unopenable — and the one that cannot be reasoned about
// at all, whether a half-written message survives a search.

const SRC = path.join(__dirname, '..', 'src', 'renderer');

test('the results lie over the conversation rather than replacing it', () => {
  // The composer keeps what is being typed in its own state, so a pane that was
  // swapped out for results and back would take a half-written message with it.
  // This is the structural half of that guarantee; the browser check below is
  // the half that actually types something.
  const app = fs.readFileSync(path.join(SRC, 'App.jsx'), 'utf8');
  const wrap = app.slice(app.indexOf('className="chat-wrap"'), app.indexOf('<aside className="side-panel"'));
  const pane = wrap.indexOf('<ChatPane');
  const results = wrap.indexOf('<SearchResults');
  assert.ok(
    pane > -1 && results > pane,
    'SearchResults should be a sibling *after* ChatPane, not instead of it'
  );
  assert.doesNotMatch(
    wrap,
    /\{\s*search\.q[^}]*\?\s*<SearchResults[\s\S]*?:\s*<ChatPane/,
    'the two must never be alternatives to one another'
  );

  const composer = fs.readFileSync(path.join(SRC, 'components', 'Composer.jsx'), 'utf8');
  assert.match(composer, /const \[text, setText\] = useState\(''\)/, 'the draft still lives in the composer');
});

test('mounted in a browser: one box, two views, and nothing lost on the way', async () => {
  const { runSearchHarness } = require('../scripts/search-harness.js');
  const result = await runSearchHarness();
  if (result.skipped) {
    console.log(`# skipped browser checks: ${result.skipped}`);
    return;
  }
  assert.ok(
    result.steps && !result.steps.error,
    `the harness did not finish: ${result.steps && result.steps.error}`
  );

  const s = result.steps;
  const names = (res) => res.groups.flatMap((g) => g.rows.map((r) => r.name));
  const titles = (res) => res.groups.map((g) => g.title);

  // ---- everything under the box ------------------------------------------
  assert.equal(s.placeholderAll, 'Search everything', 'unaimed, the box says so');

  // Tailnet devices are searched now. They were the one list the box could not
  // touch: it filtered the three categories above them and left the machines
  // below untouched, which read as a search that had stopped working halfway.
  assert.deepEqual(titles(s.searchedHermes.results), ['Agents', 'On your tailnet']);
  assert.equal(
    s.searchedHermes.sidebar.tailnet.open,
    true,
    'the category with a match opens in the sidebar too'
  );
  assert.deepEqual(
    s.searchedHermes.sidebar.tailnet.rows,
    ['hermes-box'],
    'and shows what it found, and only that'
  );

  // A hit on something the row never displays explains itself, with the part
  // that matched marked — otherwise it reads as the search having gone wrong.
  const byAddress = s.searchedAddress.results.groups[0].rows[0];
  assert.match(byAddress.why, /^address 100\.64\.0\.5:47100$/);
  assert.deepEqual(byAddress.marked, ['100.64.0.5']);
  const byConnector = s.searchedConnector.results.groups[0].rows[0];
  assert.match(byConnector.why, /^connector claude$/);

  // The two views are one search: what the middle panel lists is what the
  // sidebar opened for.
  assert.deepEqual(names(s.searchedConnector.results), ['Hermes']);
  assert.deepEqual(s.searchedConnector.sidebar.agents.rows, ['Hermes']);

  // ---- aiming it ---------------------------------------------------------
  assert.equal(s.scopedSessions.chip, 'Sessions', 'the chip names the category');
  assert.equal(s.scopedSessions.placeholder, 'Search Sessions', 'and so does the box, in words');
  assert.deepEqual(
    titles(s.scopedSessions.results),
    ['Sessions'],
    'only the category it is aimed at answers'
  );

  const scoped = s.scopedSessions.sidebar;
  assert.equal(scoped.sessions.open, true, 'the scoped category is the one that is open');
  assert.equal(scoped.agents.open, false);
  assert.equal(scoped.tailnet.open, false);
  assert.equal(scoped.agents.quiet, true, 'the ones it is not asking about are said quietly');
  assert.equal(scoped.tailnet.quiet, true);
  // The exception, and the important one: a message arrived for somebody in
  // People while the box was aimed at Sessions. A filter applied to the panel
  // does not get to decide whether you hear about it.
  assert.equal(scoped.people.flashing, true, 'a category with news still flashes while another is scoped');
  assert.equal(scoped.people.quiet, false, 'and is never the dim one');

  // The menu is a picture of the panel: same categories, same order, with
  // "everything" in front of them.
  assert.equal(s.menu.open, true);
  assert.deepEqual(s.menu.options, ['Everything', 'Sessions', 'Agents', 'People', 'On your tailnet']);
  assert.deepEqual(s.menu.selected, ['Sessions'], 'and it says which one is current');
  assert.equal(s.pickedThird.scope, 'people');
  assert.equal(s.pickedThird.placeholder, 'Search People');

  // Escape undoes the search one step at a time — the words first, then what
  // they were aimed at. Clearing both at once would take away a scope somebody
  // set deliberately because they mistyped a name.
  assert.deepEqual(s.escapedOnce, { q: '', scope: 'people', results: false });
  assert.deepEqual(s.escapedTwice, { q: '', scope: 'all' });

  // ---- what it cost the conversation -------------------------------------
  assert.equal(s.searchedHermes.results.paneBelow, true, 'the pane is still mounted under the results');
  assert.deepEqual(s.after, s.before, 'the draft and the scroll position come back untouched');
  assert.equal(s.before.draft, 'half a sentence about', 'and there was really something to lose');
  assert.equal(s.before.scrollTop, 120);

  // ---- opening one -------------------------------------------------------
  assert.equal(s.walked.firstActive, true, 'the first result starts highlighted');
  assert.equal(s.opened.selectedId, 'a2', 'Enter opens the row the keys walked to');
  assert.equal(s.opened.q, '', 'and puts the search away');
  assert.equal(s.opened.results, false);
  assert.equal(s.opened.draft, 'half a sentence about', 'still without costing the draft');

  // A tailnet device is a machine that is not running LanChat: there is no
  // conversation to open, and the row says as much rather than doing nothing
  // when it is clicked.
  assert.equal(s.clickedDevice.wasInert, true);
  assert.equal(s.clickedDevice.now, s.clickedDevice.was, 'clicking a device opened something');

  // ---- the light ---------------------------------------------------------
  // One pass, left to right, behind the rows, and gone. At rest it is off the
  // left edge and invisible, which is also what makes it safe when the global
  // reduced-motion switch stops the animation: nothing to park across the panel.
  const shine = s.searchedHermes.results.shine;
  assert.equal(shine.animation, 'search-shine');
  assert.equal(shine.z, '0', 'the light belongs under the rows, not over them');
  assert.equal(shine.opacity, 0, 'and its resting state is invisible');
  assert.equal(result.reduced.animation, 'none', 'with motion reduced there is no sweep');
  assert.equal(result.reduced.opacity, 0, 'and nothing left sitting on the panel');

  // It travels one way. Each still is further right than the last.
  const xs = result.shine.map((f) => f.band.x);
  for (let i = 1; i < xs.length; i += 1) {
    assert.ok(
      xs[i] > xs[i - 1],
      `the band went backwards between frames ${i - 1} and ${i}: ${xs[i - 1]} → ${xs[i]}`
    );
  }

  // And everything over it can still be read — not only the names, which are
  // --fg and were never in danger. The line under a name is --fg-muted, and it
  // is the dimmest text the light passes under that decides how bright the light
  // may be: at the first grey tried, those subtitles measured 2.7:1.
  //
  // Measured where each half is unambiguous: the band's brightness off a strip
  // of panel with no text in it, the ink off the brightest pixel of the glyphs.
  const lit = result.shine.filter((f) => f.read.length);
  assert.ok(lit.length >= 2, 'no still caught the light under any text; the sweep was never checked');

  const kinds = new Set();
  for (const f of lit) {
    for (const r of f.read) {
      kinds.add(r.kind);
      assert.ok(
        r.contrast >= 4.5,
        `at ${f.frame}ms the light leaves ${r.kind} text at ${r.contrast.toFixed(2)}:1`
      );
    }
  }
  // `date` is named as well as measured. It sits inside .result-name, so if it
  // ever stops being measured as its own box the loop above goes on passing —
  // the name's box is bright and would answer for it. This is the assertion that
  // notices the box has gone.
  assert.ok(
    kinds.has('name') && kinds.has('sub') && kinds.has('date'),
    `only ${[...kinds]} were caught under the light`
  );
});
