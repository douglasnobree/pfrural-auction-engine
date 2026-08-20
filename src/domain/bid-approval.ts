import type { ApprovalMode, AuctionMode, BidOrigin, BidPhase } from './types.js';

/**
 * The manager approval workflow is retained only for historical data and
 * backwards-compatible API shapes. New bids must never enter that workflow.
 */
export const BID_APPROVAL_FEATURE_ENABLED = false;

/**
 * @deprecated Approval is a legacy workflow and is intentionally disabled.
 * Keep this policy function so older callers can be upgraded without a
 * contract break while all new bids continue through the automatic path.
 */
export function requiresManagerApproval(input: {
  origin: BidOrigin;
  phase: BidPhase;
  mode: AuctionMode;
  approvalMode: ApprovalMode;
}): boolean {
  void input;
  return BID_APPROVAL_FEATURE_ENABLED;
}
