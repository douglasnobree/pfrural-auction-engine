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
  return status === 'SCHEDULED' && preBidEnabled && (mode === 'TIMED' || mode === 'LIVE');
}

export function isLiveBiddingWindow(mode: string, status: string): boolean {
  return (mode === 'LIVE' || mode === 'TIMED') && status === 'RUNNING';
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
  if (input.mode === 'SHOPPING') return null;
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

  if (preBid && isPreBidExpired(input, now)) {
    throw new DomainError('PREBID_CLOSED', 'Pre-bidding has ended', 409);
  }
}

export function isShoppingPurchaseWindow(input: {
  mode: string;
  status: string;
  startsAt?: Date | null;
  endsAt?: Date | null;
  now?: Date;
}): boolean {
  if (input.mode !== 'SHOPPING' || !['SCHEDULED', 'RUNNING'].includes(input.status)) {
    return false;
  }
  const now = input.now ?? new Date();
  return Boolean(
    input.startsAt &&
      input.endsAt &&
      now >= input.startsAt &&
      now < input.endsAt,
  );
}

export function assertShoppingPurchaseWindow(input: Parameters<typeof isShoppingPurchaseWindow>[0]): void {
  if (input.mode !== 'SHOPPING') {
    throw new DomainError('WRONG_AUCTION_MODE', 'This auction is not an immediate-purchase auction', 422);
  }
  if (!input.startsAt || (input.now ?? new Date()) < input.startsAt) {
    throw new DomainError('AUCTION_NOT_OPEN', 'This shopping auction has not started', 409);
  }
  if (!input.endsAt || (input.now ?? new Date()) >= input.endsAt) {
    throw new DomainError('AUCTION_NOT_OPEN', 'This shopping auction is not available', 409);
  }
  if (!['SCHEDULED', 'RUNNING'].includes(input.status)) {
    throw new DomainError('AUCTION_NOT_OPEN', 'This shopping auction is not available', 409);
  }
}
import { DomainError } from './errors.js';
