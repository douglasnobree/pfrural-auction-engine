import { afterEach, describe, expect, it, vi } from 'vitest';
import { BiddingService } from './bidding.service.js';

describe('manual live opening bid validation', () => {
  afterEach(() => vi.useRealTimers());

  function setup(mode = 'LIVE', status = 'RUNNING') {
    const startsAt = new Date('2026-10-13T14:00:00Z');
    const lot = {
      auctionId: 'auction-1', status: 'OPEN', version: 1n, startsAt, endsAt: null,
      auction: {
        mode, status, startsAt, preBidEnabled: true,
        preBidStartsAt: new Date('2026-10-13T10:00:00Z'),
        preBidEndsAt: new Date('2026-10-13T12:00:00Z'),
      },
    };
    const client = { auctionRegistration: { findUnique: vi.fn().mockResolvedValue({ status: 'APPROVED' }) } };
    const service = new BiddingService({} as never);
    const validate = () => service['validateBid'](client as never, lot as never, { userId: 'bidder-1' } as never, 'ONLINE', 10000n);
    return { lot, client, validate };
  }

  it.each(['2026-10-13T11:59:59Z', '2026-10-13T12:00:00Z', '2026-10-13T13:00:00Z'])(
    'accepts a live bid at %s before the scheduled start', async (now) => {
      vi.useFakeTimers().setSystemTime(new Date(now));
      await expect(setup().validate()).resolves.toBeUndefined();
    },
  );

  it('still blocks pre-bids at the cutoff without a manual opening', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-10-13T12:00:00Z'));
    await expect(setup('LIVE', 'SCHEDULED').validate()).rejects.toMatchObject({ code: 'PREBID_CLOSED' });
  });

  it('keeps the timed lot start boundary', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-10-13T13:00:00Z'));
    await expect(setup('TIMED').validate()).rejects.toMatchObject({ code: 'LOT_NOT_STARTED' });
  });

  it('requires an open lot and approved participation during the live auction', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-10-13T13:00:00Z'));
    const closed = setup();
    closed.lot.status = 'PAUSED';
    await expect(closed.validate()).rejects.toMatchObject({ code: 'LOT_NOT_OPEN' });
    const unapproved = setup();
    unapproved.client.auctionRegistration.findUnique.mockResolvedValue({ status: 'PENDING' });
    await expect(unapproved.validate()).rejects.toMatchObject({ code: 'REGISTRATION_REQUIRED' });
  });
});
