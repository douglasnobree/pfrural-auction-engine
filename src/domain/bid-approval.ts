import type { ApprovalMode, AuctionMode, BidOrigin, BidPhase } from './types.js';

export function requiresManagerApproval(input: {
  origin: BidOrigin;
  phase: BidPhase;
  mode: AuctionMode;
  approvalMode: ApprovalMode;
}): boolean {
  if (input.origin !== 'ONLINE' && input.origin !== 'PROXY') return false;

  return (
    input.phase === 'PRE_BID' ||
    (input.mode === 'LIVE' && input.approvalMode === 'MANUAL_FIFO')
  );
}
