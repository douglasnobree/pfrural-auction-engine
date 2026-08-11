CREATE TYPE "BidPhase" AS ENUM ('PRE_BID', 'LIVE_BID');

ALTER TABLE "bid_request" ADD COLUMN "phase" "BidPhase";
ALTER TABLE "bid_intent" ADD COLUMN "phase" "BidPhase";
ALTER TABLE "effective_bid" ADD COLUMN "phase" "BidPhase";
