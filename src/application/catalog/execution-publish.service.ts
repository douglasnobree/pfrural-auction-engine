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

  async purge(externalAuctionId: string): Promise<{ eventIds: string[] }> {
    return this.database.transaction(async (client) => {
      const auction = await client.auctionExecution.findUnique({ where: { externalAuctionId } });
      // An absent execution also covers drafts and retries after catalog cleanup failed.
      if (!auction) return { eventIds: [] };

      // Match the lot-before-auction order used by manager commands. Bids must finish
      // before deletion, and foreign keys prevent new children after these locks.
      await client.$queryRaw`SELECT id FROM auction_lot_execution WHERE auction_id = ${auction.id}::uuid ORDER BY id FOR UPDATE`;
      await client.$queryRaw`SELECT id FROM auction_execution WHERE id = ${auction.id}::uuid FOR UPDATE`;
      if (!await client.auctionExecution.findUnique({ where: { id: auction.id } })) return { eventIds: [] };
      const lots = await client.auctionLotExecution.findMany({ where: { auctionId: auction.id }, select: { id: true } });
      const lotIds = lots.map((lot) => lot.id);
      const lotWhere = { lotId: { in: lotIds } };
      const eventWhere = { OR: [{ auctionId: auction.id }, lotWhere] };
      const [bids, requests, registrations, streams, outbox, logs] = await Promise.all([
        client.effectiveBid.findMany({ where: lotWhere, select: { id: true } }),
        client.bidRequest.findMany({ where: lotWhere, select: { id: true } }),
        client.auctionRegistration.findMany({ where: { auctionId: auction.id }, select: { id: true } }),
        client.streamSession.findMany({ where: { auctionId: auction.id }, select: { id: true } }),
        client.outboxEvent.findMany({ where: eventWhere, select: { eventId: true } }),
        client.auctionEventLog.findMany({ where: eventWhere, select: { eventId: true } }),
      ]);
      const eventIds = [...new Set([...outbox, ...logs].map((event) => event.eventId))];
      await client.managerAction.deleteMany({ where: { targetId: { in: [auction.id, ...lotIds, ...bids.map((bid) => bid.id), ...requests.map((request) => request.id), ...registrations.map((registration) => registration.id), ...streams.map((stream) => stream.id)] } } });
      await client.consumerInbox.deleteMany({ where: { messageId: { in: eventIds } } });
      await client.outboxEvent.deleteMany({ where: eventWhere });
      await client.auctionEventLog.deleteMany({ where: eventWhere });
      await client.shoppingReservation.deleteMany({ where: lotWhere });
      await client.settlement.deleteMany({ where: { winnerAward: lotWhere } });
      await client.winnerAward.deleteMany({ where: lotWhere });
      await client.effectiveBid.deleteMany({ where: lotWhere });
      await client.proxyBid.deleteMany({ where: lotWhere });
      await client.bidIntent.deleteMany({ where: lotWhere });
      await client.bidRequest.deleteMany({ where: lotWhere });
      await client.realtimeTicket.deleteMany({ where: { auctionId: auction.id } });
      await client.streamSession.deleteMany({ where: { auctionId: auction.id } });
      await client.auctionRegistration.deleteMany({ where: { auctionId: auction.id } });
      await client.auctionExecution.update({ where: { id: auction.id }, data: { currentLotId: null } });
      await client.auctionLotExecution.deleteMany({ where: { auctionId: auction.id } });
      await client.auctionExecution.delete({ where: { id: auction.id } });
      return { eventIds };
    }, 60000);
  }

  async publish(input: PublishExecutionInput, correlationId: string): Promise<Record<string, unknown>> {
    if (input.lots.length === 0) throw new DomainError('LOTS_REQUIRED', 'At least one lot is required to publish an execution', 422);
    const isShopping = input.mode === 'SHOPPING';
    const preBidEnabled = !isShopping && (input.preBidEnabled ?? Boolean(input.preBidStartsAt || input.preBidEndsAt));
    const preBidStartsAt = isShopping || !input.preBidStartsAt ? null : new Date(input.preBidStartsAt);
    const preBidEndsAt = isShopping || !input.preBidEndsAt ? null : new Date(input.preBidEndsAt);
    const startsAt = input.startsAt ? new Date(input.startsAt) : null;
    const endsAt = isShopping && input.endsAt ? new Date(input.endsAt) : null;
    return this.database.transaction(async (client) => {
      let auction = await client.auctionExecution.findUnique({ where: { externalAuctionId: input.externalAuctionId } });
      let created = false;
      if (!auction) {
        auction = await client.auctionExecution.create({ data: {
          externalAuctionId: input.externalAuctionId, title: input.title, mode: input.mode as PrismaAuctionMode, status: 'SCHEDULED', currency: input.currency ?? 'BRL', regulationVersion: input.regulationVersion,
          approvalMode: 'AUTOMATIC', preBidEnabled, preBidStartsAt, preBidEndsAt, startsAt, endsAt,
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
          preBidStartsAt,
          preBidEndsAt,
          startsAt,
          endsAt,
        } });
      }
      const lots: Array<{ id: string; externalLotId: string; status: string }> = [];
      for (const [index, inputLot] of input.lots.entries()) {
        const desiredStatus = (inputLot.status ?? (input.mode === 'LIVE' && index > 0 ? 'PAUSED' : 'OPEN')) as PrismaLotStatus;
        let lot = await client.auctionLotExecution.upsert({
          where: { auctionId_externalLotId: { auctionId: auction.id, externalLotId: inputLot.externalLotId } },
          create: {
            auctionId: auction.id, externalLotId: inputLot.externalLotId, lotNumber: inputLot.lotNumber, title: inputLot.title, status: desiredStatus,
            startingBidCents: BigInt(inputLot.startingBidCents ?? '0'), incrementCents: isShopping ? 1n : BigInt(inputLot.incrementCents ?? '1'), secondaryIncrementCents: isShopping || inputLot.secondaryIncrementCents == null ? null : BigInt(inputLot.secondaryIncrementCents), reservePriceCents: inputLot.reservePriceCents ? BigInt(inputLot.reservePriceCents) : null, fixedPriceCents: isShopping && inputLot.fixedPriceCents ? BigInt(inputLot.fixedPriceCents) : null,
            quantity: isShopping ? 1 : inputLot.quantity ?? 1, availableQuantity: isShopping ? 1 : inputLot.quantity ?? 1, startsAt: inputLot.startsAt ? new Date(inputLot.startsAt) : null, endsAt: isShopping ? null : inputLot.endsAt ? new Date(inputLot.endsAt) : null,
          },
          update: {
            title: inputLot.title,
            lotNumber: inputLot.lotNumber,
            ...(inputLot.startingBidCents !== undefined
              ? { startingBidCents: BigInt(inputLot.startingBidCents) }
              : {}),
            ...(isShopping
              ? { incrementCents: 1n, secondaryIncrementCents: null }
              : inputLot.incrementCents !== undefined
                ? {
                    incrementCents: BigInt(inputLot.incrementCents),
                    secondaryIncrementCents:
                      inputLot.secondaryIncrementCents == null
                        ? null
                        : BigInt(inputLot.secondaryIncrementCents),
                  }
                : {}),
            ...(isShopping
              ? inputLot.fixedPriceCents !== undefined
                ? {
                    fixedPriceCents:
                      inputLot.fixedPriceCents === null
                        ? null
                        : BigInt(inputLot.fixedPriceCents),
                  }
                : {}
              : { fixedPriceCents: null }),
            startsAt: inputLot.startsAt ? new Date(inputLot.startsAt) : null,
            endsAt: isShopping ? null : inputLot.endsAt ? new Date(inputLot.endsAt) : null,
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
