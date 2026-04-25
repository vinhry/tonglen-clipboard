import type { ServerWebSocket } from "bun";

// ── Peer & Room ──────────────────────────────────────────────

export interface Peer {
  id: string;
  name: string;
  ws: ServerWebSocket<WsData>;
  roomId: string;
}

export interface Room {
  id: string;
  peers: Map<string, Peer>;
  createdAt: number;
  ownerId: string;
}

export interface WsData {
  peerId: string;
  peerName: string;
  roomId: string;
  msgCount: number;
  msgWindowStart: number;
}

// ── Clipboard ────────────────────────────────────────────────

export interface ClipboardEntry {
  text: string;
  from: string;
  fromId: string;
  timestamp: number;
}

// ── File ─────────────────────────────────────────────────────

export interface FileEntry {
  id: string;
  name: string;
  size: number;
  mime: string;
  filePath: string;
  roomId: string;
  uploadedBy: string;
  uploadedAt: number;
}

// ── WebSocket Messages: Client → Server ──────────────────────

export interface JoinMessage {
  type: "join";
  room: string;
  name: string;
}

export interface ClipboardMessage {
  type: "clipboard";
  text: string;
}

export interface FileNotifyMessage {
  type: "file-notify";
  fileId: string;
  fileName: string;
  fileSize: number;
}

export interface SettingsMessage {
  type: "settings";
  fileExpiryMinutes?: number;
  maxUploadSizeMB?: number;
}

export type ClientMessage = JoinMessage | ClipboardMessage | FileNotifyMessage | SettingsMessage;

// ── WebSocket Messages: Server → Client ──────────────────────

export interface PeersMessage {
  type: "peers";
  peers: { id: string; name: string; isOwner: boolean }[];
}

export interface ClipboardBroadcast {
  type: "clipboard";
  text: string;
  from: string;
  fromId: string;
  timestamp: number;
}

export interface HistoryMessage {
  type: "history";
  entries: ClipboardEntry[];
}

export interface FileBroadcast {
  type: "file-notify";
  fileId: string;
  fileName: string;
  fileSize: number;
  from: string;
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

export interface JoinedMessage {
  type: "joined";
  room: string;
  peerId: string;
  fileExpiryMinutes: number;
  maxUploadSizeMB: number;
  isOwner: boolean;
}

export interface SettingsBroadcast {
  type: "settings";
  fileExpiryMinutes?: number;
  maxUploadSizeMB?: number;
  changedBy: string;
}

export interface OwnerMessage {
  type: "owner";
  isOwner: boolean;
}

export interface CleanupBroadcast {
  type: "cleanup";
  clipboardEntries: ClipboardEntry[];
  files: { fileId: string; fileName: string; fileSize: number; from: string }[];
}

export type ServerMessage =
  | PeersMessage
  | ClipboardBroadcast
  | HistoryMessage
  | FileBroadcast
  | ErrorMessage
  | JoinedMessage
  | SettingsBroadcast
  | CleanupBroadcast
  | OwnerMessage;
