ALTER TABLE "auction_lot_execution"
ADD COLUMN "next_increment_is_secondary" BOOLEAN NOT NULL DEFAULT false;
