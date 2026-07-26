'use strict';

const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const { normalizeWebUrl } = require('./webLinks');

// Link previews.
//
// A preview is a page LanChat fetches on your behalf, so it is the one thing in
// the app that reaches out past your own network — and the link came from
// somebody else. That makes the rules here as much of the feature as the
// parsing:
//
//   - http/https only, and the same check is re-run on every redirect;
//   - the address has to be public, checked where the socket resolves it, so a
//     link from a peer can never make this machine fetch http://192.168.1.1/ or
//     anything on the tailnet;
//   - a page is read only as far as </head>, and only text/html is parsed;
//   - the thumbnail is fetched here and handed over as a data URL, so the window
//     itself never talks to a remote host;
//   - nothing is sent: no cookie jar, no referrer, no credentials.
//
// The renderer asks only for the first link in a bubble, and only once that
// bubble has been scrolled into view, so opening a long conversation does not fan
// out into a page fetch per message.

const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
// A cap for the pathological case; the read normally stops at </head> long
// before this.
const MAX_HTML_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
// A thumbnail wide enough for the card at 2x, and small enough to keep in memory.
const THUMB_WIDTH = 480;
// A png this small is passed through untouched, so a logo keeps its transparency.
const PNG_PASSTHROUGH_BYTES = 200 * 1024;

const OK_TTL_MS = 30 * 60 * 1000;
// Failures are remembered too, briefly — a dead link should not be refetched on
// every scroll — but not so long that a page fixed in the meantime stays broken.
const FAIL_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 120;

const TITLE_MAX = 200;
const DESC_MAX = 300;
const SITE_MAX = 60;

// ------------------------------------------------------------- address guarding

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true; // this host, private, loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT — Tailscale lives here
  if (a >= 224) return true; // multicast and broadcast
  return false;
}

// Any address that is not routable on the public internet, which for this app
// also means "somewhere on the user's own network".
function isPrivateAddress(ip) {
  const s = String(ip || '').toLowerCase();
  if (!s) return true;
  if (s.includes('.') && !s.includes(':')) return isPrivateIPv4(s);
  // IPv4-mapped/embedded (::ffff:10.0.0.1) is still that IPv4 address.
  const tail = s.slice(s.lastIndexOf(':') + 1);
  if (tail.includes('.')) return isPrivateIPv4(tail);
  if (s === '::' || s === '::1') return true;
  const head = s.split(':')[0];
  if (/^f[cd]/.test(head)) return true; // unique local fc00::/7
  if (/^fe[89ab]/.test(head)) return true; // link-local fe80::/10
  if (/^ff/.test(head)) return true; // multicast
  return false;
}

// Names that only ever mean "this network", refused without a lookup so a
// resolver that answers them cannot be the thing that decides.
function hostLooksInternal(hostname) {
  const h = String(hostname || '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost') return true;
  if (/\.(local|internal|localdomain|home|lan|intranet)$/.test(h)) return true;
  if (h.endsWith('.home.arpa')) return true;
  // A single label with no dot is a LAN name ("router", "nas"), not a site.
  if (!h.includes('.') && !h.includes(':')) return true;
  return false;
}

// The address check belongs where the connection is made, not before it:
// checking first and connecting after leaves a window in which a name that
// resolved publicly can answer with 10.0.0.1 on the second lookup. So the
// socket's own resolver is what we vet — nothing is sent to an address this
// refuses.
function guardedLookup(hostname, options, cb) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return cb(err);
    const found = Array.isArray(address) ? address : [{ address, family }];
    for (const a of found) {
      if (isPrivateAddress(a.address)) return cb(new Error('link points at a private address'));
    }
    return Array.isArray(address) ? cb(null, address) : cb(null, address, family);
  });
}

// Refused on the name alone, before any resolver is asked. An address written
// out in the link (http://192.168.1.1/, http://[::1]/) never reaches the lookup
// hook at all — the socket just connects — so it is caught here instead.
function assertPublicHostname(hostname, { allowPrivate = false } = {}) {
  if (allowPrivate) return;
  const host = String(hostname || '').replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isPrivateAddress(host)) throw new Error('link points at a private address');
  if (hostLooksInternal(host)) throw new Error('link points at a local network name');
}

// ------------------------------------------------------------------ networking

