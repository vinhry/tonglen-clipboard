import type { ClipboardEntry } from "./types.ts";

const MAX_ENTRIES_PER_ROOM = 100;
const MAX_BYTES_PER_ROOM = 10 * 1024 * 1024; // 10MB of text per room
const MAX_TOTAL_BYTES = 100 * 1024 * 1024; // 100MB across all rooms (pm2 restarts at 512MB)
const DEFAULT_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const MIN_EXPIRY_MS = 60 * 1000; // 1 minute
const MAX_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

const entryBytes = (e: ClipboardEntry) => Buffer.byteLength(e.text);

export class ClipboardHistory {
  private history = new Map<string, ClipboardEntry[]>();
  private roomExpiry = new Map<string, number>();
  private roomBytes = new Map<string, number>();
  private totalBytes = 0;

  setExpiry(roomId: string, ms: number): void {
    this.roomExpiry.set(roomId, Math.max(MIN_EXPIRY_MS, Math.min(MAX_EXPIRY_MS, ms)));
  }

  getExpiry(roomId: string): number {
    return this.roomExpiry.get(roomId) ?? DEFAULT_EXPIRY_MS;
  }

  /**
   * Add an entry, evicting the oldest entries to stay within the per-room and
   * global caps. Returns the ids of rooms that lost older entries.
   */
  addEntry(roomId: string, entry: ClipboardEntry): Set<string> {
    let entries = this.history.get(roomId);
    if (!entries) {
      entries = [];
      this.history.set(roomId, entries);
    }
    entries.push(entry);
    this.adjustBytes(roomId, entryBytes(entry));

    const evicted = new Set<string>();
    // Never evict the entry just added; a single entry is bounded by the WS payload limit
    while (
      entries.length > 1 &&
      (entries.length > MAX_ENTRIES_PER_ROOM || (this.roomBytes.get(roomId) ?? 0) > MAX_BYTES_PER_ROOM)
    ) {
      this.shiftOldest(roomId);
      evicted.add(roomId);
    }
    while (this.totalBytes > MAX_TOTAL_BYTES) {
      const oldestRoom = this.findOldestRoom(entry);
      if (!oldestRoom) break;
      this.shiftOldest(oldestRoom);
      evicted.add(oldestRoom);
    }
    return evicted;
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
      this.clearRoom(roomId);
    } else {
      this.history.set(roomId, valid);
      this.setRoomBytes(roomId, valid.reduce((sum, e) => sum + entryBytes(e), 0));
    }
    return before - valid.length;
  }

  getRoomIds(): string[] {
    return Array.from(this.history.keys());
  }

  clearRoom(roomId: string): void {
    this.history.delete(roomId);
    this.setRoomBytes(roomId, 0);
  }

  private shiftOldest(roomId: string): void {
    const entries = this.history.get(roomId);
    const removed = entries?.shift();
    if (!removed) return;
    if (entries!.length === 0) this.clearRoom(roomId);
    else this.adjustBytes(roomId, -entryBytes(removed));
  }

  /** The room holding the globally oldest entry, skipping the entry being added. */
  private findOldestRoom(keep: ClipboardEntry): string | undefined {
    let oldestRoom: string | undefined;
    let oldestTs = Infinity;
    for (const [roomId, entries] of this.history) {
      const first = entries[0];
      if (first && first !== keep && first.timestamp < oldestTs) {
        oldestTs = first.timestamp;
        oldestRoom = roomId;
      }
    }
    return oldestRoom;
  }

  private adjustBytes(roomId: string, delta: number): void {
    this.setRoomBytes(roomId, (this.roomBytes.get(roomId) ?? 0) + delta);
  }

  private setRoomBytes(roomId: string, bytes: number): void {
    this.totalBytes += bytes - (this.roomBytes.get(roomId) ?? 0);
    if (bytes > 0) this.roomBytes.set(roomId, bytes);
    else this.roomBytes.delete(roomId);
  }
}
