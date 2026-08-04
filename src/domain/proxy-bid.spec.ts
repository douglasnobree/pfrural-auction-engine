import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.js';
import { evaluateProxyBid } from './proxy-bid.js';

const entry = (userId: string, maxBidCents: bigint, acceptedSequence: bigint) => ({ userId, maxBidCents, acceptedSequence, origin: 'ONLINE' as const, intentId: `${userId}-${acceptedSequence}` });

describe('proxy bid policy', () => {
  it('opens at the starting price and keeps the first intention on a tie', () => {
    const result = evaluateProxyBid({ entries: [], candidate: entry('a', 10000n, 1n), currentPriceCents: null, currentBidderId: null, startingBidCents: 5000n, incrementCents: 500n });
    expect(result.effectivePriceCents).toBe(5000n);
    expect(result.leader.userId).toBe('a');
  });

  it('raises only enough to beat the runner up', () => {
    const result = evaluateProxyBid({ entries: [entry('a', 10000n, 1n)], candidate: entry('b', 8000n, 2n), currentPriceCents: 5000n, currentBidderId: 'a', startingBidCents: 5000n, incrementCents: 500n });
    expect(result.effectivePriceCents).toBe(8500n);
    expect(result.leader.userId).toBe('a');
  });

  it('rejects a challenger below the next increment', () => {
    expect(() => evaluateProxyBid({ entries: [entry('a', 10000n, 1n)], candidate: entry('b', 5000n, 2n), currentPriceCents: 5000n, currentBidderId: 'a', startingBidCents: 5000n, incrementCents: 500n })).toThrowError(DomainError);
  });

  it('uses the oldest accepted maximum for equal ceilings', () => {
    const result = evaluateProxyBid({ entries: [entry('a', 10000n, 1n)], candidate: entry('b', 10000n, 2n), currentPriceCents: 5000n, currentBidderId: 'a', startingBidCents: 5000n, incrementCents: 500n });
    expect(result.leader.userId).toBe('a');
    expect(result.leaderChanged).toBe(false);
  });
});
