import type { ServerWebSocket } from "bun";
import type { Peer, Room, ServerMessage, WsData } from "./types.ts";

export class RoomManager {
  private rooms = new Map<string, Room>();

  createRoom(id: string, ownerId: string): Room {
    if (this.rooms.has(id)) return this.rooms.get(id)!;
    const room: Room = { id, peers: new Map(), createdAt: Date.now(), ownerId };
    this.rooms.set(id, room);
    return room;
  }

  joinRoom(roomId: string, peerId: string, name: string, ws: ServerWebSocket<WsData>): Peer {
    let room = this.rooms.get(roomId);
    if (!room) room = this.createRoom(roomId, peerId);

    const peer: Peer = { id: peerId, name, ws, roomId };
    room.peers.set(peerId, peer);
    return peer;
  }

  leaveRoom(peerId: string, roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.peers.delete(peerId);
    if (room.peers.size === 0) {
      this.rooms.delete(roomId);
    } else if (room.ownerId === peerId) {
      // Transfer ownership to the next peer
      const nextPeer = room.peers.values().next().value;
      if (nextPeer) room.ownerId = nextPeer.id;
    }
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  isOwner(roomId: string, peerId: string): boolean {
    const room = this.rooms.get(roomId);
    return room?.ownerId === peerId;
  }

  getOwnerId(roomId: string): string | undefined {
    return this.rooms.get(roomId)?.ownerId;
  }

  getRoomPeers(roomId: string): { id: string; name: string; isOwner: boolean }[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return Array.from(room.peers.values()).map((p) => ({
      id: p.id,
      name: p.name,
      isOwner: p.id === room.ownerId,
    }));
  }

  broadcastToRoom(roomId: string, message: ServerMessage, excludePeerId?: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const data = JSON.stringify(message);
    for (const peer of room.peers.values()) {
      if (peer.id !== excludePeerId) {
        peer.ws.send(data);
      }
    }
  }

  sendToPeer(roomId: string, peerId: string, message: ServerMessage): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const peer = room.peers.get(peerId);
    if (peer) peer.ws.send(JSON.stringify(message));
  }

  getRoomIds(): string[] {
    return Array.from(this.rooms.keys());
  }

  getRoomCount(): number {
    return this.rooms.size;
  }

  getTotalPeerCount(): number {
    let count = 0;
    for (const room of this.rooms.values()) {
      count += room.peers.size;
    }
    return count;
  }
}
