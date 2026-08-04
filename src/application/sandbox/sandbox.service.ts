import { randomUUID } from 'node:crypto';
import { Database } from '../../infrastructure/database/db.js';
import { appendDomainEvent } from '../../infrastructure/events/envelope.js';
import { DomainError } from '../../domain/errors.js';

export interface CreateSandboxAuctionInput {
  label?: string;
  participantId: string;
  lotCount?: number;
  idempotencyKey: string;
}

export class SandboxService {
  constructor(private readonly database: Database) {}

  async create(input: CreateSandboxAuctionInput, correlationId: string): Promise<Record<string, unknown>> {
    const lotCount = input.lotCount ?? 3;
    if (!input.participantId.trim()) throw new DomainError('PARTICIPANT_REQUIRED', 'A sandbox participant is required', 400);
    if (lotCount < 1 || lotCount > 50) throw new DomainError('INVALID_SANDBOX_LOT_COUNT', 'Sandbox lot count must be between 1 and 50', 400);

    const now = new Date();
    const endsAt = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const externalAuctionId = `sandbox-${randomUUID()}`;
    const title = input.label?.trim() ? `Teste · ${input.label.trim()}` : `Leilão de teste · ${now.toISOString().slice(0, 16).replace('T', ' ')}`;

    return this.database.transaction(async (client) => {
      const previous = await client.managerAction.findUnique({ where: { actorId_idempotencyKey: { actorId: input.participantId, idempotencyKey: input.idempotencyKey } } });
      if (previous?.result) return previous.result as Record<string, unknown>;
      const auction = await client.auctionExecution.create({
        data: {
          externalAuctionId,
          title,
          mode: 'TIMED',
          status: 'RUNNING',
          currency: 'BRL',
          regulationVersion: 'sandbox-v1',
          approvalMode: 'AUTOMATIC',
          startsAt: now,
          endsAt,
        },
      });
      const lots = [];
      for (let index = 1; index <= lotCount; index += 1) {
        const lot = await client.auctionLotExecution.create({
          data: {
            auctionId: auction.id,
            externalLotId: `${externalAuctionId}-lot-${index}`,
            lotNumber: index,
            title: `Lote de teste ${index}`,
            status: index === 1 ? 'OPEN' : 'PAUSED',
            startingBidCents: 10000n + BigInt(index - 1) * 5000n,
            incrementCents: 1000n,
            quantity: 1,
            availableQuantity: 1,
            startsAt: index === 1 ? now : null,
            endsAt: index === 1 ? new Date(now.getTime() + 30 * 60 * 1000) : null,
          },
        });
        lots.push({ id: lot.id, externalLotId: lot.externalLotId, lotNumber: lot.lotNumber, title: lot.title, status: lot.status });
      }
      await client.auctionExecution.update({ where: { id: auction.id }, data: { currentLotId: lots[0]?.id } });
      await client.auctionRegistration.create({ data: { auctionId: auction.id, userId: input.participantId, status: 'APPROVED', termsVersion: 'sandbox-v1' } });
      await client.streamSession.create({ data: { auctionId: auction.id, provider: 'mock', playbackUrl: `https://mock-stream.invalid/${externalAuctionId}`, providerStreamId: `mock-${externalAuctionId}`, status: 'LIVE' } });
      await appendDomainEvent(client, {
        eventType: 'auction.sandbox.created',
        routingKey: 'auction.sandbox.created',
        aggregateType: 'auction_execution',
        aggregateId: auction.id,
        auctionId: auction.id,
        correlationId,
        actorId: input.participantId,
        payload: { auctionId: auction.id, externalAuctionId, title, lotCount: lots.length, participantId: input.participantId },
        writeEventLog: false,
      });
      const result = { auctionId: auction.id, externalAuctionId, title, mode: auction.mode, status: auction.status, participantId: input.participantId, lots };
      await client.managerAction.create({ data: { actorId: input.participantId, action: 'create-sandbox', targetType: 'sandbox', targetId: auction.id, idempotencyKey: input.idempotencyKey, result } });
      return result;
    });
  }
}
