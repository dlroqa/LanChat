# LanChat

A simple, peer-to-peer **LAN & Tailscale chat** app — text, voice, video, and file sharing — for macOS, Windows, and Linux. Think **LogMeIn Hamachi**, but for chatting: everyone on your [Tailscale](https://tailscale.com) mesh (or plain local network) shows up automatically, and you talk **directly device-to-device**. No servers, no accounts, nothing in the cloud.

<p align="center"><i>Presence · Text chat · Voice calls · Video calls · File / photo / video sharing</i></p>

---

## Why it's different

- **No central server.** Every LanChat app is its own tiny node. Messages, files, and calls flow straight between your devices.
- **Rides your Tailscale mesh.** Devices are discovered from `tailscale status`, so anyone on your tailnet appears in your sidebar the moment they open LanChat — with a stable `100.x.y.z` address that works anywhere.
- **Also works on a plain LAN.** A UDP broadcast beacon finds peers on the same local network even without Tailscale.
- **Direct P2P calls.** Voice and video use WebRTC. On a tailnet the peer's IP is a direct ICE candidate, so calls connect **without any STUN/TURN server**.
- **Private by design.** Everything stays on your own devices and network.

## Features

| | |
|---|---|
| 👥 **Presence** | See who's online across Tailscale + LAN, live. |
| 💬 **Text chat** | 1:1 messaging with typing indicators and local history. |
| 📞 **Voice calls** | Crisp P2P audio over LAN/tailnet, with ring tone and ringback. |
| 🎥 **Video calls** | Camera calls with mute / camera toggle and picture-in-picture. |
| 👥 **Group video calls** | Call several people at once — a direct peer-to-peer mesh, no server. Best for small groups (up to ~5 others). |
| 📻 **Push to talk** | Hold ⌘ (Ctrl on Windows/Linux) to transmit instantly — walkie-talkie style, no ringing. |
| 🎚️ **Source selection** | Choose your microphone and camera — in Settings, or switch live mid-call. |
| 📺 **Docked call panel** | Video plays portrait in the right panel; one button expands it full screen. |
| 🪟 **Picture-in-picture** | Minimise during a video call and it shrinks to a floating tile in the top-right corner, always on top. |
| 📶 **Live connection graphs** | When not in a call, the panel charts real round-trip latency and link quality. |
| 🤖 **Agents** | Add an AI agent in **Settings → Agents** and it becomes just another thread. Four ways to connect one — **HTTP API** (recommended), **ACP** over stdio, a **local command**, or an **SSH command** on another host. Share yours with people on your network and they reach it *through* you: approvals stay on your machine and are never handed to a peer, and everyone sharing it takes turns. A new agent is local-only until you grant reach, peer by peer. |
| ✨ **Living agent status** | An agent has no latency worth charting, so it gets the graph's slot to say what it is *doing* — and the row moves while it does. The phrase types itself in under a block cursor, which then sweeps back across the finished word; the pip beside it throws a small firework in a fresh neon colour every burst; and light trails race the width of the row, timed so they fall back into step each time the phrase changes. The moment it finishes, a firework goes off from the middle of the row — neon rays spreading outward to fill it corner to corner, then fading away over a couple of seconds — and then it settles to a slow green-to-cyan wave running from the pip through the word. Behind the text the trails are damped down, so the word stays easily readable while they pass, and **reduce motion** removes the animation entirely rather than freezing it — the words still say everything. |
| 🔊 **Sound choices** | 6 ringtones + 8 message sounds, each with volume control and a custom-file option. |
| 📎 **File sharing** | Send any file, photo, or video — images & clips preview inline. Drag-and-drop supported. |
| 🔗 **Links** | Links in messages are clickable and open in your own browser, never inside LanChat. LanChat also unfurls the first link in a message into a small card with the page's title, description, and picture — fetched by the app itself (there is no server to do it for you), only for a message you have actually scrolled to, and switched off in **Settings → Privacy** if you would rather nothing left your machine. |
| 🪪 **Simple identity** | Pick a display name, and either a colour or your own profile picture. No sign-up. |
| 🔔 **Status menu** | Lives in the macOS menu bar, Windows tray, and Ubuntu status area — who's online, unread badge, quick jump into a chat. |
| 🔒 **Addresses hidden** | IP addresses are hidden by default; peers are identified by name. |
| 🤝 **Shared tailnets** | Devices shared in from another tailnet are discovered and marked. |
| ⬆️ **Self-updating** | **Settings → Updates → Check for Updates** pulls the latest GitHub release and installs it. |
| 🔔 **Update notice** | A subtle banner slides in at the top of the window whenever a newer release is found — while you're using the app, not just at launch — with **Update now** or **Later**. |
| 🪟 **Windows convenience** | Installer adds a desktop shortcut; an optional setting starts LanChat in the tray at Windows login. |

---

## Install

### Option A — download a build (easiest)

Grab the installer for your machine from the [Releases page](https://github.com/dlroqa/LanChat/releases):

| Your machine | Download |
|---|---|
| **macOS — Apple Silicon** (M1–M4) | `LanChat-<version>-arm64.dmg` |
| **macOS — Intel** | `LanChat-<version>-x64.dmg` |
| **Windows** | `LanChat.Setup.<version>.exe` (installer) or `LanChat.<version>.exe` (portable) |
| **Linux** | `LanChat-<version>.AppImage`, or `lanchat_<version>_amd64.deb` |

> Not sure which Mac you have?  → **Apple menu → About This Mac**. "Apple M1/M2/M3/M4" means
> Apple Silicon; "Intel Core…" means Intel.
>
> The `-mac.zip` files are used by the in-app updater — you don't need to download them.

> **Unsigned builds.** These are ad-hoc signed, not signed with an Apple/Microsoft
> developer certificate, so your OS will warn you once.
>
> - **macOS:** drag LanChat to Applications, then right-click it → **Open** → **Open**.
>   If macOS claims the app **"is damaged and can't be opened"**, it isn't corrupt — that's
>   Apple's wording for a quarantined download. Clear the flag:
>   ```bash
>   xattr -dr com.apple.quarantine /Applications/LanChat.app
>   ```
>   See [Installing without Gatekeeper warnings](#installing-without-gatekeeper-warnings-macos)
>   to skip the prompt entirely.
> - **Windows:** on the SmartScreen prompt choose **More info → Run anyway**.
> - **Linux:** `chmod +x LanChat-*.AppImage && ./LanChat-*.AppImage`

### Option B — run from source

```bash
git clone https://github.com/dlroqa/LanChat.git
cd LanChat
npm install
npm run dev     # launches the app with hot-reload
```

Build installers yourself:

```bash
npm run dist            # current OS
npm run dist:linux      # e.g. Linux AppImage + deb
```

---

## Updating

LanChat checks for a newer release on launch and periodically while it stays open. When one is
found, a subtle banner slides in at the top-centre of the window: choose **Update now** to
download and install it, or **Later** to dismiss it for this session. You can also check any
time under **Settings → Updates → Check for Updates**. Either way LanChat queries this repo's
[latest release](https://github.com/dlroqa/LanChat/releases/latest), and if a newer version
exists it downloads the right file for your machine and installs it:

| Platform | What happens |
|---|---|
| **macOS** | Downloads the `.zip`, re-signs it ad-hoc, replaces the app in place, and relaunches. |
| **Windows** | Runs the NSIS installer, which upgrades in place and relaunches. |
| **Linux (AppImage)** | Replaces the running AppImage and relaunches. |
| **Linux (.deb)** | Downloads the package and opens it — installing a `.deb` needs root, so your package manager finishes the job. |

> **Why not auto-update in the background?** Electron's built-in updater (Squirrel) refuses to
> apply updates unless the app has a paid **Apple Developer ID** signature. LanChat is ad-hoc
> signed, so it uses a self-contained updater instead: HTTPS-only downloads from this repo's
> releases, with the file size verified against what GitHub reports before anything is run.
> Updates are always started by you — nothing is installed silently.

## Installing without Gatekeeper warnings (macOS)

The warning you see on macOS is **not** caused by the app being unsigned on its own — it's
the `com.apple.quarantine` flag, which is attached by the program that *downloads* the file
(browsers, Mail, AirDrop). Command-line tools don't attach it. So if the app reaches the Mac
by any route other than a browser, **it opens with no prompt at all.**

Getting rid of the prompt for downloads-from-the-web permanently requires notarization,
which needs a paid Apple Developer ID. The two routes below are free and need no certificate.

### Route 1 — copy it over your tailnet (no prompt)

Since your machines are already on Tailscale, copy the app straight to the other Mac instead
of downloading it there:

```bash
# from a machine that already has the file
scp LanChat-0.1.1-arm64.dmg you@other-mac:~/Downloads/
```

`scp`, `rsync`, `cp`, and USB drives do not set the quarantine flag, so the copied app just
opens. Once one Mac is running LanChat you can also send the installer to everyone else
**through LanChat itself** — same effect, no terminal needed.

> Use `LanChat-0.1.1.dmg` (no `-arm64`) for Intel Macs.

### Route 2 — build it on the target Mac (no prompt)

Apps you compile locally are never quarantined:

```bash
git clone https://github.com/dlroqa/LanChat.git
cd LanChat
npm install
npm run dist        # produces release/LanChat-*.dmg, already ad-hoc signed
```

### Route 3 — clear the flag after downloading

If you did download through a browser, one command fixes it:

```bash
xattr -dr com.apple.quarantine /Applications/LanChat.app
```

> **Not recommended:** disabling Gatekeeper system-wide (`spctl --master-disable`). It weakens
> security for *every* app on the machine to solve a single-app problem.

### A note on Homebrew

Installing via a Homebrew tap is **not** a workaround: Homebrew has deprecated
`--no-quarantine` and is [ending support for casks that fail Gatekeeper checks on
September 1, 2026](https://github.com/Homebrew/brew/issues/20755). Distributing through
Homebrew will require a signed and notarized app.

---

## Setup (2 minutes)

1. **Install Tailscale** on each device and sign in to the same tailnet — <https://tailscale.com/download>. (Skip this if you only use LanChat on one local network.)
2. **Open LanChat** and pick a display name + color.
3. Other people on your tailnet/LAN who are running LanChat **appear automatically** in the left sidebar. Click one and start chatting, calling, or sending files.

### Push to talk (walkie-talkie)

Select someone and **hold the push-to-talk key** — ⌘ Command on macOS, Ctrl on Windows and
Linux — to transmit instantly. There is no ringing on either side; audio starts as soon as the
channel is up, and stops the moment you release. You can also press and hold the 📻 button in
the right-hand panel.

Like a GMRS/ham handheld, keying up plays a short **"go ahead" cue** so you know to press first
and then speak, and the person you're transmitting to hears a brief **"incoming" tone** just
before your audio streams.

Configure it under **Settings → Push to talk** (enable/disable, choose the key, or refuse
incoming transmissions).

**How it works.** Audio is **Opus over UDP**, carried by WebRTC (SRTP) directly peer-to-peer
across your tailnet or LAN — the same direct connection ordinary calls use, with no STUN/TURN
and no relay. WebRTC additionally provides jitter buffering, packet-loss concealment and echo
cancellation, which a hand-rolled UDP sender would not.

> **Your microphone is only ever opened by *you*.** Each direction is a separate connection:
> transmitting attaches your mic, while receiving auto-answers **receive-only** and adds no
> tracks at all. An incoming transmission therefore cannot open your microphone. The mic is also
> released automatically after 60 seconds without use, so the OS mic indicator does not stay lit.

**Two limits worth knowing:**

1. **Hold-to-talk works while LanChat is focused.** Electron's global shortcut API has no
   key-*up* event, so a true system-wide "hold to talk" is not possible — only a toggle would be,
   which is not the same thing. Rather than ship something that behaves differently from what the
   key implies, hold-to-talk is in-window.
2. **Modifier keys stay usable.** Pressing another key during the hold (⌘C, ⌘V) ends
   transmission, and the key is ignored entirely while you are typing a message.

### Talking to people on another tailnet (Tailscale device sharing)

You don't need to be on the same tailnet. Use [Tailscale device sharing](https://tailscale.com/kb/1084/sharing)
to share a machine with someone else's account — it then appears in their LanChat sidebar
automatically, marked **shared**.

1. In the [Tailscale admin console](https://login.tailscale.com/admin/machines), open the
   machine's **⋯** menu → **Share…**, and send the invite link.
2. Once they accept, the machine shows up in their tailnet with a `100.x` address, and LanChat
   discovers it like any other peer.

> ### ⚠️ Not yet verified
>
> **Everything in this section is a prediction, not a test result.** LanChat's shared-tailnet
> behaviour has *not* been exercised end-to-end yet — all testing so far has been between devices
> on a single tailnet. The expectations below are derived from how LanChat opens connections
> (which is verifiable in the source) combined with Tailscale's documented behaviour that it
> [**quarantines shared devices by default**](https://tailscale.com/kb/1084/sharing): a shared
> machine can *answer* connections from the tailnet it was shared into, but cannot *start* them.
>
> If you test this, please [open an issue](https://github.com/dlroqa/LanChat/issues) with what
> actually happened so this section can be replaced with facts.

**Why direction matters.** Every LanChat feature is either *carried on a connection already open*
or *needs a brand-new connection*. Only the second kind is affected by quarantine:

| Feature | How it connects | Expected with a quarantined shared device |
|---|---|---|
| Finding them | You probe their `100.x` address ([`discovery.js`](src/main/discovery.js)) | ✅ You find them |
| Them finding you | Their probe must originate from the shared side | ❌ Blocked — but see below |
| Presence, both ways | Both sides swap `hello` on the socket **you** opened ([`server.js`](src/main/server.js)) | ✅ Once connected, you appear in their sidebar too |
| Text chat, both ways | Reuses that same open socket | ✅ Both directions |
| Typing, connection graph | Same socket | ✅ Both directions |
| You send a file | You open an HTTP request to them | ✅ Works |
| They send a file | They must open a **new** HTTP request to you ([`fileTransfer.js`](src/main/fileTransfer.js)) | ❌ Expected to fail |
| Voice / video calls | Signalling rides the open socket, but ICE needs connectivity checks in **both** directions | ⚠️ Signalling should work; media may not connect |

**So: start the conversation from the non-shared side.** After that, presence and chat should work
normally in both directions, because they ride the one connection you opened.

For unrestricted two-way use — file sending both ways and dependable calls — either disable
quarantine for that share in the admin console, or add both people to the same tailnet as users.

Note that MagicDNS short names don't resolve for shared machines; LanChat sidesteps this by
connecting over the `100.x` address directly.

<details>
<summary><b>Checklist for testing this</b></summary>

From the **non-shared** side, in order:

1. Does the shared device appear in your sidebar, tagged `shared`?
2. Send a text message — does it arrive, and does their reply come back?
3. Do you appear in *their* sidebar once you've connected?
4. Send them a file. Then have them try to send you one — does that direction fail?
5. Start a voice call, then a video call. Does the call connect, and does media actually flow?
   (The in-call meters show whether audio is being sent and received.)

Steps 4 and 5 are where quarantine is predicted to bite. If they work anyway, quarantine is likely
off for that share — and this table needs correcting.

</details>

### Connecting manually

If discovery is blocked, use the **+** button in the sidebar and enter a peer's IP and port (default **47100**). Find your Tailscale IP with:

```bash
tailscale ip -4
```

---

## Agents

An agent is an AI assistant that appears in LanChat as an ordinary chat thread — its own section at the top of the sidebar, its own conversation, its own status. You can keep one to yourself, or share it with people on your network so they can ask it things without installing or configuring anything themselves.

### Adding one

**Settings → Agents → Add agent.** Give it a name and pick how LanChat should reach it:

| Transport | What it is | What it needs |
|---|---|---|
| **HTTP API** *(recommended)* | Talks to an agent server over HTTP. The default points at a Hermes server on this machine. | Base URL (default `http://127.0.0.1:8642`), optionally a model and a Hermes profile |
| **ACP** | Agent Client Protocol over stdio. Keeps conversation context across messages. | Command to run, arguments, working directory |
| **Local command** | Runs a CLI on this machine, once per message. | Command, arguments (use `{prompt}` where the message goes), working directory |
| **SSH command** | Runs the agent on another host over SSH. | Host, user, port, identity file, remote command. The host must already be in your `known_hosts` |

The on/off toggle is a full kill switch: it stops the transport but keeps the configuration, so you can turn an agent back on without re-entering a key. Removing an agent deletes the record outright.

### Keys stay on your machine

If the agent needs an API key you can either store it encrypted on this device — sealed with your OS keychain (Keychain, libsecret, or DPAPI), so only ciphertext is written to disk — or have LanChat read it from an environment variable, in which case only the variable *name* is stored and the key never touches disk at all. Either way the key is never sent to the app's UI layer, and never leaves your machine.

### Approvals

**Only HTTP and ACP can ask you to approve a tool call.** When the agent wants to run something, a prompt appears on *your* machine and waits for you.

Local command and SSH have no approval step — they run a non-interactive command and return its output — so only point them at something you are content to have run unattended.

This matters most when sharing. A peer using your agent never gets the approval prompt: it stays with you, the owner, on the machine the agent actually runs on. Sharing an agent means letting someone ask it things, not handing them the keys to your computer.

### Sharing it

A new agent is **local-only** until you say otherwise. Reach is granted per peer, and you can also:

- **Anyone on the network** — the broadest grant in the app, and the one thing here that asks for confirmation before it takes effect. Narrowing reach never asks.
- **Show in their contact list** — the agent appears in that peer's sidebar rather than having to be addressed deliberately.

Each peer's conversation with your agent lives in its own thread, so their questions never land in your ordinary chat with them. Agent threads are also purely local constructs: LanChat drops any message arriving off the network that claims to be from one, so a peer cannot impersonate your agent to you.

### Taking turns

When several people share one agent, they queue for it. Whoever holds the turn gets **5 queries**, then it passes to the next person waiting.

Ask while someone else is holding the turn and your question is **kept**, not refused — it is read the moment your turn arrives, and it does not spend one of your five. The right-hand panel shows where you stand: whether you are waiting, about to receive the turn, holding it, or about to hand it on.

### Watching it work

The right panel has no latency to chart for an agent, so it uses that space to say what the agent is *doing* — and it animates while it does. See **Living agent status** in [Features](#features).

---

## How it works

```
      Discovery                     Transport (all direct, peer-to-peer)
 ┌──────────────────┐        ┌─────────────────────────────────────────────┐
 │ tailscale status │──┐     │  WebSocket  → chat + WebRTC call signaling   │
 │  (tailnet peers) │  ├──►  │  HTTP       → file / photo / video streaming │
 │ UDP broadcast    │──┘     │  WebRTC     → voice & video media (P2P)      │
 │  (same subnet)   │        └─────────────────────────────────────────────┘
 └──────────────────┘
```

Each node runs a small local server (HTTP + WebSocket) on port **47100**. Discovery finds peers and probes `GET /lanchat/whoami`; a persistent WebSocket carries chat and call signaling; files stream over HTTP; and WebRTC media flows directly between the two devices.

### Ports & firewall

| Port | Protocol | Purpose |
|------|----------|---------|
| `47100` | TCP (HTTP + WS) | Chat, signaling, file transfer, discovery handshake |
| `47101` | UDP | LAN discovery beacon (same subnet only) |

- **Tailscale** traffic is already permitted by your tailnet — no firewall changes needed.
- On a **plain LAN**, allow LanChat through the OS firewall when prompted so peers can reach port `47100`.

---

## Development

```
src/
  main/       Electron main process (Node)
    server.js       HTTP + WebSocket server (whoami, files, signaling)
    discovery.js    Tailscale poll + probe, UDP LAN beacon, manual peers
    peers.js        Peer connection registry + message routing
    fileTransfer.js Streamed file upload
    ipc.js          Bridge to the renderer
  preload/    contextBridge → window.lanchat
  renderer/   React UI (WebRTC lives here)
```

Run the test suite (networking + discovery, no GUI needed):

```bash
npm test
```

### Testing two instances on one machine

```bash
# terminal 1
LANCHAT_USERDATA=/tmp/lc-a LANCHAT_PORT=47100 npm run dev
# terminal 2
LANCHAT_USERDATA=/tmp/lc-b LANCHAT_PORT=47200 npm run dev
```

Then add the other by IP (`127.0.0.1:47200`) via the **+** button.

---

## License

MIT © dlroqa
