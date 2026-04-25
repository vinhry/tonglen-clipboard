import type { ServerWebSocket } from "bun";
import type { ClientMessage, WsData } from "../lib/types.ts";
import type { RoomManager } from "../lib/room.ts";
import type { ClipboardHistory } from "../lib/history.ts";
import type { FileStore } from "../lib/file-store.ts";

const WS_RATE_LIMIT = 60; // max messages per window
const WS_RATE_WINDOW_MS = 60_000; // 1 minute window

function checkRateLimit(ws: ServerWebSocket<WsData>): boolean {
  const now = Date.now();
  if (now - ws.data.msgWindowStart > WS_RATE_WINDOW_MS) {
    ws.data.msgCount = 1;
    ws.data.msgWindowStart = now;
    return true;
  }
  ws.data.msgCount++;
  if (ws.data.msgCount > WS_RATE_LIMIT) {
    ws.send(JSON.stringify({ type: "error", message: "Rate limit exceeded. Slow down." }));
    return false;
  }
  return true;
}

function validateMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== "object" || raw === null || !("type" in raw)) return null;
  const msg = raw as Record<string, unknown>;

  switch (msg.type) {
    case "join":
      if (typeof msg.room !== "string" || typeof msg.name !== "string") return null;
      return msg as unknown as ClientMessage;
    case "clipboard":
      if (typeof msg.text !== "string") return null;
      return msg as unknown as ClientMessage;
    case "file-notify":
      if (typeof msg.fileId !== "string" || typeof msg.fileName !== "string" || typeof msg.fileSize !== "number") return null;
      return msg as unknown as ClientMessage;
    case "settings": {
      // At least one setting field must be present
      const hasExpiry = typeof msg.fileExpiryMinutes === "number";
      const hasMaxUpload = typeof msg.maxUploadSizeMB === "number";
      if (!hasExpiry && !hasMaxUpload) return null;
      if (msg.fileExpiryMinutes !== undefined && typeof msg.fileExpiryMinutes !== "number") return null;
      if (msg.maxUploadSizeMB !== undefined && typeof msg.maxUploadSizeMB !== "number") return null;
      return msg as unknown as ClientMessage;
    }
    default:
      return null;
  }
}

export function createWebSocketHandlers(
  rooms: RoomManager,
  history: ClipboardHistory,
  files: FileStore,
) {
  return {
    open(ws: ServerWebSocket<WsData>) {
      // Nothing until they send a "join" message
    },

    message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
      if (!checkRateLimit(ws)) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }

      const msg = validateMessage(parsed);
      if (!msg) {
        ws.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
        return;
      }

      switch (msg.type) {
        case "join":
          handleJoin(ws, msg.room, msg.name, rooms, history, files);
          break;
        case "clipboard":
          handleClipboard(ws, msg.text, rooms, history);
          break;
        case "file-notify":
          handleFileNotify(ws, msg.fileId, msg.fileName, msg.fileSize, rooms, files);
          break;
        case "settings":
          handleSettings(ws, msg.fileExpiryMinutes, msg.maxUploadSizeMB, rooms, files, history);
          break;
      }
    },

    close(ws: ServerWebSocket<WsData>) {
      const { peerId, roomId } = ws.data;
      if (!roomId) return;

      const wasOwner = rooms.isOwner(roomId, peerId);
      rooms.leaveRoom(peerId, roomId);

      const peers = rooms.getRoomPeers(roomId);
      rooms.broadcastToRoom(roomId, { type: "peers", peers });

      // Notify new owner if ownership was transferred
      if (wasOwner && peers.length > 0) {
        const newOwnerId = rooms.getOwnerId(roomId);
        if (newOwnerId) {
          rooms.sendToPeer(roomId, newOwnerId, { type: "owner", isOwner: true });
        }
      }
    },
  };
}

