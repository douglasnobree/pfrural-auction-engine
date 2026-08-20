import { Database } from '../../infrastructure/database/db.js';
import { appendDomainEvent } from '../../infrastructure/events/envelope.js';
import { DomainError } from '../../domain/errors.js';
import { decodeRegistrationCursor, encodeRegistrationCursor } from './registration-cursor.js';

export interface RegistrationListQuery {
  cursor?: string;
  limit?: number;
}

export interface RegistrationPage {
  items: Array<Record<string, unknown>>;
  nextCursor: string | null;
  hasMore: boolean;
}
import { Prisma } from '@prisma/client';
import type { BiddingService } from '../bidding/bidding.service.js';

export class RegistrationService {
  constructor(private readonly database: Database, private readonly bidding?: BiddingService) {}

  async register(auctionId: string, userId: string, termsVersion: string, idempotencyKey: string, correlationId: string, globallyEnabled = false): Promise<Record<string, unknown>> {
    if (!termsVersion.trim()) throw new DomainError('TERMS_VERSION_REQUIRED', 'termsVersion is required', 400);
    return this.database.transaction(async (client) => {
      const auction = await client.auctionExecution.findUnique({ where: { id: auctionId } });
      if (!auction) throw new DomainError('AUCTION_NOT_FOUND', 'Auction not found', 404);
      const existing = await client.auctionRegistration.findUnique({ where: { auctionId_userId: { auctionId, userId } } });
      if (existing) {
        if (existing.termsVersion !== termsVersion && existing.status === 'APPROVED') {
          throw new DomainError('REGISTRATION_TERMS_CONFLICT', 'An approved registration cannot change terms version', 409);
        }
        const registration = globallyEnabled && existing.status !== 'APPROVED'
          ? await client.auctionRegistration.update({ where: { id: existing.id }, data: { status: 'APPROVED' } })
          : existing;
        if (registration.status === 'APPROVED' && existing.status !== 'APPROVED') await appendDomainEvent(client, {
          eventType: 'registration.approved', routingKey: 'registration.approved', aggregateType: 'auction_registration', aggregateId: registration.id,
          auctionId, correlationId, causationId: idempotencyKey, payload: { registrationId: registration.id, auctionId, userId, termsVersion: registration.termsVersion }, writeEventLog: false,
        });
        return { registrationId: registration.id, auctionId, userId, status: registration.status, termsVersion: registration.termsVersion, acceptedAt: registration.acceptedAt.toISOString() };
      }
      const status = globallyEnabled ? 'APPROVED' : 'PENDING';
      const created = await client.auctionRegistration.create({ data: { auctionId, userId, status, termsVersion } });
      const registrationId = created.id;
      await appendDomainEvent(client, {
        eventType: globallyEnabled ? 'registration.approved' : 'registration.requested', routingKey: globallyEnabled ? 'registration.approved' : 'registration.requested', aggregateType: 'auction_registration', aggregateId: registrationId,
        auctionId, correlationId, causationId: idempotencyKey, payload: { registrationId, auctionId, userId, termsVersion }, writeEventLog: false,
      });
      return { registrationId, auctionId, userId, status, termsVersion, acceptedAt: created.acceptedAt.toISOString() };
    });
  }

  async getForUser(auctionId: string, userId: string): Promise<Record<string, unknown> | null> {
    const registration = await this.database.prisma.auctionRegistration.findUnique({ where: { auctionId_userId: { auctionId, userId } } });
    return registration ? { registrationId: registration.id, auctionId, userId, status: registration.status, termsVersion: registration.termsVersion, acceptedAt: registration.acceptedAt.toISOString() } : null;
  }

  async listForAuction(auctionId: string, query: RegistrationListQuery = {}): Promise<RegistrationPage> {
    const auction = await this.database.prisma.auctionExecution.findUnique({ where: { id: auctionId }, select: { id: true } });
    if (!auction) throw new DomainError('AUCTION_NOT_FOUND', 'Auction not found', 404);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const cursor = query.cursor ? decodeRegistrationCursor(query.cursor) : undefined;
    const registrations = await this.database.prisma.auctionRegistration.findMany({
      where: {
        auctionId,
        ...(cursor
          ? {
              OR: [
                { acceptedAt: { gt: new Date(cursor.acceptedAt) } },
                { acceptedAt: new Date(cursor.acceptedAt), id: { gt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ acceptedAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    const hasMore = registrations.length > limit;
    const items = registrations.slice(0, limit).map((registration) => ({
      registrationId: registration.id,
      auctionId,
      userId: registration.userId,
      status: registration.status,
      enabled: registration.status === 'APPROVED',
      termsVersion: registration.termsVersion,
      acceptedAt: registration.acceptedAt.toISOString(),
    }));
    const last = registrations.at(limit - 1);
    return {
      items,
      nextCursor: hasMore && last ? encodeRegistrationCursor(last.acceptedAt, last.id) : null,
      hasMore,
    };
  }

  async setEnabled(auctionId: string, registrationId: string, enabled: boolean, actorId: string, idempotencyKey: string, correlationId: string): Promise<Record<string, unknown>> {
    const result = await this.database.transaction(async (client) => {
      const saved = await client.managerAction.findUnique({ where: { actorId_idempotencyKey: { actorId, idempotencyKey } } });
      if (saved?.result) return saved.result as Record<string, unknown>;
      await client.$queryRaw`SELECT id FROM auction_registration WHERE id = ${registrationId}::uuid FOR UPDATE`;
      const registration = await client.auctionRegistration.findFirst({ where: { id: registrationId, auctionId } });
      if (!registration) throw new DomainError('REGISTRATION_NOT_FOUND', 'Registration not found', 404);

      const status = enabled ? 'APPROVED' : 'SUSPENDED';
      const updated = registration.status === status
        ? registration
        : await client.auctionRegistration.update({ where: { id: registrationId }, data: { status } });
      const result = {
        registrationId: updated.id,
        auctionId,
        userId: updated.userId,
        status: updated.status,
        enabled: updated.status === 'APPROVED',
        termsVersion: updated.termsVersion,
        acceptedAt: updated.acceptedAt.toISOString(),
      };
      await client.managerAction.create({ data: { actorId, action: enabled ? 'enable-registration' : 'disable-registration', targetType: 'auction_registration', targetId: registrationId, idempotencyKey, result: result as Prisma.InputJsonValue } });
      await appendDomainEvent(client, {
        eventType: enabled ? 'registration.approved' : 'registration.suspended',
        routingKey: enabled ? 'registration.approved' : 'registration.suspended',
        aggregateType: 'auction_registration',
        aggregateId: registrationId,
        auctionId,
        correlationId,
        causationId: idempotencyKey,
        actorId,
        payload: result,
        writeEventLog: false,
      });
      return result;
    });
    if (enabled && this.bidding) {
      const releasedBids = await this.bidding.activatePendingBids(auctionId, String(result.userId), actorId, correlationId);
      return { ...result, releasedBids };
    }
    return result;
  }
}
