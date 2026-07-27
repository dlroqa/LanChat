// The music bed itself — and the only thing anyone adding one has to do: drop an
// audio file at src/renderer/assets/agent-loop.<ext> and rebuild.
//
// Found with a glob rather than imported by name on purpose. A plain
// `import url from '../assets/agent-loop.mp3'` is a hard build failure when the
// file is not there, which would mean a clone of this repo without the track
// could not be built at all. A glob that matches nothing is an empty object, so
// the feature is simply absent and everything else still builds.
//
// Any format Chromium plays will do (.mp3 .ogg .opus .m4a .wav .flac). Prefer
// Ogg/Opus if the loop has to be seamless: MP3 carries encoder padding at both
// ends, and an HTMLAudioElement loop turns that padding into a small gap every
// time round.
//
// Vite emits the file into dist/renderer/assets with a hashed name and hands
// back a relative URL, which is what keeps it inside electron-builder's
// `dist/renderer/**` allowlist — a new top-level folder would build fine here
// and be missing from the packaged app.
const found = import.meta.glob('../assets/agent-loop.*', {
  eager: true,
  query: '?url',
  import: 'default',
});

// Sorted so that two files with different extensions still resolve to the same
// one every build, rather than whichever the glob happened to list first.
const names = Object.keys(found).sort();

export const TRACK_URL = names.length ? found[names[0]] : null;
export const HAS_TRACK = TRACK_URL != null;
