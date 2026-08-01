'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The four categories in the left panel.
//
// Each of them hides a whole list behind one heading, so the arithmetic that
// decides what a heading says — and the normalising that decides a heading
// exists at all — is the difference between a list being put away and a list
// being lost. Both run in the renderer (ESM for the browser), so the `export`
// keywords come off the same way test/findInThread.test.js loads the scanner.
const SRC = path.join(__dirname, '..', 'src', 'renderer');
const {
  SECTIONS,
  SECTION_IDS,
  SCOPE_ALL,
  sectionTitle,
  normalizeOrder,
  moveSection,
  sectionForThread,
  sectionSignal,
  searchPlaceholder,
  scopeOptions,
  searchFields,
  matchIn,
  searchSection,
} = new Function(
  `${fs.readFileSync(path.join(SRC, 'lib', 'sidebarSections.js'), 'utf8').replace(/^export\s+/gm, '')}
   return { SECTIONS, SECTION_IDS, SCOPE_ALL, sectionTitle, normalizeOrder, moveSection, sectionForThread,
            sectionSignal, searchPlaceholder, scopeOptions, searchFields, matchIn, searchSection };`
)();

// The one the renderer passes in. Kept as a stub rather than loaded from
// util.js: what is being pinned here is that the label is searched at all, not
// how a platform is spelled.
const label = (p) => ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' })[p] || '';

const DEFAULT_ORDER = ['sessions', 'agents', 'people', 'tailnet'];

test('the categories are the four the panel draws, in the order it defaults to', () => {
  assert.deepEqual(SECTION_IDS, DEFAULT_ORDER);
  assert.equal(sectionTitle('tailnet'), 'On your tailnet');
  assert.equal(sectionTitle('nonsense'), '');

  // The default written into config.js has to be one this module accepts, or a
  // fresh install would be silently re-ordered on its first render.
  const config = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'config.js'), 'utf8');
  const saved = config.match(/sidebarOrder:\s*(\[[^\]]*\])/);
  assert.ok(saved, 'config.js should still ship a default sidebarOrder');
  const parsed = JSON.parse(saved[1].replace(/'/g, '"'));
  assert.deepEqual(
    normalizeOrder(parsed),
    parsed,
    'the shipped default should survive normalising unchanged'
  );

  // And the renderer must be allowed to save both of them back.
  const ipc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc.js'), 'utf8');
  const settable = ipc.slice(
    ipc.indexOf('const SETTABLE_KEYS'),
    ipc.indexOf(']', ipc.indexOf('const SETTABLE_KEYS'))
  );
  for (const key of ['sidebarOrder', 'sidebarLocked']) {
    assert.match(settable, new RegExp(`'${key}'`), `${key} should be settable from the renderer`);
  }
});

test('a saved order can never lose, repeat or invent a category', () => {
  assert.deepEqual(normalizeOrder(['people', 'sessions', 'agents', 'tailnet']), [
    'people',
    'sessions',
    'agents',
    'tailnet',
  ]);

  // A category missing from the file still appears, at the end — the case that
  // matters, because it is what a config written by an older build looks like
  // once a fifth category exists. Losing it would hide a whole list with no way
  // to ask for it back.
  assert.deepEqual(normalizeOrder(['people']), ['people', 'sessions', 'agents', 'tailnet']);

  // Anything else is thrown away rather than rendered.
  assert.deepEqual(normalizeOrder(['people', 'people', 'ghosts', 'tailnet']), [
    'people',
    'tailnet',
    'sessions',
    'agents',
  ]);

  for (const junk of [null, undefined, 'people', 42, {}, [], [null, 7]]) {
    assert.deepEqual(
      normalizeOrder(junk),
      DEFAULT_ORDER,
      `${JSON.stringify(junk)} should fall back to all four`
    );
  }
});

test('moving a category puts it exactly where it was dropped', () => {
  assert.deepEqual(moveSection(DEFAULT_ORDER, 'tailnet', 0), ['tailnet', 'sessions', 'agents', 'people']);
  assert.deepEqual(moveSection(DEFAULT_ORDER, 'sessions', 3), ['agents', 'people', 'tailnet', 'sessions']);

  // One place up, one place down: the arrow keys on the grip, which are the
  // keyboard's version of the drag and have to agree with it.
  const down = moveSection(DEFAULT_ORDER, 'sessions', DEFAULT_ORDER.indexOf('sessions') + 1);
  assert.deepEqual(down, ['agents', 'sessions', 'people', 'tailnet']);
  assert.deepEqual(moveSection(down, 'sessions', down.indexOf('sessions') - 1), DEFAULT_ORDER);

  // Off either end, or onto itself: the order comes back whole rather than
  // rearranged or short.
  assert.deepEqual(moveSection(DEFAULT_ORDER, 'sessions', -5), DEFAULT_ORDER);
  assert.deepEqual(moveSection(DEFAULT_ORDER, 'tailnet', 99), DEFAULT_ORDER);
  assert.deepEqual(moveSection(DEFAULT_ORDER, 'agents', 1), DEFAULT_ORDER);
  assert.deepEqual(moveSection(DEFAULT_ORDER, 'nobody', 0), DEFAULT_ORDER);
  assert.deepEqual(moveSection(['people'], 'people', 0), ['people', 'sessions', 'agents', 'tailnet']);
});

