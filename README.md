<p align="center">
  <img src="logo/tonglen-clipboard-banner.svg" alt="Tonglen Clipboard" height="120" />
</p>

<p align="center">
  Share clipboard text and files across devices on your local network — real-time, room-based, zero setup. Built with **Bun**, **TypeScript**, and **TailwindCSS**.
</p>

## Features

### One Feed for Text & Files
- **Unified timeline** — Text snippets and files share a single chat-style feed, ordered by time; no tabs to switch
- **One composer** — Type, paste, attach, or drop files in the same place; `Enter` sends, `Shift+Enter` adds a newline
- **Drop anywhere** — Drag files onto any part of the room view
- **Paste anything** — Pasting text shares it (with auto-share on); pasting images or files uploads them
- **Image previews** — PNG, JPEG, GIF, and WebP files show an inline thumbnail
- **Upload queue** — Up to 3 files upload at once; the rest wait their turn, and rate-limited uploads retry automatically
- **Per-file upload progress** — Each upload gets its own progress card with a cancel button
- **Large text fallback** — Text over ~900 KB is shared as a `.txt` file automatically
- **Auto-copy** — Incoming text is copied to your clipboard where the browser allows it
- **History** — Up to 100 text entries and 50 files per room, with sender and timestamp

### Files & Limits
- **Up to 10 GB per file** — Room owner can set max upload size (1 MB – 10 GB) and auto-cleanup duration (1 min – 24 hours)
- **50 GB server cap** — Global storage limit with per-room cap of 50 files

### Rooms & Peers
- **Room-based system** — Create or join rooms with a code; no account needed
- **Room ownership** — Owner controls settings; ownership auto-transfers when owner leaves
- **QR code sharing** — Scan to join from any device on the network
- **Copy link** — One-click shareable URL with `?room=CODE`
- **Peer list** — See who's connected with owner indicator

### Network
- **LAN auto-discovery** — UDP broadcast beacon finds other instances on the same network
- **Auto-reconnect** — Exponential backoff reconnection (max 30s)
- **Rate limiting** — Per-client limits (uploads: 60/min, WebSocket: 60 msg/min); 429 responses include `Retry-After`
- **Reverse-proxy aware** — With `TRUST_PROXY=1`, client IPs come from `X-Forwarded-For`; otherwise forwarded headers are ignored
- **Origin check** — WebSocket connections from other websites are refused
- **Upload tokens** — Only peers connected to a room can upload to it
- **Memory caps** — Clipboard text is capped at 10 MB per room and 100 MB server-wide; the oldest entries are evicted first
- **CORS** — Locked to local server origins

### UI
- **Responsive design** — Desktop sidebar + mobile drawer for peers and QR code
- **Dark theme** — TailwindCSS dark theme with amber accents
- **Single feed** — Text and files in one chat-style timeline
- **Toast notifications** — Auto-dismissing error, success, and info messages

### Ephemeral by Design
- **No database** — All data lives in memory and temp files
- **Auto-cleanup** — Expired clipboard entries and files are purged every 60 seconds (default expiry: 5 minutes)
- **Clean start** — Temp files are wiped on server restart

## Quick Start

```bash
# Install dependencies
bun install

# Start dev server with watch mode
bun run dev
```

Open **http://localhost:7582** in your browser. Open the same URL on other devices on your network (use the displayed Network IP or scan the QR code).

## Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Start server with watch mode |
| `bun run start` | Start production server |
| `bun run build` | Compile to standalone binary (`./bin/app`) |

## Architecture

```
Client (Browser)  ←→  Bun Server (WebSocket + HTTP)  ←→  Client (Browser)
                          ↕
                    UDP Discovery Beacon
```

| Port | Purpose |
|------|---------|
| `7582` | HTTP + WebSocket server |
| `7583` | UDP broadcast for LAN discovery |

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/info` | GET | Server stats (rooms, peers, port) |
| `/api/upload/:roomId` | POST | Upload file to a room (requires the `X-Upload-Token` sent to your socket on join) |
| `/api/download/:fileId` | GET | Download a file (`?inline=1` previews PNG/JPEG/GIF/WebP) |
| `/api/qr?text=` | GET | Generate QR code (SVG) |

## Configuration

Set via environment variables (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `7582` | HTTP + WebSocket port |
| `DISCOVERY_PORT` | `7583` | UDP port for LAN discovery |
| `TRUST_PROXY` | off | Set to `1` when running behind a reverse proxy, so rate limits use the client address from `X-Forwarded-For` (rightmost entry) and the origin check accepts `X-Forwarded-Host`. Leave off when clients connect directly — otherwise they can spoof their IP. |
| `ALLOWED_ORIGINS` | — | Extra comma-separated origins allowed to open WebSocket connections, e.g. `https://clip.example.com`. Only needed if your proxy rewrites `Host` without setting `X-Forwarded-Host`. |

## Deployment

Includes a production config for **PM2**, which sets `TRUST_PROXY=1` for running behind a reverse proxy such as Nginx.

Your proxy should pass the client address and host through, and allow WebSocket upgrades and large bodies:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
client_max_body_size 10G;
```

If a CDN sits in front of the proxy, configure the proxy's `real_ip` module so the rightmost `X-Forwarded-For` entry is the real client.

```bash
# Build standalone binary
bun run build

# Run with PM2
pm2 start pm2.config.cjs
```

## Tech Stack

- [Bun](https://bun.sh) — Runtime, bundler, and compiler
- [TypeScript](https://www.typescriptlang.org/) — Full type safety
- [TailwindCSS v4](https://tailwindcss.com/) — Utility-first styling
- [qrcode](https://www.npmjs.com/package/qrcode) — QR code generation
- [Lucide](https://lucide.dev/) — Icon set

## License

[MIT](LICENSE)
