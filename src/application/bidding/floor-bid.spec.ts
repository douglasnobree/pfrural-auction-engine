import { describe, expect, it, vi } from 'vitest';
import { BiddingService } from './bidding.service.js';
import type { BidOrigin } from '../../domain/types.js';

function setup(options: { currentPriceCents?: bigint | null; currentBidderId?: string | null; secondaryIncrementCents?: bigint; proxies?: Array<Record<string, unknown>> } = {}) {
  const lot = {
    id: 'lot-1', externalLotId: 'catalog-lot-1', auctionId: 'auction-1', status: 'OPEN',
    startingBidCents: 220000n, incrementCents: 10000n, secondaryIncrementCents: options.secondaryIncrementCents ?? null,
    nextIncrementIsSecondary: false, currentPriceCents: 220000n as bigint | null,
    currentBidderId: 'previous-bidder' as string | null, currentBidderAlias: 'Participante anterior',
    lotSequence: 1n, version: 1n, startsAt: null, endsAt: null,
    auction: { mode: 'LIVE', status: 'RUNNING', preBidEnabled: false },
  };
  if (options.currentPriceCents !== undefined) lot.currentPriceCents = options.currentPriceCents;
  if (options.currentBidderId !== undefined) lot.currentBidderId = options.currentBidderId;
  const requests: Array<Record<string, unknown>> = [];
  const intents: Array<Record<string, unknown>> = [];
  const effectiveBids: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const client = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    auctionLotExecution: {
      findUnique: vi.fn(async () => lot),
      update: vi.fn(async ({ data }) => Object.assign(lot, data)),
    },
    auctionRegistration: { findUnique: vi.fn().mockResolvedValue({ status: 'APPROVED', acquisitionSource: 'UNKNOWN' }) },
    bidRequest: {
      findFirst: vi.fn(async ({ where }) => requests.find((row) => row.idempotencyKey === where.idempotencyKey) ?? null),
      create: vi.fn(async ({ data }) => {
        const row = { ...data, id: `request-${requests.length + 1}`, receivedAt: new Date(), result: null };
        requests.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }) => Object.assign(requests.find((row) => row.id === where.id)!, data)),
    },
    proxyBid: { findMany: vi.fn().mockResolvedValue(options.proxies ?? []), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    bidIntent: {
      findFirst: vi.fn(async () => intents.at(-1) ?? null),
      create: vi.fn(async ({ data }) => { intents.push(data); return data; }),
    },
    effectiveBid: { create: vi.fn(async ({ data }) => { const row = { ...data, id: `effective-${effectiveBids.length + 1}` }; effectiveBids.push(row); return row; }) },
    outboxEvent: { create: vi.fn(async ({ data }) => { events.push(data); return data; }) },
    auctionEventLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const service = new BiddingService({ transaction: (work: (tx: unknown) => unknown) => work(client) } as never);
  const bid = (origin: BidOrigin, amountCents = '230000', key = `${origin}-${amountCents}`) => service.placeBid({
    lotId: lot.id, userId: 'floor-participant', displayName: 'Participante de piso', amountCents,
    origin, actorId: 'manager-1', autoApproveRegistration: true, expectedVersion: lot.version,
    idempotencyKey: key, correlationId: key,
  });
  return { lot, requests, intents, effectiveBids, events, bid };
}

describe('assisted bid offered amount', () => {
  it.each(['FLOOR', 'PHONE'] as const)('registers %s at R$ 2,300 when the official price is R$ 2,200', async (origin) => {
    const h = setup();
    const result = await h.bid(origin);
    expect(result).toMatchObject({ status: 'ACCEPTED', currentPriceCents: '230000', nextBidCents: '240000', currentBidderName: 'Participante de piso' });
    expect(h.lot).toMatchObject({ currentPriceCents: 230000n, currentBidderId: 'floor-participant' });
    expect(h.effectiveBids).toHaveLength(1);
    expect(h.effectiveBids[0]).toMatchObject({ amountCents: 230000n, userId: 'floor-participant', origin });
    expect(h.requests[0]!.result).toEqual(result);
    const accepted = h.events.find((event) => event.eventType === 'bid.accepted');
    expect(accepted?.payload).toMatchObject({ payload: { currentPriceCents: '230000', nextBidCents: '240000', currentBidderName: 'Participante de piso', bidOrigin: origin } });
  });

  it('advances the price on consecutive floor bids from the same participant', async () => {
    const h = setup();
    await h.bid('FLOOR', '230000');
    expect(await h.bid('FLOOR', '240000')).toMatchObject({ currentPriceCents: '240000', nextBidCents: '250000' });
    expect(h.effectiveBids.map((bid) => bid.amountCents)).toEqual([230000n, 240000n]);
  });

  it('keeps an opening floor offer above the starting price', async () => {
    const h = setup({ currentPriceCents: null, currentBidderId: null });
    expect(await h.bid('FLOOR', '250000')).toMatchObject({ currentPriceCents: '250000', nextBidCents: '260000' });
  });

  it('advances the alternating increment after each accepted floor or phone price', async () => {
    const h = setup({ secondaryIncrementCents: 5000n });
    expect(await h.bid('FLOOR', '230000')).toMatchObject({ currentPriceCents: '230000', currentIncrementCents: '5000', nextBidCents: '235000' });
    expect(await h.bid('PHONE', '235000')).toMatchObject({ currentPriceCents: '235000', currentIncrementCents: '10000', nextBidCents: '245000' });
  });

  it('keeps the full floor offer when it beats a lower automatic ceiling', async () => {
    const h = setup({ proxies: [{ userId: 'previous-bidder', maxBidCents: 250000n, origin: 'PROXY', acceptedSequence: 1n, acceptedIntentId: 'proxy-1' }] });
    expect(await h.bid('FLOOR', '300000')).toMatchObject({ status: 'ACCEPTED', currentPriceCents: '300000', nextBidCents: '310000' });
    expect(h.lot.currentBidderId).toBe('floor-participant');
  });

  it('still lets a higher automatic ceiling respond to a floor bid', async () => {
    const h = setup({ proxies: [{ userId: 'previous-bidder', displayName: 'Participante automático', maxBidCents: 500000n, origin: 'PROXY', acceptedSequence: 1n, acceptedIntentId: 'proxy-1' }] });
    expect(await h.bid('FLOOR')).toMatchObject({ currentPriceCents: '240000', currentBidderName: 'Participante automático', nextBidCents: '250000' });
    expect(h.lot.currentBidderId).toBe('previous-bidder');
  });

  it('replays the same floor bid without increasing the price twice', async () => {
    const h = setup();
    const first = await h.bid('FLOOR', '230000', 'same-floor-request');
    expect(await h.bid('FLOOR', '230000', 'same-floor-request')).toEqual(first);
    expect(h.lot.currentPriceCents).toBe(230000n);
    expect(h.effectiveBids).toHaveLength(1);
    expect(h.events.filter((event) => event.eventType === 'bid.accepted')).toHaveLength(1);
  });
});
