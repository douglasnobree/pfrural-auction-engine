import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Database } from '../../infrastructure/database/db.js';
import { appendDomainEvent } from '../../infrastructure/events/envelope.js';
import { ExecutionPublishService } from './execution-publish.service.js';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')('execution deletion with PostgreSQL', () => {
  it('removes bids, sales and history without foreign-key errors or deleting another auction', async () => {
    const database = new Database();
    const service = new ExecutionPublishService(database);
    const externalAuctionId = `deletion-test-${randomUUID()}`;
    const otherExternalId = `deletion-control-${randomUUID()}`;
    try {
      const auction = await database.prisma.auctionExecution.create({ data: { externalAuctionId, title: 'Deletion fixture', mode: 'LIVE', regulationVersion: 'test' } });
      const other = await database.prisma.auctionExecution.create({ data: { externalAuctionId: otherExternalId, title: 'Control fixture', mode: 'LIVE', regulationVersion: 'test' } });
      const lot = await database.prisma.auctionLotExecution.create({ data: { auctionId: auction.id, externalLotId: 'lot', lotNumber: 1, title: 'Lot' } });
      const otherLot = await database.prisma.auctionLotExecution.create({ data: { auctionId: other.id, externalLotId: 'control-lot', lotNumber: 1, title: 'Control lot' } });
      await database.prisma.auctionExecution.update({ where: { id: auction.id }, data: { currentLotId: lot.id } });
      const registration = await database.prisma.auctionRegistration.create({ data: { auctionId: auction.id, userId: 'test-user', termsVersion: 'test', whatsappOptIn: false } });
      const request = await database.prisma.bidRequest.create({ data: { lotId: lot.id, userId: 'test-user', idempotencyKey: 'test-bid', commandId: 'test-command', requestedAmountCents: 100n } });
      const intent = await database.prisma.bidIntent.create({ data: { bidRequestId: request.id, lotId: lot.id, userId: 'test-user', origin: 'ONLINE', requestedAmountCents: 100n, intentSequence: 1n } });
      await database.prisma.proxyBid.create({ data: { lotId: lot.id, userId: 'test-user', maxBidCents: 100n, origin: 'ONLINE', acceptedIntentId: intent.id, acceptedSequence: 1n } });
      const bid = await database.prisma.effectiveBid.create({ data: { lotId: lot.id, bidIntentId: intent.id, causedByIntentId: intent.id, userId: 'test-user', origin: 'ONLINE', amountCents: 100n, lotSequence: 1n } });
      const award = await database.prisma.winnerAward.create({ data: { lotId: lot.id, winnerUserId: 'test-user', winningAmountCents: 100n, sourceEffectiveBidId: bid.id } });
      const settlement = await database.prisma.settlement.create({ data: { winnerAwardId: award.id, amountCents: 100n } });
      await database.prisma.shoppingReservation.create({ data: { lotId: lot.id, userId: 'test-user', idempotencyKey: 'test-reservation', quantity: 1, expiresAt: new Date(), settlementId: settlement.id } });
      await database.prisma.streamSession.create({ data: { auctionId: auction.id, provider: 'test' } });
      await database.prisma.realtimeTicket.create({ data: { auctionId: auction.id, userId: 'test-user', tokenHash: randomUUID(), expiresAt: new Date() } });
      for (const [targetType, targetId] of [['effective_bid', bid.id], ['auction_registration', registration.id], ['lot', lot.id], ['auction', auction.id]]) {
        await database.prisma.managerAction.create({ data: { actorId: 'test-manager', action: 'test', targetType: targetType!, targetId: targetId!, idempotencyKey: randomUUID() } });
      }
      const event = await database.transaction(client => appendDomainEvent(client, { eventType: 'bid.accepted', routingKey: 'bid.accepted', aggregateType: 'lot', aggregateId: lot.id, auctionId: auction.id, lotId: lot.id, lotSequence: 1n, correlationId: randomUUID(), payload: { externalAuctionId } }));
      await database.prisma.consumerInbox.create({ data: { messageId: event.eventId, consumerName: 'test' } });

      expect(await service.purge(externalAuctionId)).toEqual({ eventIds: [event.eventId] });
      expect(await database.prisma.auctionExecution.findUnique({ where: { id: auction.id } })).toBeNull();
      expect(await database.prisma.auctionLotExecution.findUnique({ where: { id: lot.id } })).toBeNull();
      expect(await database.prisma.bidRequest.findUnique({ where: { id: request.id } })).toBeNull();
      expect(await database.prisma.bidIntent.findUnique({ where: { id: intent.id } })).toBeNull();
      expect(await database.prisma.effectiveBid.findUnique({ where: { id: bid.id } })).toBeNull();
      expect(await database.prisma.proxyBid.count({ where: { lotId: lot.id } })).toBe(0);
      expect(await database.prisma.winnerAward.findUnique({ where: { id: award.id } })).toBeNull();
      expect(await database.prisma.settlement.findUnique({ where: { id: settlement.id } })).toBeNull();
      expect(await database.prisma.shoppingReservation.count({ where: { lotId: lot.id } })).toBe(0);
      expect(await database.prisma.auctionRegistration.count({ where: { auctionId: auction.id } })).toBe(0);
      expect(await database.prisma.streamSession.count({ where: { auctionId: auction.id } })).toBe(0);
      expect(await database.prisma.realtimeTicket.count({ where: { auctionId: auction.id } })).toBe(0);
      expect(await database.prisma.managerAction.count({ where: { targetId: { in: [bid.id, registration.id, lot.id, auction.id] } } })).toBe(0);
      expect(await database.prisma.outboxEvent.count({ where: { auctionId: auction.id } })).toBe(0);
      expect(await database.prisma.auctionEventLog.count({ where: { auctionId: auction.id } })).toBe(0);
      expect(await database.prisma.consumerInbox.count({ where: { messageId: event.eventId } })).toBe(0);
      expect(await database.prisma.auctionLotExecution.findUnique({ where: { id: otherLot.id } })).not.toBeNull();
      expect(await service.purge(externalAuctionId)).toEqual({ eventIds: [] });
    } finally {
      await service.purge(externalAuctionId);
      await service.purge(otherExternalId);
      await database.close();
    }
  });
});
