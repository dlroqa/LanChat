'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { normalizeWebUrl } = require('../src/main/webLinks.js');
const {
  createLinkPreview,
  guardedLookup,
  isPrivateAddress,
  hostLooksInternal,
  parseMetadata,
  decodeEntities,
} = require('../src/main/linkPreview.js');

// A preview is the one thing in LanChat that reaches past the user's own network,
// and the link it follows was typed by somebody else. So these cover the guards
// as closely as the parsing: what may be fetched, what may not, and what a peer
// cannot make this machine do.

// A real 1x1 PNG, so the thumbnail path is exercised end to end.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

function serve(handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        hits,
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      })
    );
  });
}

function page({ title = 'Real title', extra = '', body = '' } = {}) {
  return `<!doctype html><html><head><title>${title}</title>${extra}</head><body>${body}</body></html>`;
}

// ------------------------------------------------------------------- url guards

test('only http and https count as web links', () => {
  assert.equal(normalizeWebUrl('https://example.com/a?b=c#d'), 'https://example.com/a?b=c#d');
  assert.equal(normalizeWebUrl('  http://example.com  '), 'http://example.com/');
  for (const bad of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>x</script>',
    'mailto:a@b.c',
    'ftp://example.com',
    'not a url',
    '',
    null,
    undefined,
  ]) {
    assert.equal(normalizeWebUrl(bad), null, String(bad));
  }
});

test('a peer cannot point a preview at anything on our own network', () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.5',
    '192.168.1.1',
    '172.16.0.1',
    '172.31.255.255',
    '169.254.1.1',
    '100.101.102.103', // Tailscale's CGNAT range
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fd7a:115c:a1e0::1', // Tailscale IPv6
    'fe80::1',
    '::ffff:192.168.0.1',
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} must be treated as local`);
  }
  for (const ip of ['1.1.1.1', '93.184.216.34', '172.32.0.1', '100.63.255.255', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} is a public address`);
  }
});

test('names that can only mean "this network" are refused without a lookup', () => {
  for (const host of ['localhost', 'nas.local', 'printer.lan', 'wiki.internal', 'router', 'foo.home.arpa', '']) {
    assert.equal(hostLooksInternal(host), true, host);
  }
  for (const host of ['example.com', 'techcrunch.com', 'sub.example.co.uk']) {
    assert.equal(hostLooksInternal(host), false, host);
  }
});

test('a name that resolves onto this machine is refused where the socket resolves it', async () => {
  // The guard the socket itself uses, so a name that only *looks* public cannot
  // answer with a private address between the check and the connection.
  await assert.rejects(
    () => new Promise((resolve, reject) => guardedLookup('localhost', {}, (err) => (err ? reject(err) : resolve()))),
    /private address/
  );
});

// --------------------------------------------------------------------- parsing

test('open graph tags win, and are read as text rather than markup', () => {
  const meta = parseMetadata(
    page({
      title: 'Fallback title',
      extra: `
        <meta property="og:title" content="LAPD lets Flock contract expire &amp; cites privacy" />
        <meta property="og:description" content='Serious concerns over civil liberties.' />
        <meta property="og:site_name" content="TechCrunch" />
        <meta property="og:image" content="/wp-content/hero.jpg" />
        <meta name="description" content="ignored, og wins" />`,
      body: '<h1>not the title</h1>',
    }),
    'https://techcrunch.com/2026/07/13/story/'
  );
  assert.deepEqual(meta, {
    title: 'LAPD lets Flock contract expire & cites privacy',
    description: 'Serious concerns over civil liberties.',
    siteName: 'TechCrunch',
    imageUrl: 'https://techcrunch.com/wp-content/hero.jpg',
  });
});

test('a plain page still previews: title, meta description, host as the site', () => {
  const meta = parseMetadata(
    page({ title: '  Some\n  page  ', extra: '<meta name="description" content="What it is about.">' }),
    'https://www.example.com/x'
  );
  assert.deepEqual(meta, {
    title: 'Some page',
    description: 'What it is about.',
    siteName: 'example.com',
    imageUrl: null,
  });
});

test('an image that is not a web link is dropped, not resolved', () => {
  const meta = parseMetadata(
    page({ extra: '<meta property="og:image" content="javascript:alert(1)">' }),
    'https://e.com/'
  );
  assert.equal(meta.imageUrl, null);
});

test('over-long metadata is cut down before it reaches a bubble', () => {
  const meta = parseMetadata(
    page({
      extra: `<meta property="og:title" content="${'t'.repeat(400)}"><meta property="og:description" content="${'d'.repeat(600)}">`,
    }),
    'https://e.com/'
  );
  assert.equal(meta.title.length, 200);
  assert.equal(meta.description.length, 300);
  assert.ok(meta.title.endsWith('…'));
});

