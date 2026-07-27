// The music an agent works to. Adding one is dropping a file into
// src/renderer/assets/music/ and rebuilding — nothing here needs editing.
//
// The file name becomes the name in Settings: `sleepy-island.opus` is listed as
// "Sleepy island". That is the whole convention, and it is why this is a folder
// rather than one fixed file — several tracks can sit there and each shows up as
// its own choice, the way the six ringtones in sounds.js do.
//
// Found with a glob rather than imported by name on purpose. A plain
// `import url from '../assets/music/x.opus'` is a hard build failure when the
// file is not there, which would mean a clone of this repo without the audio
// could not be built at all. A glob that matches nothing is an empty object, so
// the feature is simply absent and everything else still builds.
//
// Ogg/Opus is what to reach for: it is much the smallest at listening quality,
// and it loops without a seam. MP3 carries encoder padding at both ends, which
// an HTMLAudioElement loop turns into a small gap every time round.
//
// Vite emits each file into dist/renderer/assets with a hashed name and hands
// back a relative URL, which is what keeps them inside electron-builder's
// `dist/renderer/**` allowlist — a new top-level folder would build fine here
// and be missing from the packaged app.
const found = import.meta.glob('../assets/music/*.{opus,ogg,mp3,m4a,wav,flac}', {
  eager: true,
  query: '?url',
  import: 'default',
});

// "../assets/music/sleepy-island.opus" -> "sleepy-island"
export function trackKey(filePath) {
  return filePath.split('/').pop().replace(/\.[^.]+$/, '');
}

// "sleepy-island" -> "Sleepy island". Sentence case rather than Title Case
// because these are names of pieces, not headings, and the six ringtones next to
// them read the same way.
export function trackLabel(key) {
  const words = key.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

// { 'agent-loop': { label: 'Agent loop', url: '/assets/agent-loop-abc123.opus' } }
// Sorted so the list is stable between builds rather than in whatever order the
// glob happened to walk the directory.
export const TRACKS = Object.fromEntries(
  Object.keys(found)
    .sort()
    .map((p) => {
      const key = trackKey(p);
      return [key, { label: trackLabel(key), url: found[p] }];
    })
);

export const TRACK_KEYS = Object.keys(TRACKS);
export const HAS_TRACK = TRACK_KEYS.length > 0;
export const DEFAULT_TRACK = TRACK_KEYS[0] || null;

// The URL to actually play, given what is saved in config. `customUrl` is the
// user's own file, already served by the local preview endpoint. Null means
// there is nothing to play — an empty build, or "custom" chosen with no file
// picked yet — and the player treats that as silence rather than an error.
export function trackUrl(name, customUrl) {
  if (name === 'custom') return customUrl || null;
  const track = TRACKS[name] || (DEFAULT_TRACK ? TRACKS[DEFAULT_TRACK] : null);
  return track ? track.url : null;
}
