'use strict';

// Exactly which bytes are Kokoro, and what they must hash to.
//
// Everything here is pinned. The revision is a commit sha rather than `main`,
// because a model repository is a mutable branch like any other and "whatever
// was published this morning" is not a thing to download onto somebody's machine
// and then execute. Sizes and hashes were taken from that revision and
// cross-checked against Hugging Face's own `x-linked-etag`, which is the LFS
// object's sha256.
//
// This is the first place in this codebase that verifies a download by content
// rather than by length — the updater checks size alone. A wrong-sized file is
// the failure that happens by accident; a right-sized one is the failure that
// happens on purpose, and a 86 MB blob that gets loaded into an inference engine
// is worth telling those apart for.

// onnx-community/Kokoro-82M-v1.0-ONNX, Apache-2.0, the ONNX export of hexgrad's
// Kokoro-82M. The model card and the weights are both under that licence.
const REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
const HOST = 'https://huggingface.co';

// Which quantisation. `model_q8f16` is the smallest build that keeps the full
// voice quality — 86 MB against fp32's 326 MB — and int8 weights are what
// hardware with vector instructions is fastest at.
//
// It is also part of the cache key downstream, so changing this line invalidates
// every cached recording rather than mixing two models' output in one directory.
const MODEL = 'model_q8f16';

// The voice ring, in the order the renderer deals it out.
//
// This is the roster `voices()` publishes, and it is what makes a session sound
// like a conversation rather than one person reading a script — see the header of
// renderer/lib/agentVoice.js, which this deliberately satisfies rather than
// duplicates. Two properties are load-bearing:
//
//   * **Adjacent entries never share a gender**, so when two agents collide and
//     the ring steps one along, the result is audibly a different person rather
//     than a neighbouring shade of the same one. Accent alternates too where the
//     grades allow it.
//   * **The last entry is held back for the user**, because `ringVoices` deals
//     `list.slice(0, -1)` to the agents and keeps `list.at(-1)` for your own
//     turns. `af_heart` is Kokoro's only A-graded voice and its warmest, which is
//     what a narrator reading your side of a conversation should be — the same
//     judgement Gemini's ring makes with Sulafat.
//
// Twelve agent voices, which is also the length of AGENT_HUES, so an agent's
// voice slot stays its colour slot. Chosen from the higher end of the model
// card's own quality grades; the low-graded voices are real but audibly worse,
// and a roster is not improved by padding it.
const RING = Object.freeze([
  'af_bella', // US female, A-
  'am_fenrir', // US male, C+
  'bf_emma', // UK female, B-
  'bm_george', // UK male, C
  'af_nicole', // US female, B-
  'am_michael', // US male, C+
  'af_aoede', // US female, C+
  'bm_fable', // UK male, C
  'bf_isabella', // UK female, C
  'am_puck', // US male, C+
  'af_sarah', // US female, C+
  'bm_lewis', // UK male, D+
  'af_heart', // US female, A — held back as the narrator
]);

// What Settings shows for each, since a voice id is not a name.
const VOICE_LABELS = Object.freeze({
  af_bella: 'Bella',
  am_fenrir: 'Fenrir',
  bf_emma: 'Emma',
  bm_george: 'George',
  af_nicole: 'Nicole',
  am_michael: 'Michael',
  af_aoede: 'Aoede',
  bm_fable: 'Fable',
  bf_isabella: 'Isabella',
  am_puck: 'Puck',
  af_sarah: 'Sarah',
  bm_lewis: 'Lewis',
  af_heart: 'Heart',
});

// The files, their sizes and their hashes.
//
// `local` is the path under the weights directory and `remote` the path in the
// repository; they differ for the model so that changing MODEL above does not
// rename the file on every machine that already has one.
const FILES = Object.freeze([
  {
    local: 'model.onnx',
    remote: `onnx/${MODEL}.onnx`,
    bytes: 86033585,
    sha256: '04c658aec1b6008857c2ad10f8c589d4180d0ec427e7e6118ceb487e215c3cd0',
  },
  {
    local: 'tokenizer.json',
    remote: 'tokenizer.json',
    bytes: 3497,
    sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34',
  },
  {
    local: 'voices/af_bella.bin',
    remote: 'voices/af_bella.bin',
    bytes: 522240,
    sha256: 'f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b',
  },
  {
    local: 'voices/am_fenrir.bin',
    remote: 'voices/am_fenrir.bin',
    bytes: 522240,
    sha256: 'c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43',
  },
  {
    local: 'voices/bf_emma.bin',
    remote: 'voices/bf_emma.bin',
    bytes: 522240,
    sha256: '669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73',
  },
  {
    local: 'voices/bm_george.bin',
    remote: 'voices/bm_george.bin',
    bytes: 522240,
    sha256: 'c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc',
  },
  {
    local: 'voices/af_nicole.bin',
    remote: 'voices/af_nicole.bin',
    bytes: 522240,
    sha256: 'cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a',
  },
  {
    local: 'voices/am_michael.bin',
    remote: 'voices/am_michael.bin',
    bytes: 522240,
    sha256: '1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1',
  },
  {
    local: 'voices/af_aoede.bin',
    remote: 'voices/af_aoede.bin',
    bytes: 522240,
    sha256: '4a004c33430762e2461eedb2013fad808ef4ab3121f5300f554476caf58d8361',
  },
  {
    local: 'voices/bm_fable.bin',
    remote: 'voices/bm_fable.bin',
    bytes: 522240,
    sha256: 'f889083196807b4adb15e9204252165f503b8d33d3982e681c52443c49d798f1',
  },
  {
    local: 'voices/bf_isabella.bin',
    remote: 'voices/bf_isabella.bin',
    bytes: 522240,
    sha256: '3754352c4aaa46d17f27654ab7518d65b62ad6163a0f55a5f4330c2da2c4e94f',
  },
  {
    local: 'voices/am_puck.bin',
    remote: 'voices/am_puck.bin',
    bytes: 522240,
    sha256: 'fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0',
  },
  {
    local: 'voices/af_sarah.bin',
    remote: 'voices/af_sarah.bin',
    bytes: 522240,
    sha256: '4409fbc125afabacc615d94db5398d847006a737b0247d6892b7a9a0007a2f0a',
  },
  {
    local: 'voices/bm_lewis.bin',
    remote: 'voices/bm_lewis.bin',
    bytes: 522240,
    sha256: 'b8f671cef828c30e66fdf0b0756a76bba58f6bb3398cbbf27058642acbcedb97',
  },
  {
    local: 'voices/af_heart.bin',
    remote: 'voices/af_heart.bin',
    bytes: 522240,
    sha256: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b',
  },
]);

// 92.8 MB, of which the model is 86 MB and the thirteen voices are the rest.
const TOTAL_BYTES = FILES.reduce((sum, f) => sum + f.bytes, 0);

function urlFor(file) {
  return `${HOST}/${REPO}/resolve/${REVISION}/${file.remote}`;
}

module.exports = {
  REPO,
  REVISION,
  HOST,
  MODEL,
  RING,
  VOICE_LABELS,
  FILES,
  TOTAL_BYTES,
  urlFor,
};
