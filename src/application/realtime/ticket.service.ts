import { createHash, randomBytes } from 'node:crypto';
import { Database } from '../../infrastructure/database/db.js';
import { config } from '../../config.js';
import { DomainError } from '../../domain/errors.js';

export interface RealtimeTicket {
  ticket: string;
  expiresAt: string;
  auctionId: string;
}

export class RealtimeTicketService {
  constructor(private readonly database: Database) {}

  async issue(auctionId: string, userId: string, roles: string[]): Promise<RealtimeTicket> {
    const auction = await this.database.prisma.auctionExecution.findUnique({ where: { id: auctionId }, select: { id: true } });
    if (!auction) throw new DomainError('AUCTION_NOT_FOUND', 'Auction not found', 404);
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + config.WS_TICKET_TTL_SECONDS * 1000);
    const tokenHash = createHash('sha256').update(ticket).digest('hex');
    await this.database.prisma.realtimeTicket.create({ data: { tokenHash, auctionId, userId, roles, expiresAt } });
    return { ticket, expiresAt: expiresAt.toISOString(), auctionId };
  }

  async consume(ticket: string, auctionId: string): Promise<{ userId: string; roles: string[] }> {
    const tokenHash = createHash('sha256').update(ticket).digest('hex');
    return this.database.transaction(async (client) => {
      const updated = await client.realtimeTicket.updateMany({ where: { tokenHash, auctionId, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
      if (updated.count !== 1) throw new DomainError('INVALID_REALTIME_TICKET', 'Realtime ticket is invalid or expired', 401);
      const row = await client.realtimeTicket.findUnique({ where: { tokenHash } });
      if (!row) throw new DomainError('INVALID_REALTIME_TICKET', 'Realtime ticket is invalid or expired', 401);
      return { userId: row.userId, roles: Array.isArray(row.roles) ? row.roles.map(String) : [] };
    });
  }
}
