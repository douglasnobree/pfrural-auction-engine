import { describe, expect, it, vi } from 'vitest';
import { createApp, createContext } from './app.js';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')('assisted bid API integration', () => {
  it('persists the offered floor/phone amount in the official snapshot, history and events', async () => {
    const context = createContext();
    vi.spyOn(context.redis, 'consumeRateLimit').mockResolvedValue(true);
    vi.spyOn(context.redis, 'close').mockResolvedValue(undefined);
    const { app } = await createApp(context);
    try {
      const key = `integration-floor-price-${Date.now().toString(36)}`;
      const sandbox = await context.sandbox.create({ participantId: 'floor-opening-bidder', lotCount: 1, idempotencyKey: key }, key);
      const auction = await context.database.prisma.auctionExecution.findUniqueOrThrow({ where: { id: String(sandbox.auctionId) }, include: { lots: true } });
      const lot = auction.lots[0]!;
      await context.database.prisma.auctionExecution.update({ where: { id: auction.id }, data: { mode: 'LIVE', status: 'RUNNING', preBidEnabled: false } });
      await context.database.prisma.auctionLotExecution.update({ where: { id: lot.id }, data: {
        status: 'OPEN', startingBidCents: 220000n, incrementCents: 10000n, secondaryIncrementCents: null,
        nextIncrementIsSecondary: false, currentPriceCents: null, currentBidderId: null, currentBidderAlias: null, endsAt: null,
      } });
      const opening = await app.inject({ method: 'POST', url: `/v1/lots/${lot.id}/bids`, headers: { 'x-user-id': 'floor-opening-bidder', 'idempotency-key': `${key}-opening` }, payload: { amountCents: '220000' } });
      expect(opening.statusCode).toBe(200);
      expect(opening.json()).toMatchObject({ status: 'ACCEPTED', currentPriceCents: '220000', nextBidCents: '230000' });

      const managerHeaders = {
        'x-user-id': 'floor-price-manager', 'x-actor-role': 'manager',
        'x-internal-token': process.env.INTERNAL_SERVICE_TOKEN ?? 'local-development-token',
      };
      const request = {
        method: 'POST' as const, url: `/v1/manager/lots/${lot.id}/floor-bids`,
        headers: { ...managerHeaders, 'idempotency-key': `${key}-floor` },
        payload: { participantId: 'floor-price-participant', displayName: 'Participante de piso', amountCents: '230000', origin: 'FLOOR', expectedVersion: opening.json().version },
      };
      const floor = await app.inject(request);
      expect(floor.statusCode).toBe(200);
      expect(floor.json()).toMatchObject({ status: 'ACCEPTED', currentPriceCents: '230000', nextBidCents: '240000', currentBidderName: 'Participante de piso' });
      expect((await app.inject(request)).json()).toEqual(floor.json());
      const official = await app.inject({ method: 'GET', url: `/v1/auctions/${auction.id}/snapshot` });
      expect(official.statusCode).toBe(200);
      expect(official.json().lots[0]).toMatchObject({ currentPriceCents: '230000', nextBidCents: '240000', currentBidderName: 'Participante de piso' });
      const history = await app.inject({ method: 'GET', url: `/v1/lots/${lot.id}/bids` });
      expect(history.statusCode).toBe(200);
      expect(history.json().items[0]).toMatchObject({ amountCents: '230000', origin: 'FLOOR' });
      const acceptedEvents = await context.database.prisma.auctionEventLog.findMany({ where: { lotId: lot.id, eventType: 'bid.accepted', lotSequence: BigInt(floor.json().lotSequence) } });
      expect(acceptedEvents).toHaveLength(1);
      expect(acceptedEvents[0]!.payload).toMatchObject({ payload: { currentPriceCents: '230000', nextBidCents: '240000', currentBidderName: 'Participante de piso' } });

      const phone = await app.inject({
        method: 'POST', url: request.url, headers: { ...managerHeaders, 'idempotency-key': `${key}-phone` },
        payload: { ...request.payload, origin: 'PHONE', amountCents: '240000', expectedVersion: floor.json().version },
      });
      expect(phone.statusCode).toBe(200);
      expect(phone.json()).toMatchObject({ status: 'ACCEPTED', currentPriceCents: '240000', nextBidCents: '250000', currentBidderName: 'Participante de piso' });
      const persisted = await context.database.prisma.auctionLotExecution.findUniqueOrThrow({ where: { id: lot.id } });
      expect(persisted).toMatchObject({ currentPriceCents: 240000n, currentBidderId: 'floor-price-participant' });
    } finally {
      context.realtime.close();
      await app.close();
      await context.rabbit.close();
      await context.redis.close();
      await context.database.close();
    }
  });
});
