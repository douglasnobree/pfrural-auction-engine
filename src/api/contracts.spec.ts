import { describe, expect, it } from 'vitest';
import { floorBidBody, parseBody, registrationListQuery } from './contracts.js';

describe('auction API contracts', () => {
  it('keeps floor and phone bids as explicit origins', () => {
    expect(parseBody(floorBidBody, { participantId: 'user-floor', amountCents: '12500', origin: 'FLOOR' })).toMatchObject({ origin: 'FLOOR', amountCents: '12500' });
    expect(parseBody(floorBidBody, { participantId: 'user-phone', amountCents: '13000', origin: 'PHONE' })).toMatchObject({ origin: 'PHONE', amountCents: '13000' });
  });

  it('validates manager pagination limits and preserves the opaque cursor', () => {
    expect(registrationListQuery.parse({ limit: '20', cursor: 'opaque-cursor' })).toEqual({ limit: 20, cursor: 'opaque-cursor' });
    expect(() => registrationListQuery.parse({ limit: '101' })).toThrow();
  });
});
