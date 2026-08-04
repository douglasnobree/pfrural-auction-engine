import { DomainError } from './errors.js';
import type { AuctionStatus, LotStatus } from './types.js';

const auctionTransitions: Record<AuctionStatus, AuctionStatus[]> = {
  DRAFT: ['REVIEW', 'CANCELLED'],
  REVIEW: ['SCHEDULED', 'DRAFT', 'CANCELLED'],
  SCHEDULED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['PAUSED', 'FINISHED', 'ABORTED'],
  PAUSED: ['RUNNING', 'FINISHED', 'ABORTED'],
  FINISHED: [],
  CANCELLED: [],
  ABORTED: [],
};

const lotTransitions: Record<LotStatus, LotStatus[]> = {
  DRAFT: ['QUEUED', 'CANCELLED'],
  QUEUED: ['OPEN', 'CANCELLED'],
  OPEN: ['PAUSED', 'CLOSING', 'CANCELLED'],
  PAUSED: ['OPEN', 'CANCELLED'],
  CLOSING: ['SOLD', 'UNSOLD'],
  SOLD: [],
  UNSOLD: [],
  CANCELLED: [],
};

export function allowedAuctionTransitions(from: AuctionStatus): AuctionStatus[] {
  return [...auctionTransitions[from]];
}

export function allowedLotTransitions(from: LotStatus): LotStatus[] {
  return [...lotTransitions[from]];
}

export function assertAuctionTransition(from: AuctionStatus, to: AuctionStatus): void {
  if (!auctionTransitions[from].includes(to)) {
    throw new DomainError('INVALID_AUCTION_TRANSITION', `Auction cannot transition from ${from} to ${to}`, 409, {
      from,
      to,
      allowedTransitions: allowedAuctionTransitions(from),
    });
  }
}

export function assertLotTransition(from: LotStatus, to: LotStatus): void {
  if (!lotTransitions[from].includes(to)) {
    throw new DomainError('INVALID_LOT_TRANSITION', `Lot cannot transition from ${from} to ${to}`, 409, {
      from,
      to,
      allowedTransitions: allowedLotTransitions(from),
    });
  }
}
