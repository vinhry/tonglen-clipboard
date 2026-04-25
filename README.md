# Tonglen Clipboard

Share clipboard text and files across devices on your local network. Modern rebuild of [share-clipboard](https://github.com/coralw/share-clipboard) using **Bun**, **TypeScript**, and **TailwindCSS**.

## Features

- **Real-time clipboard sharing** — WebSocket-based, instant sync across all connected peers
- **Room-based system** — Create or join rooms with a code; share the room via QR code
- **File sharing** — Drag & drop files up to 50MB, auto-expires after 1 hour
- **Watch clipboard** — Auto-detect clipboard changes and share them (like the original's polling)
- **Clipboard history** — See all shared text entries with timestamps and sender names
- **LAN auto-discovery** — UDP broadcast beacon to find peers on the same network
- **QR code** — Scan to join from any device on the network
- **Responsive UI** — Works on desktop and mobile with TailwindCSS dark theme

## Quick Start

```bash
# Install dependencies
bun install

# Build TailwindCSS + start server
bun run dev
```

Open **http://localhost:7582** in your browser. Open the same URL on other devices on your network (use the displayed Network IP or scan the QR code).

## Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Build CSS + start server with watch mode |
| `bun run start` | Start production server |
| `bun run build` | Build TailwindCSS only |
| `bun run build:css` | Build TailwindCSS only |

## Architecture

```
Client (Browser)  ←→  Bun Server (WebSocket + HTTP)  ←→  Client (Browser)
                          ↕
                    UDP Discovery Beacon
```

- **Port 7582** — HTTP + WebSocket server (same as original)
- **Port 7583** — UDP broadcast for LAN discovery
- **In-memory storage** — No database; clipboard history and files are ephemeral

## Tech Stack

- [Bun](https://bun.sh) — Runtime, bundler, and server
- [TypeScript](https://www.typescriptlang.org/) — Full type safety
- [TailwindCSS v4](https://tailwindcss.com/) — Utility-first styling
- [qrcode](https://www.npmjs.com/package/qrcode) — QR code generation

## License

MIT
