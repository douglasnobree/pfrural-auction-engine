import { describe, expect, it } from 'vitest';
import { BID_APPROVAL_FEATURE_ENABLED, requiresManagerApproval } from './bid-approval.js';

describe('bid approval policy', () => {
  it('keeps the approval feature disabled as a legacy workflow', () => {
    expect(BID_APPROVAL_FEATURE_ENABLED).toBe(false);
  });

  it.each([
    ['ONLINE', 'PRE_BID', 'TIMED', 'AUTOMATIC'],
    ['PROXY', 'PRE_BID', 'LIVE', 'AUTOMATIC'],
    ['ONLINE', 'LIVE_BID', 'LIVE', 'MANUAL_FIFO'],
    ['FLOOR', 'PRE_BID', 'SHOPPING', 'MANUAL_FIFO'],
  ] as const)('does not require approval for %s %s bids even with %s/%s settings', (origin, phase, mode, approvalMode) => {
    expect(requiresManagerApproval({ origin, phase, mode, approvalMode })).toBe(false);
  });

});
