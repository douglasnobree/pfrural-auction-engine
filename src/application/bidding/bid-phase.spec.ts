import { describe, expect, it } from 'vitest';
import { DomainError } from '../../domain/errors.js';
import { storedBidPhase } from './bidding.service.js';

describe('immutable bid phase', () => {
  it('keeps a pre-bid classification after the auction is rescheduled', () => {
    const phaseAtAcceptance = storedBidPhase('PRE_BID');
    const rescheduledAuctionPhase = 'LIVE_BID';

    expect(phaseAtAcceptance).toBe('PRE_BID');
    expect(rescheduledAuctionPhase).toBe('LIVE_BID');
    expect(phaseAtAcceptance).not.toBe(rescheduledAuctionPhase);
  });

  it('does not infer a historical phase from the current schedule', () => {
    expect(() => storedBidPhase(null)).toThrowError(DomainError);
  });
});
