import { describe, expect, it } from 'vitest';
import { floorBidBody, parseBody, publishExecutionBody, registrationListQuery } from './contracts.js';

describe('auction API contracts', () => {
  it('keeps floor and phone bids as explicit origins', () => {
    expect(parseBody(floorBidBody, { participantId: 'user-floor', amountCents: '12500', origin: 'FLOOR' })).toMatchObject({ origin: 'FLOOR', amountCents: '12500' });
    expect(parseBody(floorBidBody, { participantId: 'user-phone', amountCents: '13000', origin: 'PHONE' })).toMatchObject({ origin: 'PHONE', amountCents: '13000' });
  });

  it('validates manager pagination limits and preserves the opaque cursor', () => {
    expect(registrationListQuery.parse({ limit: '20', cursor: 'opaque-cursor' })).toEqual({ limit: 20, cursor: 'opaque-cursor' });
    expect(() => registrationListQuery.parse({ limit: '101' })).toThrow();
  });

  it('accepts an optional nullable secondary increment in publication payloads', () => {
    const base = {
      externalAuctionId: 'auction-1',
      title: 'Leilão',
      mode: 'TIMED' as const,
      regulationVersion: 'v1',
      lots: [{
        externalLotId: 'lot-1',
        lotNumber: 1,
        title: 'Lote 1',
        incrementCents: '10000',
        secondaryIncrementCents: '25000',
      }],
    };
    expect(parseBody(publishExecutionBody, base).lots[0]?.secondaryIncrementCents).toBe('25000');
    expect(parseBody(publishExecutionBody, {
      ...base,
      lots: [{ ...base.lots[0], secondaryIncrementCents: null }],
    }).lots[0]?.secondaryIncrementCents).toBeNull();
  });
});
