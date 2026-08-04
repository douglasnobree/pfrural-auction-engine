import type { WebSocket } from 'ws';
import type { EventEnvelope } from '../events/envelope.js';

export class EventHub {
  private readonly sockets = new Map<string, Set<WebSocket>>();

  subscribe(auctionId: string, socket: WebSocket): void {
    const group = this.sockets.get(auctionId) ?? new Set<WebSocket>();
    group.add(socket);
    this.sockets.set(auctionId, group);
  }

  unsubscribe(auctionId: string, socket: WebSocket): void {
    const group = this.sockets.get(auctionId);
    group?.delete(socket);
    if (group?.size === 0) this.sockets.delete(auctionId);
  }

  broadcast(envelope: EventEnvelope): void {
    if (!envelope.auctionId) return;
    for (const socket of this.sockets.get(envelope.auctionId) ?? []) {
      if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'event', event: envelope }));
    }
  }

  closeAll(): void {
    for (const group of this.sockets.values()) for (const socket of group) socket.close(1001, 'server shutdown');
    this.sockets.clear();
  }
}
