ALTER TABLE "effective_bid"
  ADD COLUMN "voided_at" TIMESTAMP(3),
  ADD COLUMN "voided_by" TEXT,
  ADD COLUMN "void_reason" TEXT;

CREATE INDEX "effective_bid_lot_id_voided_at_lot_sequence_idx"
  ON "effective_bid"("lot_id", "voided_at", "lot_sequence");