// A GET that reads at most `limit` bytes and never follows a redirect on its
// own — the caller re-validates each hop. `truncate` is the difference between
// the two things fetched here: a page is read up to the cap and parsed from what
// arrived (plenty of real pages are megabytes of body after a small head), while
// an image has to arrive whole, so an oversized one is refused outright.
function request(url, { headers, limit, truncate, stopAt, lookup }) {
  return new Promise((resolve, reject) => {
    const mod = new URL(url).protocol === 'https:' ? https : http;
    // No cookie jar, no referrer, no credentials — only the headers passed in.
    const req = mod.get(url, { headers, ...(lookup && { lookup }) }, (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;
      const type = String(res.headers['content-type'] || '').toLowerCase();
      if (status >= 300 && status < 400 && location) {
        res.destroy();
        return resolve({ redirect: new URL(location, url).href });
      }
      if (status !== 200) {
        res.destroy();
        return reject(new Error(`HTTP ${status}`));
      }
      const declared = Number(res.headers['content-length']);
      if (!truncate && Number.isFinite(declared) && declared > limit) {
        res.destroy();
        return reject(new Error('response too large'));
      }
      const chunks = [];
      let size = 0;
      // `stopAt` ends a page transfer at </head>: everything a preview needs has
      // arrived by then, so the rest of the document is never pulled down. The
      // carry-over covers a marker split across two chunks.
      let carry = '';
      res.on('data', (c) => {
        chunks.push(c);
        size += c.length;
        if (stopAt) {
          const text = (carry + c.toString('latin1')).toLowerCase();
          if (text.includes(stopAt)) return res.destroy();
          carry = text.slice(-stopAt.length);
        }
        // The cap: for a page, parse what arrived; for an image, this is the
        // backstop for a server that under-declared its length.
        if (size >= limit) res.destroy();
      });
      res.on('close', () => resolve({ body: Buffer.concat(chunks), type }));
      // A connection cut after some bytes arrived is still worth parsing; one
      // that failed outright is not.
      res.on('error', (err) => (size > 0 ? resolve({ body: Buffer.concat(chunks), type }) : reject(err)));
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('request timed out')));
  });
}

// Follows redirects by hand so every hop goes through the same checks.
async function fetchGuarded(url, { headers, limit, truncate = false, stopAt = null, allowPrivate }) {
  let current = normalizeWebUrl(url);
  if (!current) throw new Error('not a web link');
  const lookup = allowPrivate ? null : guardedLookup;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    assertPublicHostname(new URL(current).hostname, { allowPrivate });
    const res = await request(current, { headers, limit, truncate, stopAt, lookup });
    if (!res.redirect) return { ...res, url: current };
    const next = normalizeWebUrl(res.redirect);
    if (!next) throw new Error('redirected off the web');
    current = next;
  }
  throw new Error('too many redirects');
}

// ------------------------------------------------------------------- parsing

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" };

