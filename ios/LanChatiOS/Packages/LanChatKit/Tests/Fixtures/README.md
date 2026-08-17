# Golden fixtures

Generated. **Do not edit by hand.**

```bash
npm run ios:fixtures        # from the repository root
```

## What these are

The iOS port has to reproduce a pile of small, exact behaviours from the desktop app — a transcript
byte layout, a cron walker, the rule that decides whether an agent's turn may be erased. Writing the
Swift tests by reading the JavaScript would be a re-derivation, and a re-derivation makes the same
mistake twice: it agrees with whatever the reader thought the code said.

So these vectors are **extracted by running the shipping desktop modules** and recording what they
actually answer. The Swift suite asserts against them, which makes it a conformance suite against
LanChat rather than a second opinion about it.

That is the only way to catch traps like the transcript's `lp("2")` length-prefixing the *string*
`"2"` rather than the integer, or keys being base64url while signatures are standard base64.

## When to regenerate

Whenever a ported module in `src/` changes. A diff here is then the review question *"did we mean to
change the wire?"* — asked at the moment it can still be answered.

The generator is deterministic: fixed key seeds, fixed nonces, a fixed clock, and a pinned timezone
(`America/New_York`, chosen for its DST edges). Two runs are byte-identical, so any diff is a real
behavioural change.

## The files

| File | Source | Pins |
|---|---|---|
| `auth-transcripts.json` | `main/authProto.js` | the signed transcript byte for byte, both role bytes, Ed25519 signatures, fingerprints, and the strict base64url gate |
| `handshake-reject.json` | `main/handshake.js` | every malformed `hello` and what `parseHello` does with it; the wire reason and close code |
| `cron-nextdue.json` | `main/tasks/cron.js` | next-due tables including both DST edges — the skipped hour and the doubled one |
| `empty-turn.json` | `renderer/lib/emptyTurn.js` | which turns may be erased and, mostly, which may not |
| `kokoro-text.json` | `main/tts/kokoroText.js` | normalisation, phoneme repairs, sentence splitting, and the style-row clamp |
| `signal-shapes.json` | `renderer/lib/signal.js` | the SDP and ICE-candidate shapes on the wire |
| `glare.json` | `renderer/lib/groupCall.js` | who offers in a group call, over every unordered pair |
| `dial-backoff.json` | `main/discovery.js` | the doubling schedule, 30 s to the 15-minute cap |
| `linkify.json` | `renderer/lib/linkify.js` | typed runs, safe hrefs, image links |
| `find-in-thread.json` | `renderer/lib/findInThread.js` | hit ordinals across every searchable field |
| `session-folders.json` | `renderer/lib/sessionFolders.js` | folder membership, drop indices, no-op placement |
| `agent-rings.json` | `renderer/lib/agentColor.js` + `agentVoice.js` | the colour and voice rings, and the slot invariant that makes them one idea |

## Notes on two of them

**`cron-nextdue.json`** is only meaningful alongside its timezone, which is recorded in every file's
`_` header. The interesting rows are the DST ones: a daily 02:30 has no instant to land on the
morning the clocks go forward, so that day is silently skipped; and a daily 01:30 fires once, not
twice, the morning they go back.

**`kokoro-text.json`** stops short of the phonemiser, which needs the model weights. `splitFor` is
driven by a stub measure (string length) so what the fixture pins is the greedy sentence packing —
the part Swift has to reproduce — rather than the tokeniser, which it does not. Note that
`styleOffset` clamps to `STYLE_ROWS - 1` (509), not to `MAX_BODY_TOKENS` (508); the difference is
silent and sounds like the voice hurrying the end of a long sentence.
