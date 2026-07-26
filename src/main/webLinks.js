'use strict';

// What counts as a web link, in one place.
//
// A link in a message was typed by somebody else, so this is the gate it passes
// through before the OS is ever asked to open it: http and https only. A
// `javascript:`, `file:`, `data:` or custom-protocol URL smuggled into a message
// is refused here rather than handed to shell.openExternal, and URL() re-encodes
// the parts that need it so what is opened is exactly what was matched.
function normalizeWebUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}

module.exports = { normalizeWebUrl };
