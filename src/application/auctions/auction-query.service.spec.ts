import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../infrastructure/database/db.js';
import { AuctionQueryService } from './auction-query.service.js';

describe('public auction query', () => {
  it('returns the latest participant display name and Shopping price fallback', async () => {
    const auction = {
      id: '11111111-1111-4111-8111-111111111111',
      externalAuctionId: 'external-auction',
      title: 'Leilão público',
      mode: 'LIVE',
      status: 'RUNNING',
      currency: 'BRL',
      regulationVersion: 'v1',
      approvalMode: 'AUTOMATIC',
      preBidEnabled: false,
      preBidStartsAt: null,
      preBidEndsAt: null,
      version: 1n,
      startsAt: new Date('2026-08-11T15:00:00.000Z'),
      endsAt: null,
      lots: [{
        id: '22222222-2222-4222-8222-222222222222',
        externalLotId: 'external-lot',
        lotNumber: 1,
        title: 'Lote 1',
        status: 'OPEN',
        startingBidCents: 100n,
        incrementCents: 10n,
        secondaryIncrementCents: 25n,
        nextIncrementIsSecondary: true,
        fixedPriceCents: null,
        quantity: 1,
        availableQuantity: 1,
        startsAt: null,
        endsAt: null,
        currentPriceCents: 120n,
        currentBidderId: 'participant-1',
        currentBidderAlias: 'Participante C54F40',
        lotSequence: 2n,
        version: 2n,
        updatedAt: new Date('2026-08-11T15:01:00.000Z'),
        winnerAward: {
          winnerUserId: 'participant-1',
          winningAmountCents: 100n,
        },
        bidIntents: [{
          userId: 'participant-1',
          displayName: 'Nome real do participante',
        }],
        effectiveBids: [{
          userId: 'participant-1',
          bidIntent: { displayName: 'Nome real do participante' },
        }],
      }],
    };
    const database = {
      prisma: {
        auctionExecution: { findUnique: vi.fn().mockResolvedValue(auction) },
        streamSession: { findFirst: vi.fn().mockResolvedValue(null) },
      },
    } as unknown as Database;

    const snapshot = await new AuctionQueryService(database).getAuctionSnapshot(auction.id);
    const lot = (snapshot.lots as Array<Record<string, unknown>>)[0]!;

    expect(lot.currentBidderAlias).toBe('Nome real do participante');
    expect(lot.currentBidderName).toBe('Nome real do participante');
    expect(lot.secondaryIncrementCents).toBe('25');
    expect(lot.currentIncrementCents).toBe('25');
    expect(lot.nextBidCents).toBe('145');

    auction.mode = 'SHOPPING';
    const shoppingSnapshot = await new AuctionQueryService(database).getAuctionSnapshot(auction.id);
    const shoppingLot = (shoppingSnapshot.lots as Array<Record<string, unknown>>)[0]!;

    expect(shoppingLot.fixedPriceCents).toBe('100');
    expect(shoppingLot.winnerName).toBe('Nome real do participante');
  });

  it('resolves the leader and winner from their own intent when a proxy bid caused the latest effective bid', async () => {
    const auction = {
      id: '11111111-1111-4111-8111-111111111111',
      externalAuctionId: 'external-auction',
      title: 'Leilão público',
      mode: 'TIMED',
      status: 'CLOSED',
      currency: 'BRL',
      regulationVersion: 'v1',
      approvalMode: 'AUTOMATIC',
      preBidEnabled: false,
      preBidStartsAt: null,
      preBidEndsAt: null,
      version: 1n,
      startsAt: new Date('2026-08-11T15:00:00.000Z'),
      endsAt: null,
      lots: [{
        id: '22222222-2222-4222-8222-222222222222',
        externalLotId: 'external-lot',
        lotNumber: 1,
        title: 'Lote 1',
        status: 'SOLD',
        startingBidCents: 100n,
        incrementCents: 10n,
        secondaryIncrementCents: null,
        nextIncrementIsSecondary: false,
        fixedPriceCents: null,
        quantity: 1,
        availableQuantity: 0,
        startsAt: null,
        endsAt: null,
        currentPriceCents: 120n,
        currentBidderId: 'leader-1',
        currentBidderAlias: 'Participante 123ABC',
        lotSequence: 3n,
        version: 3n,
        updatedAt: new Date('2026-08-11T15:03:00.000Z'),
        winnerAward: { winnerUserId: 'leader-1', winningAmountCents: 120n },
        bidIntents: [
          { userId: 'challenger-1', displayName: 'Quem cobriu o lance' },
          { userId: 'leader-1', displayName: 'Vencedor do lote' },
        ],
        effectiveBids: [{
          userId: 'leader-1',
          bidIntent: { displayName: 'Quem cobriu o lance' },
        }],
      }],
    };
    const database = {
      prisma: {
        auctionExecution: { findUnique: vi.fn().mockResolvedValue(auction) },
        streamSession: { findFirst: vi.fn().mockResolvedValue(null) },
      },
    } as unknown as Database;

    const snapshot = await new AuctionQueryService(database).getAuctionSnapshot(auction.id);
    const lot = (snapshot.lots as Array<Record<string, unknown>>)[0]!;

    expect(lot.currentBidderName).toBe('Vencedor do lote');
    expect(lot.winnerName).toBe('Vencedor do lote');
  });
});
