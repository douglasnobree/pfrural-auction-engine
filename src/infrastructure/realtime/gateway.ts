import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { DomainError } from '../../domain/errors.js';
import { AuctionQueryService } from '../../application/auctions/auction-query.service.js';
import { RealtimeTicketService } from '../../application/realtime/ticket.service.js';
import { EventHub } from './event-hub.js';

export class RealtimeGateway {
  private server: WebSocketServer | null = null;

  constructor(private readonly tickets: RealtimeTicketService, private readonly queries: AuctionQueryService, private readonly hub: EventHub) {}

  attach(httpServer: Server): void {
    this.server = new WebSocketServer({ server: httpServer, path: '/ws' });
    this.server.on('connection', (socket, request) => { void this.handleConnection(socket, request.url ?? ''); });
  }

  private async handleConnection(socket: WebSocket, rawUrl: string): Promise<void> {
    try {
      const url = new URL(rawUrl, 'http://localhost');
      const ticket = url.searchParams.get('ticket');
      const auctionId = url.searchParams.get('auctionId');
      if (!ticket || !auctionId) throw new DomainError('INVALID_REALTIME_REQUEST', 'ticket and auctionId are required', 400);
      await this.tickets.consume(ticket, auctionId);
      const sinceValue = url.searchParams.get('since');
      const since = sinceValue && /^\d+$/.test(sinceValue) ? BigInt(sinceValue) : null;
      const lotId = url.searchParams.get('lotId');
      this.hub.subscribe(auctionId, socket);
      socket.on('close', () => this.hub.unsubscribe(auctionId, socket));
      socket.send(JSON.stringify({ type: 'connected', auctionId, serverTime: new Date().toISOString() }));
      socket.send(JSON.stringify({ type: 'snapshot', snapshot: await this.queries.getAuctionSnapshot(auctionId) }));
      if (lotId && since !== null) {
        const events = await this.queries.getEvents(lotId, since);
        if (events.length >= 500) socket.send(JSON.stringify({ type: 'resync_required', reason: 'history_gap' }));
        else for (const event of events) socket.send(JSON.stringify({ type: 'replayed', event }));
      }
    } catch (error) {
      const code = error instanceof DomainError ? error.code : 'REALTIME_CONNECTION_FAILED';
      socket.send(JSON.stringify({ type: 'error', code }));
      socket.close(1008, code);
    }
  }

  close(): void {
    this.hub.closeAll();
    this.server?.close();
    this.server = null;
  }
}
