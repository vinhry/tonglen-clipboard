import type { WsData } from "./lib/types.ts";
import { RoomManager } from "./lib/room.ts";
import { ClipboardHistory } from "./lib/history.ts";
import { FileStore } from "./lib/file-store.ts";
import { createWebSocketHandlers } from "./server/websocket.ts";
import { createRouter } from "./server/router.ts";
import { startDiscovery, getLocalIP } from "./server/discovery.ts";
import homepage from "./public/index.html";
import manifest from "./public/manifest.json";

const PORT = Number(process.env.PORT) || 7582;

// ── Shared state ─────────────────────────────────────────────
const rooms = new RoomManager();
const history = new ClipboardHistory();
const files = new FileStore();

// ── Handlers ─────────────────────────────────────────────────
const wsHandlers = createWebSocketHandlers(rooms, history, files);
const handleApiRequest = createRouter(rooms, files);

// ── Bun server ───────────────────────────────────────────────
const server = Bun.serve<WsData>({
  port: PORT,
  hostname: "0.0.0.0",
  maxRequestBodySize: 10 * 1024 * 1024 * 1024, // 10GB – matches MAX_FILE_SIZE
  development: process.env.NODE_ENV !== "production",

  routes: {
    "/": homepage,
  },

  async fetch(req, server) {
    const url = new URL(req.url);

    // Serve favicon
    if (url.pathname === "/favicon.svg") {
      return new Response(Bun.file(import.meta.dir + "/../logo/tonglen-clipboard-mark.svg"), {
        headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
      });
    }

    // Serve apple-touch-icon for iOS Add to Home Screen
    if (url.pathname === "/apple-touch-icon.png") {
      return new Response(Bun.file(import.meta.dir + "/../logo/apple-touch-icon-180x180.png"), {
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
      });
    }

    // Serve web app manifest
    if (url.pathname === "/manifest.json") {
      return new Response(JSON.stringify(manifest), {
        headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=86400" },
      });
    }

    // Upgrade WebSocket requests
    if (url.pathname === "/ws") {
      const peerId = crypto.randomUUID();
      const upgraded = server.upgrade(req, {
        data: { peerId, peerName: "", roomId: "", msgCount: 0, msgWindowStart: Date.now() } satisfies WsData,
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    // API routes
    if (url.pathname.startsWith("/api/")) {
      const response = await handleApiRequest(req);
      if (response) return response;
    }

    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    open: wsHandlers.open,
    message: wsHandlers.message,
    close: wsHandlers.close,
    maxPayloadLength: 16 * 1024, // 16KB for text-only WS messages
    idleTimeout: 120,
  },
});

// ── Periodic cleanup ─────────────────────────────────────────
const previousFileCounts = new Map<string, number>();

setInterval(() => {
  const roomIds = rooms.getRoomIds();
  for (const roomId of roomIds) {
    const clipRemoved = history.cleanup(roomId);
    const currentFiles = files.getFilesForRoom(roomId);
    const prevFileCount = previousFileCounts.get(roomId) ?? currentFiles.length;
    const filesRemoved = prevFileCount - currentFiles.length;
    previousFileCounts.set(roomId, currentFiles.length);

    // Broadcast updated state only if anything was cleaned
    if (clipRemoved > 0 || filesRemoved > 0) {
      rooms.broadcastToRoom(roomId, {
        type: "cleanup",
        clipboardEntries: history.getHistory(roomId),
        files: currentFiles.map((f) => ({
          fileId: f.id,
          fileName: f.name,
          fileSize: f.size,
          from: f.uploadedBy,
        })),
      });
    }
  }
}, 60_000);

// ── LAN Discovery ────────────────────────────────────────────
startDiscovery(PORT);

const localIP = getLocalIP();
const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - s.length));
console.log(`
  ╔════════════════════════════════════════════════╗
  ║  Tonglen Clipboard                             ║
  ╠════════════════════════════════════════════════╣
  ║  Local:   ${pad(`http://localhost:${PORT}`, 36)}║
  ║  Network: ${pad(`http://${localIP}:${PORT}`, 36)}║
  ╚════════════════════════════════════════════════╝
`);
