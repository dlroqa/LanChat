'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { load, mount, find, findAll } = require('../scripts/lib/reactDrive.js');

// The shelf, mounted for real.
//
// What is worth asserting about it is not that it draws — it is that it stays
// out of the way. A card is the least urgent thing that happens in this window,
// and every property below is one of the ways an interface can fail to be
// ignorable: counting, badging, shouting, or saying something in colour that it
// does not also say in words.

const IdeaShelf = load(path.join(__dirname, '..', 'src', 'renderer', 'components', 'IdeaShelf.jsx')).default;

const card = (over = {}) => ({
  id: 'c1',
  level: 'shelf',
  category: 'Missing prerequisite',
  label: 'Missing prerequisite — Mac',
  claim: 'Nothing acquires the coordinator lock before the port is shared.',
  evidence: ['m1', 'm2'],
  observerIds: ['agent:mac'],
  planVersion: 1,
  createdAt: Date.now(),
  ...over,
});

test('an empty shelf draws nothing at all', () => {
  // Not an empty container, not a zero — nothing. A session with no ideas in it
  // should look exactly like a session that has never had one.
  const view = mount(IdeaShelf, { cards: [] });
  // Strict: `undefined == null` is true, and a vacuous pass here would hide the
  // component rendering an empty container instead of nothing.
  assert.strictEqual(view.tree, null);
});

test('every card says what kind of thing it is, in words', () => {
  // The rule that makes the tint safe: colour is a second signal and never the
  // only one, so somebody who cannot see it loses nothing.
  const view = mount(IdeaShelf, { cards: [card(), card({ id: 'c2', category: 'Possible risk' })] });
  const words = findAll(view.tree, (n) => n.props && n.props.className === 'idea-card-what').map(
    (n) => n.props.children
  );
  assert.deepEqual(words, ['Missing prerequisite', 'Possible risk']);
});

test('a card carries its whole meaning for somebody hearing it', () => {
  const view = mount(IdeaShelf, { cards: [card()] });
  const button = find(view.tree, (n) => n.props && String(n.props.className || '').includes('idea-card'));
  // Category, who noticed it, how old it is, and what it actually says — a
  // screen reader user should not have to open a card to learn whether it is
  // worth opening.
  assert.match(button.props['aria-label'], /Missing prerequisite — Mac/);
  assert.match(button.props['aria-label'], /just now/);
  assert.match(button.props['aria-label'], /coordinator lock/);
  assert.equal(button.props['aria-expanded'], false);
});

test('the row announces itself as a group with a count', () => {
  const view = mount(IdeaShelf, { cards: [card(), card({ id: 'c2' })] });
  const row = find(view.tree, (n) => n.props && n.props.role === 'group');
  assert.equal(row.props['aria-label'], '2 ideas from the observers');
  // Singular reads properly too — "1 ideas" is the sort of thing that makes an
  // interface feel unfinished.
  const oneView = mount(IdeaShelf, { cards: [card()] });
  assert.equal(
    find(oneView.tree, (n) => n.props && n.props.role === 'group').props['aria-label'],
    '1 idea from the observers'
  );
});

test('nothing on the shelf is a badge, a count or an unread mark', () => {
  // The failure this whole surface is arranged to avoid. If a number ever
  // appears here, an idea has started demanding to be read.
  const view = mount(IdeaShelf, { cards: [card(), card({ id: 'c2' }), card({ id: 'c3' })] });
  const classes = findAll(view.tree, (n) => n.props && n.props.className)
    .map((n) => String(n.props.className))
    .join(' ');
  for (const forbidden of ['badge', 'unread', 'count', 'pulse', 'dot']) {
    assert.equal(classes.includes(forbidden), false, `the shelf must not use a ${forbidden}`);
  }
});

test('a card is closed until it is opened', () => {
  // No popover on arrival: a card that opened itself would be a notification.
  const view = mount(IdeaShelf, { cards: [card()] });
  assert.equal(
    find(view.tree, (n) => n.props && n.props.role === 'dialog'),
    null
  );
});

test('the two things a card can be are offered by name', async () => {
  const view = mount(IdeaShelf, { cards: [card()] });
  const button = find(view.tree, (n) => n.props && String(n.props.className || '').includes('idea-card'));
  button.props.onClick();
  await view.settle();
  const pop = find(view.tree, (n) => n.props && n.props.role === 'dialog');
  assert.ok(pop, 'clicking a card opens it');
  const acts = findAll(view.tree, (n) => n.props && String(n.props.className || '').includes('idea-act')).map(
    (n) => JSON.stringify(n.props.children)
  );
  assert.equal(acts.length, 2, 'exactly two: ask about it, or dismiss it');
  assert.match(acts.join(' '), /Ask about it/);
  assert.match(acts.join(' '), /Dismiss/);
  view.unmount();
});

test('dismissing a card hands back the card that was dismissed', async () => {
  const dismissed = [];
  const view = mount(IdeaShelf, { cards: [card()], onDismiss: (c) => dismissed.push(c.id) });
  const button = find(view.tree, (n) => n.props && String(n.props.className || '').includes('idea-card'));
  button.props.onClick();
  await view.settle();
  const quiet = find(view.tree, (n) => n.props && String(n.props.className || '').includes('idea-act quiet'));
  quiet.props.onClick();
  await view.settle();
  assert.deepEqual(dismissed, ['c1']);
  view.unmount();
});
