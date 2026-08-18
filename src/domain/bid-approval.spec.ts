import { describe, expect, it } from 'vitest';
import { requiresManagerApproval } from './bid-approval.js';

describe('bid approval policy', () => {
  it.each([
    ['TIMED', 'AUTOMATIC'],
    ['SHOPPING', 'AUTOMATIC'],
    ['LIVE', 'AUTOMATIC'],
  ] as const)('requires approval for %s pre-bids even with %s mode', (mode, approvalMode) => {
    expect(
      requiresManagerApproval({
        origin: 'ONLINE',
        phase: 'PRE_BID',
        mode,
        approvalMode,
      }),
    ).toBe(true);
  });

  it('requires approval for automatic pre-bids and leaves live automatic bids immediate', () => {
    expect(
      requiresManagerApproval({
        origin: 'PROXY',
        phase: 'PRE_BID',
        mode: 'LIVE',
        approvalMode: 'AUTOMATIC',
      }),
    ).toBe(true);
    expect(
      requiresManagerApproval({
        origin: 'ONLINE',
        phase: 'LIVE_BID',
        mode: 'LIVE',
        approvalMode: 'AUTOMATIC',
      }),
    ).toBe(false);
  });

  it('keeps manager-originated floor and phone bids outside the approval queue', () => {
    for (const origin of ['FLOOR', 'PHONE'] as const) {
      expect(
        requiresManagerApproval({
          origin,
          phase: 'PRE_BID',
          mode: 'TIMED',
          approvalMode: 'AUTOMATIC',
        }),
      ).toBe(false);
    }
  });

  it('keeps manual live approval behavior unchanged', () => {
    expect(
      requiresManagerApproval({
        origin: 'ONLINE',
        phase: 'LIVE_BID',
        mode: 'LIVE',
        approvalMode: 'MANUAL_FIFO',
      }),
    ).toBe(true);
  });
});
