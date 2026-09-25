ALTER TABLE "shopping_reservation"
ADD COLUMN "display_name" TEXT,
ADD COLUMN "amount_cents" BIGINT,
ADD COLUMN "result" JSONB;

CREATE INDEX "shopping_reservation_status_created_at_idx"
ON "shopping_reservation"("status", "created_at");

ALTER TABLE "winner_award"
ADD COLUMN "display_name" TEXT;
