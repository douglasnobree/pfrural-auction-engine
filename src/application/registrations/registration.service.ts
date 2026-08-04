import { Database } from '../../infrastructure/database/db.js';
import { appendDomainEvent } from '../../infrastructure/events/envelope.js';
import { DomainError } from '../../domain/errors.js';

export class RegistrationService {
  constructor(private readonly database: Database) {}

  async register(auctionId: string, userId: string, termsVersion: string, idempotencyKey: string, correlationId: string): Promise<Record<string, unknown>> {
    if (!termsVersion.trim()) throw new DomainError('TERMS_VERSION_REQUIRED', 'termsVersion is required', 400);
    return this.database.transaction(async (client) => {
      const auction = await client.auctionExecution.findUnique({ where: { id: auctionId } });
      if (!auction) throw new DomainError('AUCTION_NOT_FOUND', 'Auction not found', 404);
      const existing = await client.auctionRegistration.findUnique({ where: { auctionId_userId: { auctionId, userId } } });
      if (existing) {
        if (existing.termsVersion !== termsVersion && existing.status === 'APPROVED') {
          throw new DomainError('REGISTRATION_TERMS_CONFLICT', 'An approved registration cannot change terms version', 409);
        }
        return { registrationId: existing.id, auctionId, userId, status: existing.status, termsVersion: existing.termsVersion };
      }
      const created = await client.auctionRegistration.create({ data: { auctionId, userId, status: 'APPROVED', termsVersion } });
      const registrationId = created.id;
      await appendDomainEvent(client, {
        eventType: 'registration.approved', routingKey: 'registration.approved', aggregateType: 'auction_registration', aggregateId: registrationId,
        auctionId, correlationId, causationId: idempotencyKey, payload: { registrationId, auctionId, userId, termsVersion }, writeEventLog: false,
      });
      return { registrationId, auctionId, userId, status: 'APPROVED', termsVersion };
    });
  }

  async getForUser(auctionId: string, userId: string): Promise<Record<string, unknown> | null> {
    const registration = await this.database.prisma.auctionRegistration.findUnique({ where: { auctionId_userId: { auctionId, userId } } });
    return registration ? { registrationId: registration.id, auctionId, userId, status: registration.status, termsVersion: registration.termsVersion, acceptedAt: registration.acceptedAt.toISOString() } : null;
  }
}
