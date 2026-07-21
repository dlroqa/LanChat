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
| 📞 **Voice calls** | Crisp P2P audio over LAN/tailnet. |
| 🎥 **Video calls** | Camera calls with mute / camera toggle and picture-in-picture. |
| 📎 **File sharing** | Send any file, photo, or video — images & clips preview inline. Drag-and-drop supported. |
| 🪪 **Simple identity** | Pick a display name + color. No sign-up. |

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
>   If macOS instead claims the app **"is damaged and can't be opened"**, that means the
>   download quarantine flag is set — clear it and re-sign locally:
>   ```bash
>   xattr -dr com.apple.quarantine /Applications/LanChat.app
>   codesign --force --deep --sign - /Applications/LanChat.app
>   ```
>   ("Damaged" is macOS's misleading wording for *unsigned*, not corrupt.)
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

## Setup (2 minutes)

1. **Install Tailscale** on each device and sign in to the same tailnet — <https://tailscale.com/download>. (Skip this if you only use LanChat on one local network.)
2. **Open LanChat** and pick a display name + color.
3. Other people on your tailnet/LAN who are running LanChat **appear automatically** in the left sidebar. Click one and start chatting, calling, or sending files.

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
