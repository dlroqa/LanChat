'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The scanner that makes links in a message clickable. It runs in the renderer
// (ESM for the browser), so the `export` keywords come off — same as the other
// renderer helpers pinned here.
const { linkify, safeHref, firstLink, hasLink, isImageUrl } = new Function(
  `${fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'linkify.js'), 'utf8').replace(/^export\s+/gm, '')}
   return { linkify, safeHref, firstLink, hasLink, isImageUrl };`
)();

const joined = (runs) => runs.map((r) => r.text).join('');
const links = (text) => linkify(text).filter((r) => r.type === 'link');

test('the link in a real message is found whole, and the text around it is kept', () => {
  const url =
    'https://techcrunch.com/2026/07/13/lapd-lets-contract-with-surveillance-giant-flock-expire-citing-serious-concerns-over-civil-liberties-and-privacy/';
  const text = `Sure, anak—here's the Flock Safety camera article Auntie used:\n\n${url}`;
  const runs = linkify(text);

  assert.equal(runs.length, 2);
  assert.equal(runs[0].type, 'text');
  assert.deepEqual({ type: runs[1].type, text: runs[1].text, href: runs[1].href }, { type: 'link', text: url, href: url });
  // Nothing may be dropped: what is rendered is exactly what was said.
  assert.equal(joined(runs), text);
});

test('the punctuation that ends a sentence is not part of the link', () => {
  for (const [text, expected] of [
    ['see https://example.com/a. thanks', 'https://example.com/a'],
    ['is it https://example.com/a?', 'https://example.com/a'],
    ['read https://example.com/a, then https://example.com/b!', 'https://example.com/a'],
    ['"https://example.com/a"', 'https://example.com/a'],
    ['(https://example.com/a)', 'https://example.com/a'],
  ]) {
    assert.equal(links(text)[0].href, expected, text);
    assert.equal(joined(linkify(text)), text, `${text} lost characters`);
  }
});

test('brackets that belong to the link are kept', () => {
  const url = 'https://en.wikipedia.org/wiki/Flock_(company)';
  assert.equal(links(`look at ${url} ok`)[0].href, url);
  // Wrapped in a sentence's own parens, only the outer one goes.
  assert.equal(links(`look at (${url})`)[0].href, url);
});

test('a bare www. address is a link, and gets https', () => {
  const runs = links('try www.example.com/x for size');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].text, 'www.example.com/x', 'the message still reads as it was typed');
  assert.equal(runs[0].href, 'https://www.example.com/x');
});

test('only http and https are ever linked', () => {
  for (const text of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'mailto:someone@example.com',
    'ftp://example.com/x',
    'lanchat://peer/1',
  ]) {
    assert.deepEqual(links(text), [], text);
    assert.equal(hasLink(text), false, text);
  }
  // And the href builder refuses them even if handed one directly.
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('file:///etc/passwd'), null);
  assert.equal(safeHref('data:text/html,x'), null);
  assert.equal(safeHref(''), null);
  assert.equal(safeHref(null), null);
});

test('a scheme buried in text is not turned into a link of its own kind', () => {
  // The one shape that could smuggle something past a naive scan: a web link
  // whose *path* mentions another scheme. The href stays http(s).
  const runs = links('https://example.com/?next=javascript:alert(1)');
  assert.equal(runs.length, 1);
  assert.ok(runs[0].href.startsWith('https://example.com/'), runs[0].href);
});

test('text with no link is one plain run', () => {
  const text = 'meeting at 3.5 hours, room 10.2, ratio 1:1';
  assert.deepEqual(linkify(text), [{ type: 'text', text }]);
  assert.equal(hasLink(text), false);
  assert.equal(firstLink(text), null);
});

test('several links are all found, and the first is the one a preview follows', () => {
  const text = 'a https://one.example/x b https://two.example/y c';
  const found = links(text);
  assert.deepEqual(
    found.map((r) => r.href),
    ['https://one.example/x', 'https://two.example/y']
  );
  assert.equal(firstLink(text), 'https://one.example/x');
  assert.equal(joined(linkify(text)), text);
});

test('the displayed text is what was typed, even when the href has to be encoded', () => {
  const runs = links('https://example.com/päth ok');
  assert.equal(runs[0].text, 'https://example.com/päth');
  assert.equal(runs[0].href, 'https://example.com/p%C3%A4th');
});

test('empty and missing text are handled without a link', () => {
  assert.deepEqual(linkify(''), []);
  assert.deepEqual(linkify(undefined), []);
  assert.deepEqual(linkify(null), []);
});

