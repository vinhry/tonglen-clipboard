<p align="center">
  <img src="logo/tonglen-clipboard-banner.svg" alt="Tonglen Clipboard" height="120" />
</p>

<p align="center">
  Share clipboard text and files across devices on your local network — real-time, room-based, zero setup. Built with **Bun**, **TypeScript**, and **TailwindCSS**.

## Features

### Clipboard Sharing
- **Real-time sync** — WebSocket-based instant clipboard sharing across all connected peers
- **Auto-share on paste** — Toggle auto-detection of clipboard paste events; text is shared automatically
- **Clipboard history** — Up to 100 entries per room with sender name and timestamp
- **Auto-copy** — Incoming text is automatically copied to your clipboard

### File Sharing
- **Drag & drop upload** — Drop files or browse to upload, up to 10 GB per file
- **Configurable limits** — Room owner can set max upload size (1 MB – 10 GB) and auto-cleanup duration (1 min – 24 hours)
- **Upload progress** — Real-time progress bar with percentage
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
- **Rate limiting** — Built-in per-IP rate limits (uploads: 10/min, WebSocket: 60 msg/min)
- **CORS** — Locked to local server origins

### UI
- **Responsive design** — Desktop sidebar + mobile drawer for peers and QR code
- **Dark theme** — TailwindCSS dark theme with amber accents
- **Tabbed interface** — Clipboard and Files tabs
- **Toast notifications** — Auto-dismissing error alerts

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
| `/api/upload/:roomId` | POST | Upload file to a room |
| `/api/download/:fileId` | GET | Download a file |
| `/api/qr?url=` | GET | Generate QR code (SVG) |

## Deployment

Includes production configs for **PM2** and **Nginx** (with WebSocket proxy, SSL, and 10 GB upload support).

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