test('the category holding the open conversation is the one that stays open', () => {
  const sessions = [{ id: 's1', title: 'why the turn moved' }];
  const peers = [
    { id: 'a1', kind: 'agent', name: 'Tessie' },
    { id: 'p1', name: 'Elijah' },
  ];

  assert.equal(sectionForThread('s1', { sessions, peers }), 'sessions');
  assert.equal(sectionForThread('a1', { sessions, peers }), 'agents');
  assert.equal(sectionForThread('p1', { sessions, peers }), 'people');
  assert.equal(sectionForThread('gone', { sessions, peers }), null);
  assert.equal(sectionForThread(null, { sessions, peers }), null);
  assert.equal(sectionForThread('s1'), null, 'with nothing to look in, nothing is claimed');
});

test('a shut heading counts what is behind it, and says when there is nothing to count', () => {
  const people = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];

  assert.deepEqual(sectionSignal(people, { p1: 2, p3: 1 }, {}), { count: 3, alert: true });
  assert.deepEqual(sectionSignal(people, {}, {}), { count: 0, alert: false });

  // A summoned agent writes no message, so it raises no count — and it is
  // exactly the case a shut category would otherwise say nothing about.
  assert.deepEqual(sectionSignal([{ id: 'a1' }], {}, { a1: true }), { count: 0, alert: true });

  // Unread belonging to someone in another category is not this one's business.
  assert.deepEqual(sectionSignal(people, { a1: 9 }, { a1: true }), { count: 0, alert: false });

  // Messages of yours waiting to go out are not something arriving for you.
  assert.deepEqual(sectionSignal(people, { p1: 0 }, {}), { count: 0, alert: false });

  assert.deepEqual(sectionSignal(undefined, undefined, undefined), { count: 0, alert: false });
});

test('the box says which category it is pointed at', () => {
  // The four strings the search box can offer, and the one it starts on.
  assert.equal(searchPlaceholder(SCOPE_ALL), 'Search everything');
  assert.equal(searchPlaceholder(undefined), 'Search everything');
  assert.equal(searchPlaceholder('sessions'), 'Search Sessions');
  assert.equal(searchPlaceholder('agents'), 'Search Agents');
  assert.equal(searchPlaceholder('people'), 'Search People');
  assert.equal(searchPlaceholder('tailnet'), 'Search On your tailnet');

  // The menu is a picture of the panel: same categories, same order, with
  // "everything" in front. A menu that listed them in the source order would
  // disagree with the column beside it the moment anything was dragged.
  assert.deepEqual(
    scopeOptions(['people', 'tailnet', 'sessions', 'agents']).map((o) => o.id),
    ['all', 'people', 'tailnet', 'sessions', 'agents']
  );
  assert.equal(scopeOptions([])[0].title, 'Everything');
  assert.equal(scopeOptions(['nonsense']).length, 5, 'a junk order still offers all four');
  assert.ok(!SECTION_IDS.includes(SCOPE_ALL), 'the "everything" id must not collide with a category');
});

