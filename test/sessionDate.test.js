'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The day a session was started, shown beside its name in the sidebar.
//
// Sessions are listed by when they were last used and every one of them starts
// life called "New Session", so until somebody renames them the date is the only
// thing on the row that tells two of them apart. That makes it worth pinning:
// the format a reader recognises as a date, and — the part no pure function can
// answer — that it is actually rendered next to the title rather than only being
// computed.

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// The same loader test/dictateCard.test.js uses: the real files, transformed the
// way vite would, so what is asserted is what the app mounts.
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

const { formatShortDate } = load(path.join(SRC, 'lib', 'util.js'));
const Sidebar = load(path.join(SRC, 'components', 'Sidebar.jsx')).default;

test('a timestamp becomes a plain numeric date, and a missing one becomes nothing', () => {
  // Written as the locale writes it — "7/1/2026" here — rather than as a fixed
  // string, because the reader is the one who knows whether the day or the month
  // comes first. Asserted against Intl rather than against "7/1/2026" for the
  // same reason: hard-coding one locale's answer would fail the suite on a
  // machine set to another, which is exactly the case this is written for.
  const at = new Date(2026, 6, 1, 14, 32).getTime();
  const expected = new Date(at).toLocaleDateString([], {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });
  assert.equal(formatShortDate(at), expected);
  assert.match(expected, /\d+\D\d+\D\d+/, 'a numeric date should be three numbers with separators');

  // A session written before the field existed shows nothing at all. The row
  // must not fall back to the epoch or print "Invalid Date" at somebody.
  for (const bad of [undefined, null, 0, '', NaN, 'whenever']) {
    assert.equal(formatShortDate(bad), '', `${String(bad)} should produce no date`);
  }
});

const agents = [{ id: 'a1', kind: 'agent', agentKind: 'acp', name: 'Tessie', online: true }];

function panel(sessions) {
  return renderToStaticMarkup(
    React.createElement(Sidebar, {
      self: { id: 'me', name: 'MacMini', hostname: 'macmini', platform: 'darwin' },
      peers: agents,
      tailnet: [],
      sessions,
      tailnetStatus: { ok: true, reason: null },
      selectedId: sessions[0] ? sessions[0].id : null,
      unread: {},
      summoned: {},
      queued: {},
      authFailures: {},
      showAddresses: false,
      askableAgents: agents,
      sectionOrder: ['sessions', 'agents', 'people', 'tailnet'],
      lockedSections: ['sessions'],
      onSectionPrefs: () => {},
      search: { q: '', scope: 'all' },
      onSearch: () => {},
      onSelect: () => {},
      onOpenProfile: () => {},
      onOpenDev: () => {},
      onOpenSettings: () => {},
      onNewSession: () => {},
      onAddPeer: () => {},
      onRefresh: () => {},
      onNewGroupCall: () => {},
    })
  );
}

test('a session row carries its creation date beside the title it was given', () => {
  const at = new Date(2026, 6, 1, 14, 32).getTime();
  const html = panel([
    { id: 'session:1', title: 'New Session', agentIds: ['a1'], createdAt: at },
    { id: 'session:2', title: 'no date on this one', agentIds: ['a1'] },
  ]);
  const date = formatShortDate(at);

  // Beside the name and after it — the row reads "New Session 7/1/2026", not the
  // other way round, and the date is inside the name line rather than pushed
  // down into the subtitle where the counsel is named.
  assert.match(
    html,
    new RegExp(`name-text">New Session</span><span class="session-date"[^>]*>${date.replace(/\//g, '\\/')}`),
    'the date should follow the title inside the name line'
  );

  // Exactly one date on the panel: the record without the field prints nothing
  // rather than an empty badge that still takes room from the title.
  assert.equal(
    (html.match(/class="session-date"/g) || []).length,
    1,
    'only the dated session should show one'
  );

  // The full moment stays on the tooltip. The row is too narrow for a time, and
  // "which of the four I started this morning" is a real question.
  assert.match(html, /title="Created [^"]+"/, 'the exact moment should be on the title attribute');
});

test('the results panel says the same thing about the same session', () => {
  // The two surfaces that draw a session row. A search for one is most often a
  // search among several still called "New Session", so a result that shows only
  // the title identifies nothing — and a date on one surface but not the other is
  // how somebody comes to believe the search found a different session.
  const SearchResults = load(path.join(SRC, 'components', 'SearchResults.jsx')).default;
  const at = new Date(2026, 6, 1, 14, 32).getTime();
  const sessions = [
    { id: 'session:1', title: 'New Session', agentIds: ['a1'], createdAt: at },
    { id: 'session:2', title: 'New Session', agentIds: ['a1'] },
  ];
  const html = renderToStaticMarkup(
    React.createElement(SearchResults, {
      search: { q: 'session', scope: 'all' },
      sessions,
      peers: agents,
      askableAgents: agents,
      tailnet: [],
      unread: {},
      order: ['sessions', 'agents', 'people', 'tailnet'],
      onSelect: () => {},
      onClose: () => {},
    })
  );

  const date = formatShortDate(at);
  assert.match(
    html,
    new RegExp(`class="session-date"[^>]*>${date.replace(/\//g, '\\/')}`),
    'the result should carry the date'
  );
  assert.equal(
    (html.match(/class="session-date"/g) || []).length,
    1,
    'the undated session should show nothing here either'
  );

  // One class, so one stylesheet rule decides how a date looks. Two surfaces each
  // naming their own would be two dates that drift into looking like two kinds of
  // fact — which is the reason counselCopy exists for the line underneath.
  const sidebar = fs.readFileSync(path.join(SRC, 'components', 'Sidebar.jsx'), 'utf8');
  const results = fs.readFileSync(path.join(SRC, 'components', 'SearchResults.jsx'), 'utf8');
  for (const [name, src] of [
    ['Sidebar', sidebar],
    ['SearchResults', results],
  ]) {
    assert.match(src, /formatShortDate\(/, `${name} should format the date in one place`);
    assert.match(src, /className="session-date"/, `${name} should draw it with the shared class`);
  }
});