// ---- markdown links ----
//
// The one piece of markup worth reading, and the reason this section exists: an
// agent's answer arrives full of `[label](target)`, and until it was scanned for
// it rendered as a label in brackets beside a URL, with nothing clickable in
// sight. What is pinned below is that reading it changed nothing about what the
// message *is* — the runs still add up to the input exactly, because the search
// numbering in findInThread.js counts offsets into that same string.

const PNG = '/home/agent/share/recent_worldwide_earthquakes_graph.png';
const MEDIA = [{ name: 'graph.png', path: PNG, size: 40, mime: 'image/png' }];
const types = (runs) => runs.map((r) => r.type);

test('a markdown link shows its label and opens its target', () => {
  const text = 'see [the write-up](https://example.com/a) for more';
  const runs = linkify(text);

  assert.deepEqual(types(runs), ['text', 'syntax', 'link', 'syntax', 'text']);
  assert.equal(runs[2].text, 'the write-up', 'the label is what is read');
  assert.equal(runs[2].href, 'https://example.com/a', 'the target is what is opened');
  assert.equal(joined(runs), text, 'and nothing was dropped to do it');
});

test('the URL inside a markdown link is part of it, not a second link beside it', () => {
  const runs = linkify('[the write-up](https://example.com/a)');
  assert.equal(links('[the write-up](https://example.com/a)').length, 1);
  assert.equal(joined(runs), '[the write-up](https://example.com/a)');
});

test('a markdown target that is not a web link and names no file stays as text', () => {
  const refused = ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', `sandbox:${PNG}`];
  for (const target of refused) {
    const text = `[click me](${target})`;
    const runs = linkify(text);
    assert.deepEqual(types(runs), ['text'], target);
    assert.equal(joined(runs), text, target);
  }
});

test('a markdown target naming a picture on the message becomes something openable', () => {
  const text = `[Download the full-size PNG graph](sandbox:${PNG})`;
  const runs = linkify(text, MEDIA);

  assert.deepEqual(types(runs), ['syntax', 'file', 'syntax']);
  assert.equal(runs[1].text, 'Download the full-size PNG graph');
  assert.equal(runs[1].path, PNG, 'the path comes off the message, never out of the text');
  assert.equal(joined(runs), text);
});

test('the same picture named as a file URL, escapes and all', () => {
  const media = [{ path: '/home/agent/my graph.png' }];
  const runs = linkify('[see](file:///home/agent/my%20graph.png)', media);
  assert.equal(runs.find((r) => r.type === 'file').path, '/home/agent/my graph.png');
});

test('a path the message did not name is not a path', () => {
  // The whole security property in one assertion: a target only becomes
  // something openable by matching what main already checked and attached. A
  // message with no list, or a different one, can name nothing at all.
  const text = `[open me](sandbox:${PNG})`;
  assert.deepEqual(types(linkify(text)), ['text'], 'no media on the message');
  assert.deepEqual(types(linkify(text, [])), ['text'], 'an empty list');
  assert.deepEqual(types(linkify(text, [{ path: '/home/agent/other.png' }])), ['text'], 'a different file');
});

test('brackets in ordinary prose are still ordinary prose', () => {
  for (const text of [
    'I read [1] and then (2) after that',
    'the array is a[i] (see above)',
    'nothing here](either)',
    '[a link with\na newline in it](https://example.com/a)',
  ]) {
    assert.equal(joined(linkify(text)), text, text);
    assert.equal(
      linkify(text).some((r) => r.type === 'syntax'),
      false,
      text
    );
  }
});

test('a message that is markdown throughout still adds up to itself', () => {
  const text =
    `Here is the picture:\n\nMEDIA:${PNG}\n\n` +
    `[Download the full-size PNG graph](sandbox:${PNG}) or read ` +
    `[the notes](https://example.com/n) — see also https://example.com/plain.`;
  const runs = linkify(text, MEDIA);

  assert.equal(joined(runs), text, 'the invariant findInThread.js is built on');
  assert.equal(runs.filter((r) => r.type === 'file').length, 1);
  assert.equal(runs.filter((r) => r.type === 'link').length, 2);
});

// ---- links that are pictures ----

test('a link is a picture when its path says so, and not because of a query string', () => {
  for (const url of [
    'https://example.com/a.png',
    'https://example.com/deep/path/photo.JPEG',
    'https://example.com/a.gif?v=2',
    'https://example.com/a.webp#frag',
  ]) {
    assert.equal(isImageUrl(url), true, url);
  }
  for (const url of [
    'https://example.com/a.html',
    'https://example.com/gallery',
    'https://example.com/?image=a.png',
    'https://example.com/a.png.html',
    'not a url at all',
  ]) {
    assert.equal(isImageUrl(url), false, url);
  }
});
