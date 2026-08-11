export type AuctionMode = 'SHOPPING' | 'LIVE' | 'TIMED';
export type AuctionStatus = 'DRAFT' | 'REVIEW' | 'SCHEDULED' | 'RUNNING' | 'PAUSED' | 'FINISHED' | 'CANCELLED' | 'ABORTED';
export type LotStatus = 'DRAFT' | 'QUEUED' | 'OPEN' | 'PAUSED' | 'CLOSING' | 'SOLD' | 'UNSOLD' | 'CANCELLED';
export type ApprovalMode = 'AUTOMATIC' | 'MANUAL_FIFO';
export type BidOrigin = 'ONLINE' | 'PROXY' | 'FLOOR' | 'PHONE';
export type BidPhase = 'PRE_BID' | 'LIVE_BID';

export interface ProxyEntry {
  userId: string;
  displayName?: string | null;
  maxBidCents: bigint;
  origin: BidOrigin;
  acceptedSequence: bigint;
  intentId: string;
}

export interface BidEvaluationInput {
  entries: ProxyEntry[];
  candidate: ProxyEntry;
  currentPriceCents: bigint | null;
  currentBidderId: string | null;
  startingBidCents: bigint;
  incrementCents: bigint;
}

export interface BidEvaluation {
  leader: ProxyEntry;
  runnerUp: ProxyEntry | null;
  effectivePriceCents: bigint;
  priceChanged: boolean;
  leaderChanged: boolean;
}

export interface LotSnapshot {
  lotId: string;
  auctionId: string;
  mode: AuctionMode;
  status: LotStatus;
  lotSequence: bigint;
  version: bigint;
  currentPriceCents: bigint | null;
  currentBidderAlias: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  serverTime: Date;
}