function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name) => {
    const key = name.toLowerCase();
    if (ENTITIES[key] != null) return ENTITIES[key];
    if (key[0] === '#') {
      const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

function clean(s, max) {
  if (s == null) return null;
  const out = decodeEntities(String(s)).replace(/\s+/g, ' ').trim();
  if (!out) return null;
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

function attr(tag, name) {
  const m =
    new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag) ||
    new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i').exec(tag) ||
    new RegExp(`${name}\\s*=\\s*([^\\s"'>]+)`, 'i').exec(tag);
  return m ? m[1] : null;
}

// Pulls the Open Graph / Twitter card fields out of a page's head. Regex rather
// than a parser on purpose: the result is only ever read as text, never rendered
// as markup, so there is nothing here for a malformed page to exploit.
function parseMetadata(html, baseUrl) {
  const doc = String(html || '');
  const headEnd = doc.search(/<\/head>/i);
  const head = headEnd > 0 ? doc.slice(0, headEnd) : doc;
  const meta = new Map();
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = (attr(tag, 'property') || attr(tag, 'name') || '').toLowerCase();
    const content = attr(tag, 'content');
    if (key && content != null && !meta.has(key)) meta.set(key, content);
  }
  const pick = (...keys) => {
    for (const k of keys) {
      const v = meta.get(k);
      if (v) return v;
    }
    return null;
  };

  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  const title = clean(pick('og:title', 'twitter:title') || (titleTag ? titleTag[1] : null), TITLE_MAX);
  const description = clean(pick('og:description', 'twitter:description', 'description'), DESC_MAX);

  let siteName = clean(pick('og:site_name', 'application-name'), SITE_MAX);
  if (!siteName && baseUrl) {
    try {
      siteName = new URL(baseUrl).hostname.replace(/^www\./, '');
    } catch {
      siteName = null;
    }
  }

  const rawImage = pick('og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image', 'twitter:image:src');
  let imageUrl = null;
  if (rawImage && baseUrl) {
    try {
      imageUrl = normalizeWebUrl(new URL(decodeEntities(rawImage).trim(), baseUrl).href);
    } catch {
      imageUrl = null;
    }
  }

  return { title, description, siteName, imageUrl };
}

// ------------------------------------------------------------------ thumbnails

// Downscaled in the main process, then handed over as a data URL. Electron's
// nativeImage does the resizing; without it (unit tests) a small image is passed
// through and a large one is dropped rather than shipped whole to the renderer.
function toThumbnail(buf, type) {
  const isPng = type.includes('png') && buf.length <= PNG_PASSTHROUGH_BYTES;
  let nativeImage = null;
  try {
    ({ nativeImage } = require('electron'));
  } catch {
    nativeImage = null;
  }
  if (!nativeImage || typeof nativeImage.createFromBuffer !== 'function') {
    return isPng ? `data:image/png;base64,${buf.toString('base64')}` : null;
  }
  try {
    let img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return null;
    const { width } = img.getSize();
    if (isPng && width <= THUMB_WIDTH) return `data:image/png;base64,${buf.toString('base64')}`;
    if (width > THUMB_WIDTH) img = img.resize({ width: THUMB_WIDTH, quality: 'good' });
    return `data:image/jpeg;base64,${img.toJPEG(78).toString('base64')}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------- facade

function createLinkPreview({ version = '0', allowPrivate = false, now = () => Date.now() } = {}) {
  // Identifying LanChat honestly is also what gets served the card markup:
  // sites hand Open Graph tags to things that look like link unfurlers.
  const headers = {
    'User-Agent': `Mozilla/5.0 (compatible; LanChat/${version}; +link-preview)`,
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'en',
  };

  const cache = new Map(); // url -> { at, ttl, value }
  const inflight = new Map(); // url -> Promise

  function remember(url, value, ttl) {
    cache.set(url, { at: now(), ttl, value });
    // Oldest first: Map preserves insertion order, and every write re-inserts.
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    return value;
  }

  async function load(url) {
    const page = await fetchGuarded(url, {
      headers,
      limit: MAX_HTML_BYTES,
      truncate: true,
      stopAt: '</head>',
      allowPrivate,
    });
    if (!/text\/html|application\/xhtml/.test(page.type)) throw new Error('not a web page');
    const meta = parseMetadata(page.body.toString('utf8'), page.url);
    if (!meta.title && !meta.description) throw new Error('page has nothing to preview');

    let image = null;
    if (meta.imageUrl) {
      try {
        const shot = await fetchGuarded(meta.imageUrl, {
          headers: { ...headers, Accept: 'image/*' },
          limit: MAX_IMAGE_BYTES,
          allowPrivate,
        });
        if (shot.type.startsWith('image/')) image = toThumbnail(shot.body, shot.type);
      } catch {
        // A card without its picture is still a card.
        image = null;
      }
    }
    return { ok: true, url, title: meta.title, description: meta.description, siteName: meta.siteName, image };
  }

  return {
    // Never rejects: the renderer treats "no preview" and "failed" the same way,
    // and a bad link must not surface as an unhandled IPC error.
    async get(raw) {
      const url = normalizeWebUrl(raw);
      if (!url) return { ok: false, reason: 'not a web link' };
      const hit = cache.get(url);
      if (hit && now() - hit.at < hit.ttl) return hit.value;
      if (hit) cache.delete(url);
      if (inflight.has(url)) return inflight.get(url);

      const run = load(url)
        .then((value) => remember(url, value, OK_TTL_MS))
        .catch((err) => remember(url, { ok: false, reason: err.message }, FAIL_TTL_MS))
        .finally(() => inflight.delete(url));
      inflight.set(url, run);
      return run;
    },
    clear() {
      cache.clear();
    },
  };
}

module.exports = {
  createLinkPreview,
  guardedLookup,
  isPrivateAddress,
  hostLooksInternal,
  parseMetadata,
  decodeEntities,
};
