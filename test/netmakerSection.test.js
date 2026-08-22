'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The Netmaker settings section, checked for the properties that matter.
//
// These are source assertions rather than a browser mount, on purpose and for a
// narrow reason: what is worth pinning here is not how the panel looks but where
// its writes go. A trust toggle that drifted into the batched save would still
// render correctly, still pass a mount, and would quietly mean a setting
// deciding who can reach this machine sat unsaved in a draft. That is a property
// of the source, so it is asserted against the source — the same way
// sidebarSections.test.js asserts that Sidebar.jsx prints no headings of its own.
//
// This is not a substitute for mounting it; it is the half that a mount is bad at.

const SRC = path.join(__dirname, '..', 'src', 'renderer', 'components');
const section = fs.readFileSync(path.join(SRC, 'NetmakerSection.jsx'), 'utf8');
const settings = fs.readFileSync(path.join(SRC, 'SettingsModal.jsx'), 'utf8');

test('the discovery switch is a preference, saved with the rest', () => {
  // It decides whether we go looking, never who may reach us — the same class as
  // enableTailscale — so it rides the ordinary batched patch.
  assert.match(settings, /enableNetmaker,/, 'it is in the patch save() builds');
  assert.match(settings, /<NetmakerSection[\s\S]{0,120}onToggle=\{setNm\}/, 'and is held as draft state');
});

test('trusting a network is applied at once, never held in a draft', () => {
  // The acceptLan rule: anything deciding who can open a socket to this machine
  // gets its own channel and takes effect on the click.
  assert.match(section, /api\.setNetmakerTrusted\(/, 'it writes on its own channel');
  assert.ok(!/netmakerTrusted/.test(settings), 'and never appears in the batched settings patch');
});

test('a trust switch says what is true now, not what it would do', () => {
  assert.match(section, /Accepting connections that arrive on this network/);
  assert.match(section, /Nobody on this network can open a connection to you/);
});

test('the token field is a password field, and is never rendered back', () => {
  assert.match(section, /type="password"/, 'a token is not typed in the clear');
  assert.match(section, /A token is stored/, 'its presence is reported');
  // The only value bound to an input is the one being typed now. A `value` fed
  // from the stored token would put a secret back on screen.
  assert.ok(!/value=\{[^}]*hasToken/.test(section), 'the stored token is never bound to an input');
  assert.ok(!/server\.token/.test(section), 'and the reply carries no token to bind');
});

test('removing a server asks first, and unticking trust does not', () => {
  // Removing discards a stored token, which cannot be recovered. Unticking only
  // ever tightens — and a confirm on a safe action teaches people to click
  // through confirms.
  const remove = section.slice(section.indexOf('onRemove={'), section.indexOf('onRemove={') + 400);
  assert.match(remove, /window\.confirm\(/, 'a discarded token is worth a question');

  const trust = section.slice(section.indexOf('onTrust={'), section.indexOf('onTrust={') + 300);
  assert.ok(!/confirm\(/.test(trust), 'closing a door needs no permission');
});

test('the peer code says plainly that it is not a password', () => {
  // A long opaque string trains people to treat it as a credential. It is
  // public, and the sentence is cheaper than the support thread.
  assert.match(section, /it is not a password/i);
});

test('each way a server can fail gets its own sentence', () => {
  // "no token", "refused", and "did not answer" need different fixes, so they
  // must not read alike.
  for (const reason of ['no-token', 'unauthorised', 'api-unreachable']) {
    assert.ok(section.includes(`'${reason}'`), `${reason} should be named`);
  }
  // Matched loosely on purpose: which apostrophe the copy uses is a typographic
  // choice the repo makes both ways, and pinning the glyph would fail on a
  // change that meant nothing.
  assert.match(section, /netclient.s configuration is readable only by an administrator/);
  assert.ok(section.includes("'permission'"), 'the root-owned case is named');
});

test('an empty list explains itself rather than showing nothing', () => {
  assert.match(section, /className="empty-hint"/);
  assert.match(section, /No servers added/);
});

test('the section keeps quiet when there is nothing to say', () => {
  // Settings is already a dozen headings of one scroll; somebody with no mesh
  // should meet one switch and one sentence.
  assert.match(section, /const quiet = !enabled && networks\.length === 0/);
  assert.match(section, /\{!quiet && /, 'and everything else is behind that');
});

test('it reuses the panel’s own vocabulary rather than inventing one', () => {
  for (const cls of ['field', 'hint', 'switch', 'toggle', 'btn', 'tag', 'empty-hint']) {
    assert.ok(section.includes(`"${cls}`) || section.includes(`${cls} `), `should use .${cls}`);
  }
  assert.ok(!/style=\{\{\s*(background|border|boxShadow)/.test(section), 'no ad-hoc styling');
});

test('errors are announced, not merely tinted', () => {
  assert.match(section, /role="alert"/, 'a failed write is announced');
  assert.match(section, /role="status"/, 'and a state change is too');
});
