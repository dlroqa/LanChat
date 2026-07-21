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
| 🎚️ **Source selection** | Choose your microphone and camera — in Settings, or switch live mid-call. |
| 📎 **File sharing** | Send any file, photo, or video — images & clips preview inline. Drag-and-drop supported. |
| 🪪 **Simple identity** | Pick a display name + color. No sign-up. |
| 🔔 **Status menu** | Lives in the macOS menu bar, Windows tray, and Ubuntu status area — who's online, unread badge, quick jump into a chat. |
| 🔒 **Addresses hidden** | IP addresses are hidden by default; peers are identified by name. |
| 🤝 **Shared tailnets** | Devices shared in from another tailnet are discovered and marked. |
| ⬆️ **Self-updating** | **Settings → Updates → Check for Updates** pulls the latest GitHub release and installs it. |

---

## Install

### Option A — download a build (easiest)

Grab the installer for your OS from the [Releases page](https://github.com/dlroqa/LanChat/releases):

- **macOS** — `LanChat-*.dmg`
- **Windows** — `LanChat-*.exe`
- **Linux** — `LanChat-*.AppImage` (or `.deb`)

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

Open **Settings → Updates → Check for Updates**. LanChat queries this repo's
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

### Talking to people on another tailnet (Tailscale device sharing)

You don't need to be on the same tailnet. Use [Tailscale device sharing](https://tailscale.com/kb/1084/sharing)
to share a machine with someone else's account — it then appears in their LanChat sidebar
automatically, marked **shared**.

1. In the [Tailscale admin console](https://login.tailscale.com/admin/machines), open the
   machine's **⋯** menu → **Share…**, and send the invite link.
2. Once they accept, the machine shows up in their tailnet with a `100.x` address, and LanChat
   discovers it like any other peer.

> **What works, and what doesn't.** Tailscale **quarantines shared devices by default**: a shared
> machine can *answer* connections from the tailnet it was shared into, but cannot *start* them.
> In practice:
>
> | | Shared device → you | You → shared device |
> |---|---|---|
> | Discovery & presence | — | ✅ works |
> | Text chat | ✅ works (replies ride the connection you opened) | ✅ works |
> | Sending files | ⚠️ blocked by quarantine | ✅ works |
> | Voice / video calls | ⚠️ unreliable — ICE needs both sides to connect | ⚠️ same |
>
> So **start the conversation from the non-shared side**. For full two-way use — file sending in
> both directions and dependable calls — the device owner should disable quarantine for that share
> in the admin console, or simply add both people to the same tailnet as users.
>
> Also note MagicDNS short names don't resolve for shared machines; LanChat sidesteps this by
> connecting over the `100.x` address directly.

### Connecting manually

If discovery is blocked, use the **+** button in the sidebar and enter a peer's IP and port (default **47100**). Find your Tailscale IP with:

```bash
tailscale ip -4
```

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
