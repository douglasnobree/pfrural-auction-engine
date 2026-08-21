export interface BiddingWindowInput {
  mode: string;
  status: string;
  preBidEnabled?: boolean;
  preBidStartsAt?: Date | null;
  preBidEndsAt?: Date | null;
  auctionStartsAt?: Date | null;
  now?: Date;
}

export function isPreBidWindow(mode: string, status: string, preBidEnabled = true): boolean {
  return status === 'SCHEDULED' && preBidEnabled && (mode === 'TIMED' || mode === 'SHOPPING' || mode === 'LIVE');
}

export function isLiveBiddingWindow(mode: string, status: string): boolean {
  return (mode === 'LIVE' || mode === 'TIMED' || mode === 'SHOPPING') && status === 'RUNNING';
}

export function auctionAcceptsBids(mode: string, status: string, preBidEnabled = true): boolean {
  return isPreBidWindow(mode, status, preBidEnabled) || isLiveBiddingWindow(mode, status);
}

export function preBidCutoffAt(input: {
  mode: string;
  preBidEnabled?: boolean;
  preBidEndsAt?: Date | null;
  auctionStartsAt?: Date | null;
}): Date | null {
  if (input.preBidEnabled === false) return null;
  return input.preBidEndsAt ?? (input.mode === 'LIVE' ? input.auctionStartsAt ?? null : null);
}

export function isPreBidExpired(
  input: Parameters<typeof preBidCutoffAt>[0],
  now = new Date(),
): boolean {
  const cutoff = preBidCutoffAt(input);
  return cutoff !== null && now >= cutoff;
}

export function assertBiddingWindow(input: BiddingWindowInput): void {
  const preBid = isPreBidWindow(input.mode, input.status, input.preBidEnabled ?? true);
  if (!auctionAcceptsBids(input.mode, input.status, input.preBidEnabled ?? true)) {
    throw new DomainError('AUCTION_NOT_OPEN', 'Auction is not accepting bids', 409);
  }

  const hasPreBidSchedule = Boolean(
    input.preBidStartsAt ||
      input.preBidEndsAt ||
      (input.mode === 'LIVE' && input.auctionStartsAt),
  );
  if (preBid && input.mode !== 'LIVE' && !hasPreBidSchedule) {
    throw new DomainError('PREBID_NOT_CONFIGURED', 'Pre-bidding is not configured', 409);
  }

  const now = input.now ?? new Date();
  if (preBid && input.preBidStartsAt && now < input.preBidStartsAt) {
    throw new DomainError('PREBID_NOT_STARTED', 'Pre-bidding has not started', 409);
  }

  const automaticPreBidMode = input.mode !== 'LIVE' && ['SCHEDULED', 'RUNNING'].includes(input.status);
  if ((preBid || automaticPreBidMode) && isPreBidExpired(input, now)) {
    throw new DomainError('PREBID_CLOSED', 'Pre-bidding has ended', 409);
  }
}
import { DomainError } from './errors.js';
