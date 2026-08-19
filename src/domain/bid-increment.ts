export interface BidIncrementConfig {
  incrementCents: bigint;
  secondaryIncrementCents: bigint | null;
  nextIncrementIsSecondary: boolean;
}

export function openingBidCents(startingBidCents: bigint, incrementCents: bigint): bigint {
  return startingBidCents > 0n ? startingBidCents : incrementCents;
}

export function activeIncrementCents(config: BidIncrementConfig): bigint {
  if (
    config.nextIncrementIsSecondary &&
    config.secondaryIncrementCents !== null &&
    config.secondaryIncrementCents > 0n
  ) {
    return config.secondaryIncrementCents;
  }
  return config.incrementCents;
}

export function nextBidCents(
  currentPriceCents: bigint | null,
  startingBidCents: bigint,
  config: BidIncrementConfig,
): bigint {
  if (currentPriceCents === null) {
    return openingBidCents(startingBidCents, config.incrementCents);
  }
  return currentPriceCents + activeIncrementCents(config);
}

/**
 * A bid at the opening price does not consume an increment. Every later
 * accepted price-changing bid consumes the currently displayed increment and
 * switches the next one for the whole lot.
 */
export function advanceIncrementState(input: {
  currentPriceCents: bigint | null;
  startingBidCents: bigint;
  incrementCents: bigint;
  acceptedPriceCents: bigint;
  nextIncrementIsSecondary: boolean;
}): boolean {
  if (input.currentPriceCents === null) {
    return input.acceptedPriceCents > openingBidCents(input.startingBidCents, input.incrementCents);
  }
  if (input.acceptedPriceCents <= input.currentPriceCents) {
    return input.nextIncrementIsSecondary;
  }
  return !input.nextIncrementIsSecondary;
}