test('a row is searched by everything it is, and says which part matched', () => {
  const elijah = {
    id: 'p1',
    name: 'Elijah',
    hostname: 'elijah-pc',
    platform: 'win32',
    address: '100.64.0.5:47100',
  };
  const tessie = {
    id: 'a1',
    name: 'Tessie',
    hostname: 'server',
    platform: 'linux',
    kind: 'agent',
    agentKind: 'acp',
  };
  const device = { ip: '100.64.0.9', hostname: 'hermes', os: 'linux' };
  const session = { id: 's1', title: 'why the turn moved' };

  // The name first, and case makes no difference either way round.
  assert.deepEqual(matchIn('people', elijah, 'eli', label), { field: 'name', text: 'Elijah' });
  assert.deepEqual(matchIn('people', elijah, 'ELIJAH', label), { field: 'name', text: 'Elijah' });

  // Then the things the row may not be showing. Each is reported by name, which
  // is what stops a hit on an address from looking like a bug.
  assert.deepEqual(matchIn('people', elijah, '-pc', label), { field: 'hostname', text: 'elijah-pc' });
  assert.deepEqual(matchIn('people', elijah, 'windows', label), { field: 'platform', text: 'Windows' });
  assert.deepEqual(matchIn('people', elijah, '100.64', label), {
    field: 'address',
    text: '100.64.0.5:47100',
  });
  assert.deepEqual(matchIn('agents', tessie, 'acp', label), { field: 'connector', text: 'acp' });

  // A tailnet device is only ever called by its hostname, so that is its name.
  assert.deepEqual(matchIn('tailnet', device, 'herm', label), { field: 'name', text: 'hermes' });
  assert.deepEqual(matchIn('tailnet', device, 'linux', label), { field: 'platform', text: 'Linux' });
  assert.deepEqual(matchIn('tailnet', device, '100.64.0.9', label), { field: 'address', text: '100.64.0.9' });

  // A session has a title and nothing else — and the title is its name.
  assert.deepEqual(matchIn('sessions', session, 'turn', label), {
    field: 'name',
    text: 'why the turn moved',
  });

  // Earlier fields win, so "server" on an agent whose hostname is server is
  // reported as the hostname rather than as something further down the list.
  assert.deepEqual(matchIn('agents', tessie, 'server', label), { field: 'hostname', text: 'server' });

  // And nothing matches nothing.
  assert.equal(matchIn('people', elijah, 'zzz', label), null);
  assert.equal(matchIn('people', elijah, '   ', label), null);
  assert.equal(matchIn('people', null, 'eli', label), null);
  assert.equal(matchIn('nonsense', elijah, 'eli', label), null);
  assert.deepEqual(searchFields('nonsense', elijah, label), []);

  // A field the row does not have is skipped rather than matching the empty
  // string — otherwise every search would hit every row with a missing field.
  assert.equal(matchIn('people', { id: 'x', name: 'Ana' }, '', label), null);
  assert.deepEqual(matchIn('people', { id: 'x', name: 'Ana' }, 'a', label), { field: 'name', text: 'Ana' });
});

test('a category answers a search with only the rows that matched', () => {
  const people = [
    { id: 'p1', name: 'Elijah', hostname: 'elijah-pc', platform: 'win32' },
    { id: 'p2', name: 'Server', hostname: 'server', platform: 'linux' },
    { id: 'p3', name: 'Ana', hostname: 'ana-air', platform: 'darwin' },
  ];

  const hits = searchSection('people', people, 'lin', label);
  assert.deepEqual(
    hits.map((h) => [h.item.name, h.field]),
    [['Server', 'platform']]
  );

  // An empty box is not a search: everything comes back, and comes back
  // unmatched, so nothing claims to have been found.
  const all = searchSection('people', people, '  ', label);
  assert.equal(all.length, 3);
  assert.deepEqual(
    all.map((h) => h.field),
    [null, null, null]
  );

  assert.deepEqual(searchSection('people', people, 'zzz', label), []);
  assert.deepEqual(searchSection('people', undefined, 'a', label), []);
  assert.deepEqual(searchSection('people', undefined, '', label), []);
});

test('the panel renders the categories from the saved order and nothing else', () => {
  const sidebar = fs.readFileSync(path.join(SRC, 'components', 'Sidebar.jsx'), 'utf8');

  // One loop over the order, rather than four hand-written headings — which is
  // what makes the order a setting rather than a fact about the source file.
  assert.match(sidebar, /order\.map\(\(id\) => \(\s*<SidebarSection/);
  assert.doesNotMatch(sidebar, /section-label/, 'the hand-written headings should be gone');

  // "On your tailnet" used to be printed by two independent blocks, both of
  // which could be true at once, and was.
  assert.equal(
    (sidebar.match(/On your tailnet/g) || []).length,
    0,
    'titles now come from sidebarSections.js'
  );
  assert.equal((SECTIONS.filter((s) => s.title === 'On your tailnet') || []).length, 1);

  // The heading's count comes from the unfiltered lists: a search that matched
  // nobody must not take the flashing off a category with an unread message in
  // it, because the search is about what is on screen and the flash is about
  // what has arrived.
  assert.match(sidebar, /sectionSignal\(sessions, unread, summoned\)/);
  assert.match(sidebar, /sectionSignal\(allAgents, unread, summoned\)/);
  assert.match(sidebar, /sectionSignal\(allPeople, unread, summoned\)/);
});
