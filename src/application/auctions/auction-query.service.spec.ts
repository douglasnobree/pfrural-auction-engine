import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../infrastructure/database/db.js';
import { AuctionQueryService } from './auction-query.service.js';

describe('public auction query', () => {
  it('returns an anonymous bidder alias and never the trusted display name', async () => {
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
        fixedPriceCents: null,
        quantity: 1,
        availableQuantity: 1,
        startsAt: null,
        endsAt: null,
        currentPriceCents: 120n,
        currentBidderId: 'participant-1',
        currentBidderAlias: 'Nome real que não pode vazar',
        lotSequence: 2n,
        version: 2n,
        updatedAt: new Date('2026-08-11T15:01:00.000Z'),
        winnerAward: null,
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

    expect(lot.currentBidderAlias).toMatch(/^Participante [A-F0-9]{6}$/);
    expect(lot.currentBidderAlias).not.toContain('Nome real');
    expect(lot.currentBidderName).toBeNull();
    expect(lot.secondaryIncrementCents).toBe('25');
  });
});
