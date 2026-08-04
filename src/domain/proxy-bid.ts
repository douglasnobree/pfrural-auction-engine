import { DomainError } from './errors.js';
import type { BidEvaluation, BidEvaluationInput, ProxyEntry } from './types.js';

export function evaluateProxyBid(input: BidEvaluationInput): BidEvaluation {
  const existing = input.entries.find((entry) => entry.userId === input.candidate.userId);
  if (existing && input.candidate.maxBidCents <= existing.maxBidCents) {
    throw new DomainError('BID_NOT_HIGHER', 'The new maximum must be higher than the participant maximum', 422);
  }

  const openingMinimum = input.startingBidCents > 0n ? input.startingBidCents : input.incrementCents;
  const nextMinimum = input.currentPriceCents === null
    ? openingMinimum
    : input.currentPriceCents + input.incrementCents;
  if ((!existing || input.currentBidderId !== input.candidate.userId) && input.candidate.maxBidCents < nextMinimum) {
    throw new DomainError('BID_BELOW_MINIMUM', 'The bid is below the next valid increment', 422, {
      nextMinimumCents: nextMinimum.toString(),
    });
  }

  const entries = input.entries
    .filter((entry) => entry.userId !== input.candidate.userId)
    .concat(input.candidate)
    .sort(compareEntries);
  const leader = entries[0];
  if (!leader) throw new DomainError('NO_LEADER', 'A leader is required', 500);
  const runnerUp = entries[1] ?? null;

  const priceAgainstRunner = runnerUp === null
    ? openingMinimum
    : runnerUp.maxBidCents + input.incrementCents;
  let effectivePriceCents = input.currentPriceCents === null
    ? priceAgainstRunner
    : max(input.currentPriceCents, priceAgainstRunner);
  if (effectivePriceCents > leader.maxBidCents) {
    if (input.currentBidderId === leader.userId && input.currentPriceCents !== null) {
      effectivePriceCents = input.currentPriceCents;
    } else {
    throw new DomainError('BID_BELOW_MINIMUM', 'The maximum is not enough to lead at the next valid increment', 422, {
      nextMinimumCents: nextMinimum.toString(),
    });
    }
  }

  return {
    leader,
    runnerUp,
    effectivePriceCents,
    priceChanged: input.currentPriceCents !== effectivePriceCents,
    leaderChanged: input.currentBidderId !== leader.userId,
  };
}

function compareEntries(left: ProxyEntry, right: ProxyEntry): number {
  if (left.maxBidCents !== right.maxBidCents) return left.maxBidCents > right.maxBidCents ? -1 : 1;
  if (left.acceptedSequence === right.acceptedSequence) return left.userId.localeCompare(right.userId);
  return left.acceptedSequence < right.acceptedSequence ? -1 : 1;
}

function max(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}
