'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Which network a peer arrived over, as the connection panel says it.
//
// The function is read out of the component the way test/sidebarSections.test.js
// reads the pure renderer modules — the panel itself is JSX, but this part is
// arithmetic over the roster and is worth pinning, because it is the one place
// the display of a discovery hint is decided.
const SRC = path.join(__dirname, '..', 'src', 'renderer', 'components', 'ConnectionPanel.jsx');
const source = fs.readFileSync(SRC, 'utf8');
const viaLabel = new Function(
  `${source.slice(source.indexOf('function viaLabel'), source.indexOf('export default'))}
   return viaLabel;`
)();

test('a peer reached over a mesh is labelled with its network', () => {
  assert.equal(viaLabel({ network: 'shared', address: '10.55.0.3:47100' }), 'NM · shared');
});

test('a tailnet peer says so, and a shared one says that too', () => {
  assert.equal(viaLabel({ tailnetName: 'box.tail1234.ts.net' }), 'Tailnet');
  assert.equal(viaLabel({ tailnetName: 'box.other.ts.net', shared: true }), 'Tailnet · shared');
});

test('anything else we have an address for came over the LAN', () => {
  assert.equal(viaLabel({ address: '192.168.1.5:47100' }), 'LAN');
  assert.equal(viaLabel({}), '—', 'and a peer we have never reached says nothing');
});

test('the network wins over the tailnet name', () => {
  // A peer reachable both ways is labelled by the more specific fact rather than
  // by whichever hint happened to be written last.
  assert.equal(viaLabel({ network: 'office', tailnetName: 'x.ts.net', address: 'a:1' }), 'NM · office');
});

test('the label is read from hints only, and claims nothing about identity', () => {
  // `network` and `foreign` are display-only discovery hints, merged underneath
  // the signed identity. They must not appear in anything that decides policy.
  for (const file of ['netScope.js', 'handshake.js', 'pins.js']) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', file), 'utf8');
    assert.ok(!/\bforeign\b/.test(text), `${file} must not consult a display hint`);
  }
});
