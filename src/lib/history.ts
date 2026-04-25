import type { ClipboardEntry } from "./types.ts";

const MAX_ENTRIES_PER_ROOM = 100;
const DEFAULT_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const MIN_EXPIRY_MS = 60 * 1000; // 1 minute
const MAX_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

export class ClipboardHistory {
  private history = new Map<string, ClipboardEntry[]>();
  private roomExpiry = new Map<string, number>();

  setExpiry(roomId: string, ms: number): void {
    this.roomExpiry.set(roomId, Math.max(MIN_EXPIRY_MS, Math.min(MAX_EXPIRY_MS, ms)));
  }

  getExpiry(roomId: string): number {
    return this.roomExpiry.get(roomId) ?? DEFAULT_EXPIRY_MS;
  }

  addEntry(roomId: string, entry: ClipboardEntry): void {
    let entries = this.history.get(roomId);
    if (!entries) {
      entries = [];
      this.history.set(roomId, entries);
    }
    entries.push(entry);
    if (entries.length > MAX_ENTRIES_PER_ROOM) {
      entries.shift();
    }
  }

  getHistory(roomId: string): ClipboardEntry[] {
    const entries = this.history.get(roomId) ?? [];
    const now = Date.now();
    const expiry = this.getExpiry(roomId);
    return entries.filter((e) => now - e.timestamp <= expiry);
  }

  /** Remove expired entries for a room. Returns number of entries removed. */
  cleanup(roomId: string): number {
    const entries = this.history.get(roomId);
    if (!entries) return 0;
    const now = Date.now();
    const expiry = this.getExpiry(roomId);
    const before = entries.length;
    const valid = entries.filter((e) => now - e.timestamp <= expiry);
    if (valid.length === 0) {
      this.history.delete(roomId);
    } else {
      this.history.set(roomId, valid);
    }
    return before - valid.length;
  }

  getRoomIds(): string[] {
    return Array.from(this.history.keys());
  }

  clearRoom(roomId: string): void {
    this.history.delete(roomId);
  }
}
