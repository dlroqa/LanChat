export function formatBytes(n) {
  if (!n && n !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date();
  yest.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

// A date on its own, in the numeric form the reader's own locale uses —
// "7/1/2026" here, "01/07/2026" elsewhere. For labels sat beside something else
// that has to stay readable, where formatDay()'s "Jul 1, 2026" is too wide and
// its "Today" is the wrong thing to say: a creation date is a fact about a
// record, not a relative time that goes stale overnight.
//
// Empty for anything that is not a real timestamp, so a record written before
// the field existed shows nothing rather than "Invalid Date" or 1/1/1970.
export function formatShortDate(ts) {
  const d = new Date(ts);
  if (!ts || Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString([], { year: 'numeric', month: 'numeric', day: 'numeric' });
}

// Deterministic color for an avatar from an id/name.
const COLORS = ['#2563eb', '#7c3aed', '#db2777', '#059669', '#d97706', '#0891b2', '#dc2626', '#4f46e5'];
export function colorFor(key) {
  let h = 0;
  const s = String(key || '');
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

export function initials(name) {
  const parts = String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() || '').join('') || '?';
}

export function platformLabel(p) {
  return { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[p] || p || '';
}

export function isImage(mime) {
  return typeof mime === 'string' && mime.startsWith('image/');
}
export function isVideo(mime) {
  return typeof mime === 'string' && mime.startsWith('video/');
}
export function isAudio(mime) {
  return typeof mime === 'string' && mime.startsWith('audio/');
}
