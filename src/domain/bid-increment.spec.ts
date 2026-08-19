import { describe, expect, it } from 'vitest';
import { activeIncrementCents, advanceIncrementState, nextBidCents } from './bid-increment.js';

describe('alternating bid increments', () => {
  const config = {
    incrementCents: 2000n,
    secondaryIncrementCents: 3000n,
  };

  it('uses the current increment for the four quick values and switches after an accepted higher bid', () => {
    expect(nextBidCents(null, 10000n, { ...config, nextIncrementIsSecondary: false })).toBe(10000n);
    expect(activeIncrementCents({ ...config, nextIncrementIsSecondary: false })).toBe(2000n);
    expect(advanceIncrementState({ currentPriceCents: null, startingBidCents: 10000n, ...config, acceptedPriceCents: 12000n, nextIncrementIsSecondary: false })).toBe(true);
    expect(nextBidCents(12000n, 10000n, { ...config, nextIncrementIsSecondary: true })).toBe(15000n);
  });

  it('keeps the standard increment after accepting only the opening price', () => {
    expect(advanceIncrementState({ currentPriceCents: null, startingBidCents: 10000n, ...config, acceptedPriceCents: 10000n, nextIncrementIsSecondary: false })).toBe(false);
  });

  it('toggles after a personalized amount and uses that amount as the new base', () => {
    const nextState = advanceIncrementState({ currentPriceCents: 12000n, startingBidCents: 10000n, ...config, acceptedPriceCents: 18500n, nextIncrementIsSecondary: true });
    expect(nextState).toBe(false);
    expect(nextBidCents(18500n, 10000n, { ...config, nextIncrementIsSecondary: nextState })).toBe(20500n);
  });

  it('falls back to the standard increment when no alternative is configured', () => {
    expect(activeIncrementCents({ incrementCents: 2000n, secondaryIncrementCents: null, nextIncrementIsSecondary: true })).toBe(2000n);
  });
});