test('only the head is parsed, so body content cannot pose as the page', () => {
  const html = `<html><head><title>Head title</title></head><body>
    <meta property="og:title" content="Injected by the body">
    <title>Also the body</title></body></html>`;
  assert.equal(parseMetadata(html, 'https://e.com/').title, 'Head title');
});

test('entities are decoded, including numeric ones', () => {
  assert.equal(
    decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#8212; &#x27;f&#x27;'),
    'a & b <c> "d" \'e\' — \'f\''
  );
});

// ------------------------------------------------------------------- fetching

test('a page is fetched once and turned into a card, picture included', async () => {
  const site = await serve((req, res) => {
    if (req.url === '/hero.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length });
      return res.end(PNG);
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      page({
        extra: `<meta property="og:title" content="A story"><meta property="og:description" content="About something."><meta property="og:site_name" content="Example"><meta property="og:image" content="/hero.png">`,
      })
    );
  });
  try {
    // allowPrivate is the test's own escape hatch: without it the loopback server
    // this suite runs is exactly what the guard exists to refuse.
    const previews = createLinkPreview({ allowPrivate: true });
    const first = await previews.get(`${site.origin}/story`);
    assert.equal(first.ok, true, first.reason);
    assert.equal(first.title, 'A story');
    assert.equal(first.description, 'About something.');
    assert.equal(first.siteName, 'Example');
    // The thumbnail arrives as a data URL: the window never fetches it itself.
    assert.ok(first.image.startsWith('data:image/'), first.image);

    const again = await previews.get(`${site.origin}/story`);
    assert.deepEqual(again, first);
    assert.deepEqual(site.hits, ['/story', '/hero.png'], 'a cached preview must not refetch');
  } finally {
    await site.close();
  }
});

test('two bubbles asking at once share one fetch', async () => {
  const site = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page({ title: 'Shared' }));
  });
  try {
    const previews = createLinkPreview({ allowPrivate: true });
    const [a, b] = await Promise.all([previews.get(`${site.origin}/x`), previews.get(`${site.origin}/x`)]);
    assert.equal(a.title, 'Shared');
    assert.deepEqual(a, b);
    assert.equal(site.hits.length, 1);
  } finally {
    await site.close();
  }
});

test('nothing leaves this machine for a link that points back at it', async () => {
  const site = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page({ title: 'Should never be read' }));
  });
  try {
    const previews = createLinkPreview(); // the real guard
    for (const url of [`${site.origin}/admin`, `http://localhost:${new URL(site.origin).port}/admin`]) {
      const res = await previews.get(url);
      assert.equal(res.ok, false, url);
      assert.match(res.reason, /local|private/);
    }
    assert.deepEqual(site.hits, [], 'the request must not be made at all');
  } finally {
    await site.close();
  }
});

test('a redirect is re-checked, and one that leaves the web is refused', async () => {
  const site = await serve((req, res) => {
    if (req.url === '/go') {
      res.writeHead(302, { location: '/there' });
      return res.end();
    }
    if (req.url === '/off') {
      res.writeHead(302, { location: 'file:///etc/passwd' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page({ extra: '<meta property="og:title" content="Arrived">' }));
  });
  try {
    const previews = createLinkPreview({ allowPrivate: true });
    const followed = await previews.get(`${site.origin}/go`);
    assert.equal(followed.title, 'Arrived');
    assert.deepEqual(site.hits, ['/go', '/there']);

    const refused = await previews.get(`${site.origin}/off`);
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /off the web/);
  } finally {
    await site.close();
  }
});

test('a file that is not a web page is never parsed', async () => {
  const site = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"title":"not a page"}');
  });
  try {
    const previews = createLinkPreview({ allowPrivate: true });
    const res = await previews.get(`${site.origin}/data.json`);
    assert.equal(res.ok, false);
    assert.match(res.reason, /not a web page/);
  } finally {
    await site.close();
  }
});

test('a page with nothing to show does not produce an empty card', async () => {
  const site = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head></head><body>hello</body></html>');
  });
  try {
    const previews = createLinkPreview({ allowPrivate: true });
    const res = await previews.get(`${site.origin}/bare`);
    assert.equal(res.ok, false);
    assert.match(res.reason, /nothing to preview/);
  } finally {
    await site.close();
  }
});

test('a huge page is read only as far as its head', async () => {
  // 4 MB of body behind a small head. The transfer is cut at </head>, so this
  // finishing at all is the assertion.
  const site = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.write(`<html><head><title>Big page</title></head><body>`);
    res.write('x'.repeat(4 * 1024 * 1024));
    res.end('</body></html>');
  });
  try {
    const previews = createLinkPreview({ allowPrivate: true });
    const res = await previews.get(`${site.origin}/big`);
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.title, 'Big page');
  } finally {
    await site.close();
  }
});

