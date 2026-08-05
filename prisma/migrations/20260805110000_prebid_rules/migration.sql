ALTER TABLE "auction_execution"
  ADD COLUMN "pre_bid_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pre_bid_starts_at" TIMESTAMP(3),
  ADD COLUMN "pre_bid_ends_at" TIMESTAMP(3);

UPDATE "auction_execution"
SET "pre_bid_enabled" = true
  WHERE "mode" IN ('TIMED', 'SHOPPING');
