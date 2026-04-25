import { mkdirSync, unlinkSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FileEntry } from "./types.ts";

const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024; // 10GB
const MIN_UPLOAD_SIZE = 1 * 1024 * 1024; // 1MB
const DEFAULT_MAX_UPLOAD_SIZE = 100 * 1024 * 1024; // 100MB
const MAX_TOTAL_STORAGE = 50 * 1024 * 1024 * 1024; // 50GB global cap
const MAX_FILES_PER_ROOM = 50;
const DEFAULT_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const MIN_EXPIRY_MS = 60 * 1000; // 1 minute
const MAX_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

const TEMP_DIR = resolve("temp");

export class FileStore {
  private files = new Map<string, FileEntry>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private roomExpiry = new Map<string, number>();
  private roomMaxUploadSize = new Map<string, number>();
  private currentTotalSize = 0;

  constructor() {
    // Ensure temp directory exists and clear stale files from previous runs
    mkdirSync(TEMP_DIR, { recursive: true });
    for (const name of readdirSync(TEMP_DIR)) {
      try { unlinkSync(join(TEMP_DIR, name)); } catch {}
    }
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
  }

  setExpiry(roomId: string, ms: number): void {
    this.roomExpiry.set(roomId, Math.max(MIN_EXPIRY_MS, Math.min(MAX_EXPIRY_MS, ms)));
  }

  getExpiry(roomId: string): number {
    return this.roomExpiry.get(roomId) ?? DEFAULT_EXPIRY_MS;
  }

  setMaxUploadSize(roomId: string, bytes: number): void {
    this.roomMaxUploadSize.set(roomId, Math.max(MIN_UPLOAD_SIZE, Math.min(MAX_FILE_SIZE, bytes)));
  }

  getMaxUploadSize(roomId: string): number {
    return this.roomMaxUploadSize.get(roomId) ?? DEFAULT_MAX_UPLOAD_SIZE;
  }

  private roomFileCount(roomId: string): number {
    let count = 0;
    for (const entry of this.files.values()) {
      if (entry.roomId === roomId) count++;
    }
    return count;
  }

  async store(entry: FileEntry, data: ReadableStream<Uint8Array>): Promise<{ ok: true } | { ok: false; error: string }> {
    const maxSize = this.getMaxUploadSize(entry.roomId);
    if (entry.size > maxSize) {
      return { ok: false, error: `File exceeds max size of ${maxSize / (1024 * 1024)}MB` };
    }
    if (this.currentTotalSize + entry.size > MAX_TOTAL_STORAGE) {
      return { ok: false, error: "Server storage limit reached. Try again later." };
    }
    if (this.roomFileCount(entry.roomId) >= MAX_FILES_PER_ROOM) {
      return { ok: false, error: `Room file limit of ${MAX_FILES_PER_ROOM} reached` };
    }
    const filePath = join(TEMP_DIR, entry.id);
    const writer = Bun.file(filePath).writer();
    for await (const chunk of data) {
      writer.write(chunk);
    }
    await writer.end();
    entry.filePath = filePath;
    this.files.set(entry.id, entry);
    this.currentTotalSize += entry.size;
    return { ok: true };
  }

  get(fileId: string): FileEntry | undefined {
    const entry = this.files.get(fileId);
    if (!entry) return undefined;
    const expiry = this.getExpiry(entry.roomId);
    if (Date.now() - entry.uploadedAt > expiry) {
      this.removeFile(entry.id, entry.size);
      return undefined;
    }
    return entry;
  }

  getFilesForRoom(roomId: string): Omit<FileEntry, "filePath">[] {
    const result: Omit<FileEntry, "filePath">[] = [];
    const expiry = this.getExpiry(roomId);
    for (const entry of this.files.values()) {
      if (entry.roomId === roomId && Date.now() - entry.uploadedAt <= expiry) {
        const { filePath: _, ...meta } = entry;
        result.push(meta);
      }
    }
    return result;
  }

  private removeFile(id: string, size: number): void {
    const entry = this.files.get(id);
    if (entry) {
      try { unlinkSync(entry.filePath); } catch {}
    }
    this.files.delete(id);
    this.currentTotalSize = Math.max(0, this.currentTotalSize - size);
  }

  cleanup(): void {
    const now = Date.now();
    for (const [id, entry] of this.files) {
      const expiry = this.getExpiry(entry.roomId);
      if (now - entry.uploadedAt > expiry) {
        this.removeFile(id, entry.size);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
  }
}