test('an oversized image is refused, and the card survives without it', async () => {
  const big = Buffer.alloc(4 * 1024 * 1024, 0x41);
  const site = await serve((req, res) => {
    if (req.url === '/huge.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': big.length });
      return res.end(big);
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      page({
        extra: '<meta property="og:title" content="Still a card"><meta property="og:image" content="/huge.png">',
      })
    );
  });
  try {
    const previews = createLinkPreview({ allowPrivate: true });
    const res = await previews.get(`${site.origin}/story`);
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.title, 'Still a card');
    assert.equal(res.image, null);
  } finally {
    await site.close();
  }
});

test('a failure is remembered, so a dead link is not retried on every scroll', async () => {
  const site = await serve((_req, res) => {
    res.writeHead(500);
    res.end('nope');
  });
  try {
    const previews = createLinkPreview({ allowPrivate: true });
    const a = await previews.get(`${site.origin}/broken`);
    const b = await previews.get(`${site.origin}/broken`);
    assert.equal(a.ok, false);
    assert.deepEqual(b, a);
    assert.equal(site.hits.length, 1);
  } finally {
    await site.close();
  }
});

test('a cached answer expires', async () => {
  const site = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page({ title: 'Visited again' }));
  });
  try {
    let clock = 1000;
    const previews = createLinkPreview({ allowPrivate: true, now: () => clock });
    await previews.get(`${site.origin}/x`);
    clock += 31 * 60 * 1000; // past the 30-minute lifetime of a good preview
    await previews.get(`${site.origin}/x`);
    assert.equal(site.hits.length, 2);
  } finally {
    await site.close();
  }
});

test('a link that is not a web link never becomes a request', async () => {
  const previews = createLinkPreview({ allowPrivate: true });
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', '', null]) {
    const res = await previews.get(bad);
    assert.equal(res.ok, false, String(bad));
    assert.match(res.reason, /not a web link/);
  }
});

// -------------------------------------------------------- a link that is a photo
//
// A picture linked to in a message is drawn in the bubble rather than left as a
// URL, and it goes down the same road as everything else here: fetched in main,
// checked, handed over as bytes. The window never reaches a remote host itself,
// so the one thing that must never appear is an <img> pointed at a stranger.

test('a picture in a message is fetched once and handed over as bytes', async () => {
  const site = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length });
    res.end(PNG);
  });
  try {
    const previews = createLinkPreview({ allowPrivate: true });
    const first = await previews.image(`${site.origin}/a.png`);
    assert.equal(first.ok, true, first.reason);
    assert.ok(first.image.startsWith('data:image/'), 'a data URL, so the window never connects anywhere');

    const again = await previews.image(`${site.origin}/a.png`);
    assert.deepEqual(again, first);
    assert.equal(site.hits.length, 1, 'a picture already fetched is not fetched again');
  } finally {
    await site.close();
  }
});

test('a card and a picture of the same link are two different questions', async () => {
  const site = await serve((req, res) => {
    if (req.url.endsWith('.png')) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length });
      return res.end(PNG);
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page({ title: 'A page' }));
  });
  try {
    const previews = createLinkPreview({ allowPrivate: true });
    const card = await previews.get(`${site.origin}/a.png`);
    const shot = await previews.image(`${site.origin}/a.png`);
    // The same URL asked two ways: one wants a page and does not get one, the
    // other wants a picture and does. Sharing a cache key would have let the
    // first answer stand in for the second.
    assert.equal(card.ok, false, 'a PNG is not a web page');
    assert.equal(shot.ok, true, shot.reason);
  } finally {
    await site.close();
  }
});

test('a link that is not a picture does not become one', async () => {
  const site = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page({ title: 'Not a picture' }));
  });
  try {
    const previews = createLinkPreview({ allowPrivate: true });
    assert.equal((await previews.image(`${site.origin}/x`)).ok, false);
    assert.equal((await previews.bytes(`${site.origin}/x`)).ok, false);
  } finally {
    await site.close();
  }
});

test('saving a picture reads the real bytes, not the thumbnail of them', async () => {
  const site = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length });
    res.end(PNG);
  });
  try {
    const previews = createLinkPreview({ allowPrivate: true });
    const saved = await previews.bytes(`${site.origin}/a.png`);
    assert.equal(saved.ok, true, saved.reason);
    assert.deepEqual(saved.body, PNG, 'what lands on disk is what the server served');
    assert.equal(saved.type, 'image/png');

    // Deliberately outside the cache: megabytes of a picture somebody asked for
    // once have no business displacing the cards.
    await previews.bytes(`${site.origin}/a.png`);
    assert.equal(site.hits.length, 2);
  } finally {
    await site.close();
  }
});

test('nothing on our own network can be fetched or saved as a picture', async () => {
  const site = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PNG);
  });
  try {
    const previews = createLinkPreview(); // the real guard
    assert.equal((await previews.image(`${site.origin}/a.png`)).ok, false);
    assert.equal((await previews.bytes(`${site.origin}/a.png`)).ok, false);
    assert.deepEqual(site.hits, [], 'the request never left this machine');
  } finally {
    await site.close();
  }
});
