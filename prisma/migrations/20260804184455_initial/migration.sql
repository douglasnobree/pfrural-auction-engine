-- CreateEnum
CREATE TYPE "AuctionMode" AS ENUM ('SHOPPING', 'LIVE', 'TIMED');

-- CreateEnum
CREATE TYPE "AuctionStatus" AS ENUM ('DRAFT', 'REVIEW', 'SCHEDULED', 'RUNNING', 'PAUSED', 'FINISHED', 'CANCELLED', 'ABORTED');

-- CreateEnum
CREATE TYPE "LotStatus" AS ENUM ('DRAFT', 'QUEUED', 'OPEN', 'PAUSED', 'CLOSING', 'SOLD', 'UNSOLD', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalMode" AS ENUM ('AUTOMATIC', 'MANUAL_FIFO');

-- CreateEnum
CREATE TYPE "RegistrationStatus" AS ENUM ('PENDING', 'APPROVED', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "BidRequestStatus" AS ENUM ('RECEIVED', 'PENDING_APPROVAL', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "BidOrigin" AS ENUM ('ONLINE', 'PROXY', 'FLOOR', 'PHONE');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'PAYMENT_PENDING', 'PAID', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StreamStatus" AS ENUM ('CREATED', 'STARTING', 'LIVE', 'ENDED', 'FAILED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('RESERVED', 'EXPIRED', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "auction_execution" (
    "id" UUID NOT NULL,
    "external_auction_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "mode" "AuctionMode" NOT NULL,
    "status" "AuctionStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" CHAR(3) NOT NULL DEFAULT 'BRL',
    "regulation_version" TEXT NOT NULL,
    "approval_mode" "ApprovalMode" NOT NULL DEFAULT 'AUTOMATIC',
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "version" BIGINT NOT NULL DEFAULT 0,
    "current_lot_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auction_execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auction_lot_execution" (
    "id" UUID NOT NULL,
    "auction_id" UUID NOT NULL,
    "external_lot_id" TEXT NOT NULL,
    "lot_number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "status" "LotStatus" NOT NULL DEFAULT 'DRAFT',
    "starting_bid_cents" BIGINT NOT NULL DEFAULT 0,
    "increment_cents" BIGINT NOT NULL DEFAULT 1,
    "reserve_price_cents" BIGINT,
    "fixed_price_cents" BIGINT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "available_quantity" INTEGER NOT NULL DEFAULT 1,
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "extension_window_seconds" INTEGER NOT NULL DEFAULT 0,
    "extension_seconds" INTEGER NOT NULL DEFAULT 0,
    "max_extensions" INTEGER,
    "extension_count" INTEGER NOT NULL DEFAULT 0,
    "current_price_cents" BIGINT,
    "current_bidder_id" TEXT,
    "current_bidder_alias" TEXT,
    "lot_sequence" BIGINT NOT NULL DEFAULT 0,
    "version" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auction_lot_execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auction_registration" (
    "id" UUID NOT NULL,
    "auction_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "RegistrationStatus" NOT NULL DEFAULT 'PENDING',
    "terms_version" TEXT NOT NULL,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auction_registration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bid_request" (
    "id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "command_id" TEXT NOT NULL,
    "status" "BidRequestStatus" NOT NULL DEFAULT 'RECEIVED',
    "requested_amount_cents" BIGINT NOT NULL,
    "origin" "BidOrigin" NOT NULL DEFAULT 'ONLINE',
    "actor_id" TEXT,
    "expected_version" BIGINT,
    "result" JSONB,
    "error_code" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "bid_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bid_intent" (
    "id" UUID NOT NULL,
    "bid_request_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "origin" "BidOrigin" NOT NULL,
    "requested_amount_cents" BIGINT NOT NULL,
    "actor_id" TEXT,
    "intent_sequence" BIGINT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMP(3),

    CONSTRAINT "bid_intent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proxy_bid" (
    "id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "max_bid_cents" BIGINT NOT NULL,
    "origin" "BidOrigin" NOT NULL,
    "accepted_intent_id" UUID NOT NULL,
    "accepted_sequence" BIGINT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "proxy_bid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "effective_bid" (
    "id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "bid_intent_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "origin" "BidOrigin" NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "lot_sequence" BIGINT NOT NULL,
    "caused_by_intent_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "effective_bid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "winner_award" (
    "id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "winner_user_id" TEXT NOT NULL,
    "winning_amount_cents" BIGINT NOT NULL,
    "source_effective_bid_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "winner_award_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement" (
    "id" UUID NOT NULL,
    "winner_award_id" UUID NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
    "external_order_id" TEXT,
    "amount_cents" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'BRL',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manager_action" (
    "id" UUID NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "expected_version" BIGINT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manager_action_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stream_session" (
    "id" UUID NOT NULL,
    "auction_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "playback_url" TEXT,
    "provider_stream_id" TEXT,
    "status" "StreamStatus" NOT NULL DEFAULT 'CREATED',
    "version" BIGINT NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stream_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopping_reservation" (
    "id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'RESERVED',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "settlement_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shopping_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "routing_key" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "auction_id" UUID,
    "lot_id" UUID,
    "aggregate_version" BIGINT,
    "lot_sequence" BIGINT,
    "correlation_id" TEXT NOT NULL,
    "causation_id" TEXT,
    "trace_id" TEXT,
    "actor_id" TEXT,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consumer_inbox" (
    "message_id" TEXT NOT NULL,
    "consumer_name" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consumer_inbox_pkey" PRIMARY KEY ("message_id","consumer_name")
);

-- CreateTable
CREATE TABLE "auction_event_log" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "auction_id" UUID,
    "lot_id" UUID,
    "lot_sequence" BIGINT,
    "event_type" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auction_event_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "realtime_ticket" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "auction_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "roles" JSONB NOT NULL DEFAULT '[]',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "realtime_ticket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "auction_execution_external_auction_id_key" ON "auction_execution"("external_auction_id");

-- CreateIndex
CREATE UNIQUE INDEX "auction_execution_current_lot_id_key" ON "auction_execution"("current_lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "auction_lot_execution_auction_id_lot_number_key" ON "auction_lot_execution"("auction_id", "lot_number");

-- CreateIndex
CREATE UNIQUE INDEX "auction_lot_execution_auction_id_external_lot_id_key" ON "auction_lot_execution"("auction_id", "external_lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "auction_registration_auction_id_user_id_key" ON "auction_registration"("auction_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "bid_request_lot_id_user_id_idempotency_key_key" ON "bid_request"("lot_id", "user_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "bid_intent_bid_request_id_key" ON "bid_intent"("bid_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "bid_intent_lot_id_intent_sequence_key" ON "bid_intent"("lot_id", "intent_sequence");

-- CreateIndex
CREATE INDEX "proxy_bid_lot_id_active_idx" ON "proxy_bid"("lot_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "effective_bid_lot_id_lot_sequence_key" ON "effective_bid"("lot_id", "lot_sequence");

-- CreateIndex
CREATE UNIQUE INDEX "winner_award_lot_id_key" ON "winner_award"("lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_winner_award_id_key" ON "settlement"("winner_award_id");

-- CreateIndex
CREATE UNIQUE INDEX "manager_action_actor_id_idempotency_key_key" ON "manager_action"("actor_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "shopping_reservation_lot_id_user_id_idempotency_key_key" ON "shopping_reservation"("lot_id", "user_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_event_event_id_key" ON "outbox_event"("event_id");

-- CreateIndex
CREATE INDEX "outbox_event_next_attempt_at_occurred_at_idx" ON "outbox_event"("next_attempt_at", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "auction_event_log_event_id_key" ON "auction_event_log"("event_id");

-- CreateIndex
CREATE INDEX "auction_event_log_lot_id_lot_sequence_idx" ON "auction_event_log"("lot_id", "lot_sequence");

-- CreateIndex
CREATE UNIQUE INDEX "auction_event_log_lot_id_lot_sequence_key" ON "auction_event_log"("lot_id", "lot_sequence");

-- CreateIndex
CREATE UNIQUE INDEX "realtime_ticket_token_hash_key" ON "realtime_ticket"("token_hash");

-- AddForeignKey
ALTER TABLE "auction_execution" ADD CONSTRAINT "auction_execution_current_lot_id_fkey" FOREIGN KEY ("current_lot_id") REFERENCES "auction_lot_execution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auction_lot_execution" ADD CONSTRAINT "auction_lot_execution_auction_id_fkey" FOREIGN KEY ("auction_id") REFERENCES "auction_execution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auction_registration" ADD CONSTRAINT "auction_registration_auction_id_fkey" FOREIGN KEY ("auction_id") REFERENCES "auction_execution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bid_request" ADD CONSTRAINT "bid_request_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "auction_lot_execution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bid_intent" ADD CONSTRAINT "bid_intent_bid_request_id_fkey" FOREIGN KEY ("bid_request_id") REFERENCES "bid_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bid_intent" ADD CONSTRAINT "bid_intent_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "auction_lot_execution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proxy_bid" ADD CONSTRAINT "proxy_bid_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "auction_lot_execution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proxy_bid" ADD CONSTRAINT "proxy_bid_accepted_intent_id_fkey" FOREIGN KEY ("accepted_intent_id") REFERENCES "bid_intent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "effective_bid" ADD CONSTRAINT "effective_bid_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "auction_lot_execution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "effective_bid" ADD CONSTRAINT "effective_bid_bid_intent_id_fkey" FOREIGN KEY ("bid_intent_id") REFERENCES "bid_intent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "effective_bid" ADD CONSTRAINT "effective_bid_caused_by_intent_id_fkey" FOREIGN KEY ("caused_by_intent_id") REFERENCES "bid_intent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "winner_award" ADD CONSTRAINT "winner_award_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "auction_lot_execution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "winner_award" ADD CONSTRAINT "winner_award_source_effective_bid_id_fkey" FOREIGN KEY ("source_effective_bid_id") REFERENCES "effective_bid"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_winner_award_id_fkey" FOREIGN KEY ("winner_award_id") REFERENCES "winner_award"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stream_session" ADD CONSTRAINT "stream_session_auction_id_fkey" FOREIGN KEY ("auction_id") REFERENCES "auction_execution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopping_reservation" ADD CONSTRAINT "shopping_reservation_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "auction_lot_execution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shopping_reservation" ADD CONSTRAINT "shopping_reservation_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "settlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_auction_id_fkey" FOREIGN KEY ("auction_id") REFERENCES "auction_execution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "auction_lot_execution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auction_event_log" ADD CONSTRAINT "auction_event_log_auction_id_fkey" FOREIGN KEY ("auction_id") REFERENCES "auction_execution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auction_event_log" ADD CONSTRAINT "auction_event_log_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "auction_lot_execution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "realtime_ticket" ADD CONSTRAINT "realtime_ticket_auction_id_fkey" FOREIGN KEY ("auction_id") REFERENCES "auction_execution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
