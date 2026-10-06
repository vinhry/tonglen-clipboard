import { toFileInfo, type FileStore } from "../lib/file-store.ts";
import type { RoomManager } from "../lib/room.ts";
import type { FileEntry } from "../lib/types.ts";
import { getLocalIP } from "./discovery.ts";

const PORT = Number(process.env.PORT) || 7582;

// Image types safe to render inline for previews (no SVG — it can carry script)
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ── Simple in-memory rate limiter ────────────────────────────
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMITS: Record<string, { max: number; windowMs: number }> = {
  upload: { max: 10, windowMs: 60_000 },
  info: { max: 30, windowMs: 60_000 },
  default: { max: 60, windowMs: 60_000 },
};

function isRateLimited(ip: string, bucket: string): boolean {
  const key = `${ip}:${bucket}`;
  const limit = RATE_LIMITS[bucket] ?? RATE_LIMITS.default!;
  const now = Date.now();
  let timestamps = rateLimitMap.get(key);
  if (!timestamps) {
    timestamps = [];
    rateLimitMap.set(key, timestamps);
  }
  // Prune old entries
  const cutoff = now - limit!.windowMs;
  while (timestamps.length > 0 && timestamps[0]! < cutoff) timestamps.shift();
  if (timestamps.length >= limit!.max) return true;
  timestamps.push(now);
  return false;
}

// Periodically clean stale rate-limit entries
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of rateLimitMap) {
    const cutoff = now - 120_000;
    while (timestamps.length > 0 && timestamps[0]! < cutoff) timestamps.shift();
    if (timestamps.length === 0) rateLimitMap.delete(key);
  }
}, 60_000);

function getClientIP(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const localIP = getLocalIP();
  const allowedOrigins = new Set([
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    `http://${localIP}:${PORT}`,
  ]);

  if (!allowedOrigins.has(origin)) {
    return {};
  }

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "3600",
  };
}

export function createRouter(rooms: RoomManager, files: FileStore) {
  return async function handleRequest(req: Request): Promise<Response | undefined> {
    const url = new URL(req.url);
    const { pathname } = url;
    const cors = corsHeaders(req);

    // ── CORS preflight ─────────────────────────────────────
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // ── API: Server info ───────────────────────────────────
    if (pathname === "/api/info") {
      const ip = getClientIP(req);
      if (isRateLimited(ip, "info")) {
        return new Response("Too many requests", { status: 429, headers: cors });
      }

      return Response.json(
        {
          port: PORT,
          rooms: rooms.getRoomCount(),
          peers: rooms.getTotalPeerCount(),
        },
        { headers: cors },
      );
    }

    // ── API: File upload ───────────────────────────────────
    if (pathname.startsWith("/api/upload/") && req.method === "POST") {
      const ip = getClientIP(req);
      if (isRateLimited(ip, "upload")) {
        return new Response("Too many uploads. Try again later.", { status: 429, headers: cors });
      }

      const roomId = decodeURIComponent(pathname.slice("/api/upload/".length));
      if (!roomId) return new Response("Room ID required", { status: 400, headers: cors });

      // Validate room exists
      if (!rooms.getRoom(roomId)) {
        return new Response("Room not found", { status: 404, headers: cors });
      }

      const fileName = req.headers.get("x-file-name");
      const fileMime = req.headers.get("x-file-mime") || "application/octet-stream";
      const uploader = safeDecode(req.headers.get("x-uploader") || "").trim().slice(0, 30) || "Anonymous";
      const uploaderId = (req.headers.get("x-peer-id") || "").slice(0, 64);
      const fileSize = Number(req.headers.get("content-length") || "0");

      if (!fileName || !fileSize || !req.body) {
        return new Response("Missing file name, size, or body", { status: 400, headers: cors });
      }

      try {
        const fileId = crypto.randomUUID();

        const entry: FileEntry = {
          id: fileId,
          name: safeDecode(fileName),
          size: fileSize,
          mime: fileMime,
          filePath: "",
          roomId,
          uploadedBy: uploader,
          uploaderId,
          uploadedAt: Date.now(),
        };

        const result = await files.store(entry, req.body);
        if (!result.ok) {
          return new Response(result.error, { status: 413, headers: cors });
        }

        return Response.json(toFileInfo(entry), { headers: cors });
      } catch {
        return new Response("Upload failed", { status: 500, headers: cors });
      }
    }

    // ── API: File download ─────────────────────────────────
    if (pathname.startsWith("/api/download/")) {
      const fileId = decodeURIComponent(pathname.slice("/api/download/".length));
      const entry = files.get(fileId);
      if (!entry) return new Response("File not found or expired", { status: 404, headers: cors });

      const inline = url.searchParams.has("inline") && INLINE_IMAGE_TYPES.has(entry.mime);
      const asciiName = entry.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
      return new Response(Bun.file(entry.filePath), {
        headers: {
          ...cors,
          "Content-Type": inline ? entry.mime : "application/octet-stream",
          "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
          "Content-Length": String(entry.size),
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      });
    }

    // ── API: QR code SVG ───────────────────────────────────
    if (pathname === "/api/qr") {
      const text = url.searchParams.get("text");
      if (!text) return new Response("Missing ?text=", { status: 400, headers: cors });
      const QRCode = await import("qrcode");
      const svg = await QRCode.toString(text, { type: "svg", margin: 1 });
      return new Response(svg, { headers: { ...cors, "Content-Type": "image/svg+xml" } });
    }

    return undefined;
  };
}
