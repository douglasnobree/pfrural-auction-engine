import { describe, expect, it } from 'vitest';
import { assertAuctionTransition, assertLotTransition } from './state-machine.js';

describe('state machines', () => {
  it('allows the supported auction lifecycle', () => {
    expect(() => assertAuctionTransition('SCHEDULED', 'RUNNING')).not.toThrow();
    expect(() => assertAuctionTransition('RUNNING', 'PAUSED')).not.toThrow();
    expect(() => assertAuctionTransition('PAUSED', 'RUNNING')).not.toThrow();
  });

  it('does not allow generic status jumps', () => {
    expect(() => assertAuctionTransition('DRAFT', 'FINISHED')).toThrow();
    expect(() => assertLotTransition('OPEN', 'SOLD')).toThrow();
    expect(() => assertLotTransition('CLOSING', 'SOLD')).not.toThrow();
  });

  it('explains invalid transitions for operator recovery', () => {
    try {
      assertAuctionTransition('RUNNING', 'RUNNING');
      throw new Error('Expected transition to fail');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'INVALID_AUCTION_TRANSITION',
        details: { from: 'RUNNING', to: 'RUNNING', allowedTransitions: ['PAUSED', 'FINISHED', 'ABORTED'] },
      });
    }
  });
});