function handleJoin(
  ws: ServerWebSocket<WsData>,
  roomId: string,
  name: string,
  rooms: RoomManager,
  clipHistory: ClipboardHistory,
  fileStore: FileStore,
) {
  const sanitizedRoom = roomId.trim().slice(0, 50);
  const sanitizedName = name.trim().slice(0, 30) || "Anonymous";

  if (!sanitizedRoom) {
    ws.send(JSON.stringify({ type: "error", message: "Room ID is required" }));
    return;
  }

  // If already in a room, leave it first
  if (ws.data.roomId) {
    const wasOwner = rooms.isOwner(ws.data.roomId, ws.data.peerId);
    rooms.leaveRoom(ws.data.peerId, ws.data.roomId);
    const oldPeers = rooms.getRoomPeers(ws.data.roomId);
    rooms.broadcastToRoom(ws.data.roomId, { type: "peers", peers: oldPeers });

    if (wasOwner && oldPeers.length > 0) {
      const newOwnerId = rooms.getOwnerId(ws.data.roomId);
      if (newOwnerId) {
        rooms.sendToPeer(ws.data.roomId, newOwnerId, { type: "owner", isOwner: true });
      }
    }
  }

  ws.data.roomId = sanitizedRoom;
  ws.data.peerName = sanitizedName;

  rooms.joinRoom(sanitizedRoom, ws.data.peerId, sanitizedName, ws);

  // Send joined confirmation
  ws.send(JSON.stringify({
    type: "joined",
    room: sanitizedRoom,
    peerId: ws.data.peerId,
    fileExpiryMinutes: Math.round(fileStore.getExpiry(sanitizedRoom) / 60_000),
    maxUploadSizeMB: Math.round(fileStore.getMaxUploadSize(sanitizedRoom) / (1024 * 1024)),
    isOwner: rooms.isOwner(sanitizedRoom, ws.data.peerId),
  }));

  // Send clipboard history
  ws.send(JSON.stringify({ type: "history", entries: clipHistory.getHistory(sanitizedRoom) }));

  // Send file list
  const roomFiles = fileStore.getFilesForRoom(sanitizedRoom);
  for (const f of roomFiles) {
    ws.send(
      JSON.stringify({
        type: "file-notify",
        fileId: f.id,
        fileName: f.name,
        fileSize: f.size,
        from: f.uploadedBy,
      }),
    );
  }

  // Broadcast updated peer list to everyone in the room
  rooms.broadcastToRoom(sanitizedRoom, {
    type: "peers",
    peers: rooms.getRoomPeers(sanitizedRoom),
  });
}

function handleClipboard(
  ws: ServerWebSocket<WsData>,
  text: string,
  rooms: RoomManager,
  clipHistory: ClipboardHistory,
) {
  const { peerId, peerName, roomId } = ws.data;
  if (!roomId) {
    ws.send(JSON.stringify({ type: "error", message: "Not in a room" }));
    return;
  }

  const trimmed = text.slice(0, 1_000_000); // 1MB text limit
  if (!trimmed) return;

  const entry = {
    text: trimmed,
    from: peerName,
    fromId: peerId,
    timestamp: Date.now(),
  };

  clipHistory.addEntry(roomId, entry);

  rooms.broadcastToRoom(roomId, { type: "clipboard", ...entry }, peerId);
}

function handleFileNotify(
  ws: ServerWebSocket<WsData>,
  fileId: string,
  fileName: string,
  fileSize: number,
  rooms: RoomManager,
  fileStore: FileStore,
) {
  const { peerName, roomId, peerId } = ws.data;
  if (!roomId) {
    ws.send(JSON.stringify({ type: "error", message: "Not in a room" }));
    return;
  }

  // Verify file actually exists in the store
  const file = fileStore.get(fileId);
  if (!file) {
    ws.send(JSON.stringify({ type: "error", message: "File not found" }));
    return;
  }

  rooms.broadcastToRoom(
    roomId,
    {
      type: "file-notify",
      fileId,
      fileName: file.name,
      fileSize: file.size,
      from: peerName,
    },
    peerId,
  );
}

function handleSettings(
  ws: ServerWebSocket<WsData>,
  fileExpiryMinutes: number | undefined,
  maxUploadSizeMB: number | undefined,
  rooms: RoomManager,
  files: FileStore,
  history: ClipboardHistory,
) {
  const { peerName, roomId } = ws.data;
  if (!roomId) {
    ws.send(JSON.stringify({ type: "error", message: "Not in a room" }));
    return;
  }

  // Only room owner can change settings
  if (!rooms.isOwner(roomId, ws.data.peerId)) {
    ws.send(JSON.stringify({ type: "error", message: "Only the room owner can change settings" }));
    return;
  }

  const broadcast: {
    type: "settings";
    changedBy: string;
    fileExpiryMinutes?: number;
    maxUploadSizeMB?: number;
  } = { type: "settings", changedBy: peerName };

  if (fileExpiryMinutes !== undefined) {
    const minutes = Math.max(1, Math.min(1440, Math.round(fileExpiryMinutes)));
    const ms = minutes * 60_000;
    files.setExpiry(roomId, ms);
    history.setExpiry(roomId, ms);
    broadcast.fileExpiryMinutes = minutes;
  }

  if (maxUploadSizeMB !== undefined) {
    const mb = Math.max(1, Math.min(10240, Math.round(maxUploadSizeMB)));
    files.setMaxUploadSize(roomId, mb * 1024 * 1024);
    broadcast.maxUploadSizeMB = mb;
  }

  rooms.broadcastToRoom(roomId, broadcast as any);
}
