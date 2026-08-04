import { type AuctionMode as PrismaAuctionMode, type ApprovalMode as PrismaApprovalMode, type LotStatus as PrismaLotStatus } from '@prisma/client';
import { Database } from '../../infrastructure/database/db.js';
import { appendDomainEvent } from '../../infrastructure/events/envelope.js';
import { DomainError } from '../../domain/errors.js';

export interface PublishExecutionInput {
  externalAuctionId: string;
  title: string;
  mode: 'SHOPPING' | 'LIVE' | 'TIMED';
  currency?: string;
  regulationVersion: string;
  approvalMode?: 'AUTOMATIC' | 'MANUAL_FIFO';
  startsAt?: string | null;
  endsAt?: string | null;
  lots: Array<{
    externalLotId: string;
    lotNumber: number;
    title: string;
    status?: 'QUEUED' | 'OPEN' | 'PAUSED';
    startingBidCents?: string;
    incrementCents?: string;
    reservePriceCents?: string | null;
    fixedPriceCents?: string | null;
    quantity?: number;
    startsAt?: string | null;
    endsAt?: string | null;
  }>;
}

export class ExecutionPublishService {
  constructor(private readonly database: Database) {}

  async publish(input: PublishExecutionInput, correlationId: string): Promise<Record<string, unknown>> {
    if (input.lots.length === 0) throw new DomainError('LOTS_REQUIRED', 'At least one lot is required to publish an execution', 422);
    return this.database.transaction(async (client) => {
      let auction = await client.auctionExecution.findUnique({ where: { externalAuctionId: input.externalAuctionId } });
      let created = false;
      if (!auction) {
        auction = await client.auctionExecution.create({ data: {
          externalAuctionId: input.externalAuctionId, title: input.title, mode: input.mode as PrismaAuctionMode, status: 'SCHEDULED', currency: input.currency ?? 'BRL', regulationVersion: input.regulationVersion,
          approvalMode: input.approvalMode as PrismaApprovalMode | undefined, startsAt: input.startsAt ? new Date(input.startsAt) : null, endsAt: input.endsAt ? new Date(input.endsAt) : null,
        } });
        created = true;
      }
      const lots: Array<{ id: string; externalLotId: string; status: string }> = [];
      for (const [index, inputLot] of input.lots.entries()) {
        const lot = await client.auctionLotExecution.upsert({
          where: { auctionId_externalLotId: { auctionId: auction.id, externalLotId: inputLot.externalLotId } },
          create: {
            auctionId: auction.id, externalLotId: inputLot.externalLotId, lotNumber: inputLot.lotNumber, title: inputLot.title, status: (inputLot.status ?? (index === 0 ? 'OPEN' : 'PAUSED')) as PrismaLotStatus,
            startingBidCents: BigInt(inputLot.startingBidCents ?? '0'), incrementCents: BigInt(inputLot.incrementCents ?? '1'), reservePriceCents: inputLot.reservePriceCents ? BigInt(inputLot.reservePriceCents) : null, fixedPriceCents: inputLot.fixedPriceCents ? BigInt(inputLot.fixedPriceCents) : null,
            quantity: inputLot.quantity ?? 1, availableQuantity: inputLot.quantity ?? 1, startsAt: inputLot.startsAt ? new Date(inputLot.startsAt) : null, endsAt: inputLot.endsAt ? new Date(inputLot.endsAt) : null,
          },
          update: { title: inputLot.title, lotNumber: inputLot.lotNumber },
        });
        lots.push({ id: lot.id, externalLotId: lot.externalLotId, status: lot.status });
      }
      if (created && lots[0]) await client.auctionExecution.update({ where: { id: auction.id }, data: { currentLotId: lots[0].id } });
      if (created) await appendDomainEvent(client, {
        eventType: 'auction.published', routingKey: 'auction.published', aggregateType: 'auction_execution', aggregateId: auction.id, auctionId: auction.id, correlationId,
        payload: { auctionId: auction.id, externalAuctionId: auction.externalAuctionId, mode: auction.mode, lotCount: lots.length, regulationVersion: auction.regulationVersion }, writeEventLog: false,
      });
      return { auctionId: auction.id, externalAuctionId: auction.externalAuctionId, mode: auction.mode, status: auction.status, lots };
    });
  }
}
