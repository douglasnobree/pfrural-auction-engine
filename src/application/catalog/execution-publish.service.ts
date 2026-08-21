import { type AuctionMode as PrismaAuctionMode, type LotStatus as PrismaLotStatus } from '@prisma/client';
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
  preBidEnabled?: boolean;
  preBidStartsAt?: string | null;
  preBidEndsAt?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  lots: Array<{
    externalLotId: string;
    lotNumber: number;
    title: string;
    status?: 'QUEUED' | 'OPEN' | 'PAUSED';
    startingBidCents?: string;
    incrementCents?: string;
    secondaryIncrementCents?: string | null;
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
    const preBidEnabled = input.preBidEnabled ?? Boolean(input.preBidStartsAt || input.preBidEndsAt);
    return this.database.transaction(async (client) => {
      let auction = await client.auctionExecution.findUnique({ where: { externalAuctionId: input.externalAuctionId } });
      let created = false;
      if (!auction) {
        auction = await client.auctionExecution.create({ data: {
          externalAuctionId: input.externalAuctionId, title: input.title, mode: input.mode as PrismaAuctionMode, status: 'SCHEDULED', currency: input.currency ?? 'BRL', regulationVersion: input.regulationVersion,
          approvalMode: 'AUTOMATIC', preBidEnabled, preBidStartsAt: input.preBidStartsAt ? new Date(input.preBidStartsAt) : null, preBidEndsAt: input.preBidEndsAt ? new Date(input.preBidEndsAt) : null, startsAt: input.startsAt ? new Date(input.startsAt) : null, endsAt: input.endsAt ? new Date(input.endsAt) : null,
        } });
        created = true;
      } else {
        auction = await client.auctionExecution.update({ where: { id: auction.id }, data: {
          title: input.title,
          mode: input.mode as PrismaAuctionMode,
          ...(input.currency ? { currency: input.currency } : {}),
          regulationVersion: input.regulationVersion,
          approvalMode: 'AUTOMATIC',
          preBidEnabled,
          ...(input.preBidStartsAt !== undefined ? { preBidStartsAt: input.preBidStartsAt ? new Date(input.preBidStartsAt) : null } : {}),
          ...(input.preBidEndsAt !== undefined ? { preBidEndsAt: input.preBidEndsAt ? new Date(input.preBidEndsAt) : null } : {}),
          ...(input.startsAt !== undefined ? { startsAt: input.startsAt ? new Date(input.startsAt) : null } : {}),
          ...(input.endsAt !== undefined ? { endsAt: input.endsAt ? new Date(input.endsAt) : null } : {}),
        } });
      }
      const lots: Array<{ id: string; externalLotId: string; status: string }> = [];
      for (const [index, inputLot] of input.lots.entries()) {
        const desiredStatus = (inputLot.status ?? (input.mode === 'LIVE' && index > 0 ? 'PAUSED' : 'OPEN')) as PrismaLotStatus;
        let lot = await client.auctionLotExecution.upsert({
          where: { auctionId_externalLotId: { auctionId: auction.id, externalLotId: inputLot.externalLotId } },
          create: {
            auctionId: auction.id, externalLotId: inputLot.externalLotId, lotNumber: inputLot.lotNumber, title: inputLot.title, status: desiredStatus,
            startingBidCents: BigInt(inputLot.startingBidCents ?? '0'), incrementCents: BigInt(inputLot.incrementCents ?? '1'), secondaryIncrementCents: inputLot.secondaryIncrementCents == null ? null : BigInt(inputLot.secondaryIncrementCents), reservePriceCents: inputLot.reservePriceCents ? BigInt(inputLot.reservePriceCents) : null, fixedPriceCents: inputLot.fixedPriceCents ? BigInt(inputLot.fixedPriceCents) : null,
            quantity: inputLot.quantity ?? 1, availableQuantity: inputLot.quantity ?? 1, startsAt: inputLot.startsAt ? new Date(inputLot.startsAt) : null, endsAt: inputLot.endsAt ? new Date(inputLot.endsAt) : null,
          },
          update: {
            title: inputLot.title,
            lotNumber: inputLot.lotNumber,
            ...(inputLot.secondaryIncrementCents !== undefined
              ? {
                  secondaryIncrementCents:
                    inputLot.secondaryIncrementCents === null
                      ? null
                      : BigInt(inputLot.secondaryIncrementCents),
                }
              : {}),
          },
        });
        if (auction.status === 'SCHEDULED' && ['QUEUED', 'OPEN', 'PAUSED'].includes(lot.status) && lot.status !== desiredStatus) {
          lot = await client.auctionLotExecution.update({ where: { id: lot.id }, data: { status: desiredStatus, version: { increment: 1 } } });
        }
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
