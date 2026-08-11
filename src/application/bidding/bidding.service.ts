import { randomUUID } from 'node:crypto';
import { Prisma, type BidOrigin as PrismaBidOrigin, type BidPhase as PrismaBidPhase } from '@prisma/client';
import { Database, type PrismaTransaction } from '../../infrastructure/database/db.js';
import { appendDomainEvent } from '../../infrastructure/events/envelope.js';
import { asJson } from '../../infrastructure/database/rows.js';
import { DomainError, isDomainError } from '../../domain/errors.js';
import { participantAlias } from '../../domain/identity.js';
import { evaluateProxyBid } from '../../domain/proxy-bid.js';
import { parseCents } from '../../domain/money.js';
import { assertBiddingWindow, isPreBidWindow } from '../../domain/bidding-window.js';
import type { BidOrigin, BidPhase, ProxyEntry } from '../../domain/types.js';

export interface PlaceBidInput {
  lotId: string;
  userId: string;
  amountCents: unknown;
  idempotencyKey: string;
  commandId?: string;
  correlationId: string;
  expectedVersion?: bigint;
  origin?: BidOrigin;
  actorId?: string;
  displayName?: string;
}

export interface BidCommandResult {
  status: 'ACCEPTED' | 'PENDING_APPROVAL' | 'REJECTED';
  bidRequestId: string;
  lotId: string;
  lotSequence: string;
  version: string;
  currentPriceCents: string | null;
  nextBidCents: string;
  currentBidderAlias: string | null;
  currentBidderName?: string | null;
  proxyMaxBidCents?: string;
  phase?: BidPhase;
  acceptedAt?: string;
  receivedAt?: string;
  endsAt: string | null;
  serverTime: string;
  effectiveBidId?: string;
  timerExtended?: boolean;
  errorCode?: string;
}

type LockedLot = Prisma.AuctionLotExecutionGetPayload<{ include: { auction: true } }>;

export interface BidHistoryItem {
  id: string;
  bidRequestId: string;
  amountCents: string;
  origin: BidOrigin;
  phase: BidPhase | null;
  lotSequence: string;
  acceptedAt: string;
  createdAt: string;
  bidderAlias: string;
}

export interface BidHistoryPage {
  items: BidHistoryItem[];
  nextBeforeSequence: string | null;
  hasMore: boolean;
}

export class BiddingService {
  constructor(private readonly database: Database) {}

  async getActiveProxyBid(lotId: string, userId: string): Promise<Record<string, string | boolean | null>> {
    const proxy = await this.database.prisma.proxyBid.findFirst({ where: { lotId, userId, active: true }, orderBy: { createdAt: 'desc' } });
    return { lotId, active: Boolean(proxy), maxBidCents: proxy?.maxBidCents.toString() ?? null };
  }

  async placeBid(input: PlaceBidInput): Promise<BidCommandResult> {
    const amountCents = parseCents(input.amountCents);
    const origin = input.origin ?? 'ONLINE';
    const result = await this.database.transaction(async (client) => {
      const lot = await this.lockLot(client, input.lotId);
      const phase = this.phaseFor(lot);
      const request = await this.findOrCreateRequest(client, input, amountCents, origin, phase);
      if (request.existing) {
        if (request.row.requestedAmountCents !== amountCents) throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with another amount', 409);
        const previous = asJson<BidCommandResult>(request.row.result);
        if (previous) return previous;
        throw new DomainError('COMMAND_IN_PROGRESS', 'The command is already being processed', 409);
      }

      try {
        await this.validateBid(client, lot, input, origin, amountCents);
        if ((origin === 'ONLINE' || origin === 'PROXY') && lot.auction.mode === 'LIVE' && lot.auction.approvalMode === 'MANUAL_FIFO') {
          const pending = this.pendingResult(request.row.id, lot, phase, request.row.receivedAt.toISOString());
          await client.bidRequest.update({ where: { id: request.row.id }, data: { status: 'PENDING_APPROVAL', result: pending as unknown as Prisma.InputJsonValue } });
          await appendDomainEvent(client, {
            eventType: 'bid.received', routingKey: 'bid.received', aggregateType: 'bid_request', aggregateId: request.row.id,
            auctionId: lot.auctionId, lotId: lot.id, correlationId: input.correlationId, actorId: input.actorId,
            payload: { bidRequestId: request.row.id, lotId: lot.id, externalLotId: lot.externalLotId, phase, receivedAt: request.row.receivedAt.toISOString() }, writeEventLog: false,
          });
          return pending;
        }
      return this.acceptRequestLocked(client, lot, request.row.id, amountCents, origin, phase, input, undefined);
      } catch (error) {
        if (!isDomainError(error)) throw error;
        const rejected = this.rejectedResult(request.row.id, lot, phase, error.code);
        await client.bidRequest.update({ where: { id: request.row.id }, data: { status: 'REJECTED', errorCode: error.code, result: rejected as unknown as Prisma.InputJsonValue, completedAt: new Date() } });
        await appendDomainEvent(client, {
          eventType: 'bid.rejected', routingKey: 'bid.rejected', aggregateType: 'bid_request', aggregateId: request.row.id,
          auctionId: lot.auctionId, lotId: lot.id, correlationId: input.correlationId, actorId: input.actorId,
          payload: { bidRequestId: request.row.id, lotId: lot.id, externalLotId: lot.externalLotId, code: error.code }, writeEventLog: false,
        });
        return rejected;
      }
    });
    if (result.status === 'REJECTED') throw new DomainError(result.errorCode ?? 'BID_REJECTED', 'The bid was rejected', 422);
    return result;
  }

  async approveBidRequest(bidRequestId: string, actorId: string, correlationId: string): Promise<BidCommandResult> {
    return this.database.transaction(async (client) => {
      await client.$queryRaw`SELECT id FROM bid_request WHERE id = ${bidRequestId}::uuid FOR UPDATE`;
      const request = await client.bidRequest.findUnique({ where: { id: bidRequestId } });
      if (!request) throw new DomainError('BID_REQUEST_NOT_FOUND', 'Bid request not found', 404);
      if (request.status === 'ACCEPTED') {
        const result = asJson<BidCommandResult>(request.result);
        if (!result) throw new DomainError('BID_RESULT_MISSING', 'Accepted bid result is missing', 500);
        return result;
      }
      if (request.status !== 'PENDING_APPROVAL') throw new DomainError('BID_NOT_PENDING', 'Bid request is not pending approval', 409);
      const first = await client.bidRequest.findFirst({ where: { lotId: request.lotId, status: 'PENDING_APPROVAL' }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }] });
      if (first?.id !== request.id) throw new DomainError('APPROVAL_NOT_FIFO', 'Only the oldest pending bid can be approved', 409);
      const lot = await this.lockLot(client, request.lotId);
      const phase = (request.phase as BidPhase | null) ?? this.phaseFor(lot);
      await this.validateBid(client, lot, { lotId: lot.id, userId: request.userId, amountCents: request.requestedAmountCents.toString(), idempotencyKey: request.id, correlationId, displayName: request.displayName ?? undefined }, request.origin, request.requestedAmountCents);
      return this.acceptRequestLocked(client, lot, request.id, request.requestedAmountCents, request.origin, phase, { lotId: lot.id, userId: request.userId, amountCents: request.requestedAmountCents.toString(), idempotencyKey: request.id, correlationId, actorId, displayName: request.displayName ?? undefined }, actorId);
    });
  }

  async rejectBidRequest(bidRequestId: string, actorId: string, reason: string, correlationId: string): Promise<BidCommandResult> {
    if (reason.trim().length < 3) throw new DomainError('REJECTION_REASON_REQUIRED', 'A rejection reason is required', 400);
    return this.database.transaction(async (client) => {
      await client.$queryRaw`SELECT id FROM bid_request WHERE id = ${bidRequestId}::uuid FOR UPDATE`;
      const request = await client.bidRequest.findUnique({ where: { id: bidRequestId } });
      if (!request) throw new DomainError('BID_REQUEST_NOT_FOUND', 'Bid request not found', 404);
      if (request.status === 'REJECTED') {
        const saved = asJson<BidCommandResult>(request.result);
        if (saved) return saved;
      }
      if (request.status !== 'PENDING_APPROVAL') throw new DomainError('BID_NOT_PENDING', 'Bid request is not pending approval', 409);
      const lot = await this.lockLot(client, request.lotId);
      const rejected = this.rejectedResult(request.id, lot, request.phase as BidPhase | null ?? this.phaseFor(lot), 'MANAGER_REJECTED');
      await client.bidRequest.update({ where: { id: request.id }, data: { status: 'REJECTED', errorCode: 'MANAGER_REJECTED', result: rejected as unknown as Prisma.InputJsonValue, completedAt: new Date() } });
      await appendDomainEvent(client, {
        eventType: 'bid.rejected', routingKey: 'bid.rejected', aggregateType: 'bid_request', aggregateId: request.id,
        auctionId: lot.auctionId, lotId: lot.id, correlationId, actorId,
        payload: { bidRequestId: request.id, lotId: lot.id, externalLotId: lot.externalLotId, code: 'MANAGER_REJECTED', reason }, writeEventLog: false,
      });
      return rejected;
    });
  }

  async closeLot(lotId: string, correlationId: string, actorId?: string, expectedVersion?: bigint): Promise<Record<string, unknown>> {
    return this.database.transaction(async (client) => {
      const lot = await this.lockLot(client, lotId);
      if (lot.status === 'SOLD' || lot.status === 'UNSOLD') return this.loadClosedResult(client, lot);
      if (!['OPEN', 'PAUSED', 'CLOSING'].includes(lot.status)) throw new DomainError('LOT_NOT_CLOSABLE', 'Lot is not open for closing', 409);
      if (expectedVersion !== undefined && expectedVersion !== lot.version) throw new DomainError('VERSION_CONFLICT', 'Lot version is stale', 409, { currentVersion: lot.version.toString() });
      const nextSequence = lot.lotSequence + 1n;
      const winner = lot.currentBidderId && lot.currentPriceCents ? lot.currentBidderId : null;
      const reserveMet = lot.reservePriceCents === null || (lot.currentPriceCents !== null && lot.currentPriceCents >= lot.reservePriceCents);
      const sold = winner !== null && reserveMet;
      const status = sold ? 'SOLD' : 'UNSOLD';
      let awardId: string | null = null;
      let settlementId: string | null = null;
      if (sold && lot.currentPriceCents !== null) {
        const latest = await client.effectiveBid.findFirst({ where: { lotId: lot.id }, orderBy: { lotSequence: 'desc' } });
        const award = await client.winnerAward.upsert({
          where: { lotId: lot.id },
          create: { lotId: lot.id, winnerUserId: winner, winningAmountCents: lot.currentPriceCents, sourceEffectiveBidId: latest?.id },
          update: {},
        });
        awardId = award.id;
        const settlement = await client.settlement.upsert({ where: { winnerAwardId: award.id }, create: { winnerAwardId: award.id, amountCents: lot.currentPriceCents, currency: lot.auction.currency }, update: {} });
        settlementId = settlement.id;
      }
      const newVersion = lot.version + 1n;
      await client.auctionLotExecution.update({ where: { id: lot.id }, data: { status, lotSequence: nextSequence, version: newVersion } });
      const payload = {
        lotId: lot.id, externalLotId: lot.externalLotId, status, lotSequence: nextSequence.toString(), version: newVersion.toString(),
        currentPriceCents: lot.currentPriceCents?.toString() ?? null, currentBidderAlias: lot.currentBidderAlias,
        currentBidderName: lot.currentBidderAlias && lot.currentBidderAlias !== 'Participante' ? lot.currentBidderAlias : null,
        winnerName: sold && lot.currentBidderAlias && lot.currentBidderAlias !== 'Participante' ? lot.currentBidderAlias : null,
        winningAmountCents: sold ? lot.currentPriceCents?.toString() ?? null : null,
        closedAt: new Date().toISOString(),
        winnerDeclared: sold, awardId, settlementId, serverTime: new Date().toISOString(),
      };
      await appendDomainEvent(client, {
        eventType: sold ? 'lot.sold' : 'lot.unsold', routingKey: sold ? 'lot.sold' : 'lot.unsold', aggregateType: 'auction_lot_execution', aggregateId: lot.id,
        auctionId: lot.auctionId, lotId: lot.id, aggregateVersion: newVersion, lotSequence: nextSequence, correlationId, actorId, payload,
      });
      if (sold && awardId) await appendDomainEvent(client, {
        eventType: 'winner.declared', routingKey: 'winner.declared', aggregateType: 'winner_award', aggregateId: awardId,
        auctionId: lot.auctionId, lotId: lot.id, correlationId, actorId, payload: { lotId: lot.id, externalLotId: lot.externalLotId, awardId, settlementId, winnerName: lot.currentBidderAlias && lot.currentBidderAlias !== 'Participante' ? lot.currentBidderAlias : null, winningAmountCents: lot.currentPriceCents?.toString() ?? null }, writeEventLog: false,
      });
      return payload;
    });
  }

  async listEffectiveBids(lotId: string, beforeSequence?: bigint, limit = 50): Promise<BidHistoryPage> {
    const rows = await this.database.prisma.effectiveBid.findMany({
      where: { lotId, ...(beforeSequence !== undefined ? { lotSequence: { lt: beforeSequence } } : {}) },
      include: { lot: { select: { auctionId: true } }, bidIntent: { select: { bidRequestId: true, displayName: true, phase: true, approvedAt: true } } },
      orderBy: { lotSequence: 'desc' },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => ({
      id: row.id,
      bidRequestId: row.bidIntent.bidRequestId,
      amountCents: row.amountCents.toString(),
      origin: row.origin,
      phase: row.phase ?? row.bidIntent.phase,
      lotSequence: row.lotSequence.toString(),
      acceptedAt: row.bidIntent.approvedAt?.toISOString() ?? row.createdAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      bidderAlias: participantAlias(row.lot.auctionId, row.userId, row.bidIntent.displayName),
    }));
    return { items, nextBeforeSequence: hasMore ? items.at(-1)?.lotSequence ?? null : null, hasMore };
  }

  private async findOrCreateRequest(client: PrismaTransaction, input: PlaceBidInput, amountCents: bigint, origin: BidOrigin, phase: BidPhase): Promise<{ row: { id: string; requestedAmountCents: bigint; result: unknown; receivedAt: Date; phase: PrismaBidPhase | null }; existing: boolean }> {
    const existing = await client.bidRequest.findFirst({ where: { lotId: input.lotId, userId: input.userId, idempotencyKey: input.idempotencyKey } });
    if (existing) return { row: existing, existing: true };
    try {
      const created = await client.bidRequest.create({ data: {
        lotId: input.lotId, userId: input.userId, displayName: input.displayName, idempotencyKey: input.idempotencyKey, commandId: input.commandId ?? randomUUID(),
        requestedAmountCents: amountCents, origin: origin as PrismaBidOrigin, phase: phase as PrismaBidPhase, actorId: input.actorId, expectedVersion: input.expectedVersion,
      } });
      return { row: created, existing: false };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const concurrent = await client.bidRequest.findFirst({ where: { lotId: input.lotId, userId: input.userId, idempotencyKey: input.idempotencyKey } });
      if (!concurrent) throw new DomainError('IDEMPOTENCY_LOOKUP_FAILED', 'Could not load the previous command', 500);
      return { row: concurrent, existing: true };
    }
  }

  private async lockLot(client: PrismaTransaction, lotId: string): Promise<LockedLot> {
    await client.$queryRaw`SELECT id FROM auction_lot_execution WHERE id = ${lotId}::uuid FOR UPDATE`;
    const lot = await client.auctionLotExecution.findUnique({ where: { id: lotId }, include: { auction: true } });
    if (!lot) throw new DomainError('LOT_NOT_FOUND', 'Lot not found', 404);
    return lot;
  }

  private async validateBid(client: PrismaTransaction, lot: LockedLot, input: PlaceBidInput, origin: BidOrigin, amountCents: bigint): Promise<void> {
    if (!['SHOPPING', 'TIMED', 'LIVE'].includes(lot.auction.mode)) throw new DomainError('WRONG_AUCTION_MODE', 'This lot does not accept bids', 422);
    const preBidWindow = isPreBidWindow(lot.auction.mode, lot.auction.status, lot.auction.preBidEnabled);
    try {
      assertBiddingWindow({ mode: lot.auction.mode, status: lot.auction.status, preBidEnabled: lot.auction.preBidEnabled, preBidStartsAt: lot.auction.preBidStartsAt, preBidEndsAt: lot.auction.preBidEndsAt, auctionStartsAt: lot.auction.startsAt });
    } catch (error) {
      if (isDomainError(error)) throw error;
      throw new DomainError('AUCTION_NOT_OPEN', 'Auction is not accepting bids', 409);
    }
    if (lot.status !== 'OPEN') throw new DomainError('LOT_NOT_OPEN', 'Lot is not open for bids', 409);
    if (input.expectedVersion !== undefined && input.expectedVersion !== lot.version) throw new DomainError('VERSION_CONFLICT', 'Lot version is stale', 409, { currentVersion: lot.version.toString() });
    const now = Date.now();
    if (!preBidWindow && lot.startsAt && now < lot.startsAt.getTime()) throw new DomainError('LOT_NOT_STARTED', 'Lot has not started', 409);
    if (lot.endsAt && now >= lot.endsAt.getTime()) throw new DomainError('LOT_ENDED', 'Lot has ended', 409);
    const registration = await client.auctionRegistration.findUnique({ where: { auctionId_userId: { auctionId: lot.auctionId, userId: input.userId } } });
    if (registration?.status !== 'APPROVED') throw new DomainError('REGISTRATION_REQUIRED', 'Participant is not approved for this auction', 403);
    if (amountCents <= 0n) throw new DomainError('INVALID_AMOUNT', 'Bid must be positive', 422);
  }

  private async acceptRequestLocked(client: PrismaTransaction, lot: LockedLot, bidRequestId: string, amountCents: bigint, origin: BidOrigin, phase: BidPhase, input: PlaceBidInput, approvalActorId: string | undefined): Promise<BidCommandResult> {
    const nextSequence = lot.lotSequence + 1n;
    const acceptedAt = new Date();
    const intent = await client.bidIntent.create({ data: {
      bidRequestId, lotId: lot.id, userId: input.userId, displayName: input.displayName, origin: origin as PrismaBidOrigin, requestedAmountCents: amountCents,
      phase: phase as PrismaBidPhase, actorId: approvalActorId ?? input.actorId, intentSequence: nextSequence, approvedAt: acceptedAt,
    } });
    const active = await client.proxyBid.findMany({ where: { lotId: lot.id, active: true } });
    const entries: ProxyEntry[] = active.map((row) => ({ userId: row.userId, displayName: row.displayName, maxBidCents: row.maxBidCents, origin: row.origin, acceptedSequence: row.acceptedSequence, intentId: row.acceptedIntentId }));
    const existingOwnProxy = entries.find((entry) => entry.userId === input.userId);
    if (origin === 'ONLINE' && existingOwnProxy && amountCents <= existingOwnProxy.maxBidCents) {
      throw new DomainError('BID_COVERED_BY_PROXY', 'Your active automatic ceiling already covers this amount', 422, { maxBidCents: existingOwnProxy.maxBidCents.toString() });
    }
    const evaluation = evaluateProxyBid({ entries, candidate: { userId: input.userId, displayName: input.displayName, maxBidCents: amountCents, origin, acceptedSequence: nextSequence, intentId: intent.id }, currentPriceCents: lot.currentPriceCents, currentBidderId: lot.currentBidderId, startingBidCents: lot.startingBidCents, incrementCents: lot.incrementCents });
    if (origin === 'PROXY') {
      await client.proxyBid.updateMany({ where: { lotId: lot.id, userId: input.userId, active: true }, data: { active: false } });
      await client.proxyBid.create({ data: { lotId: lot.id, userId: input.userId, displayName: input.displayName, maxBidCents: amountCents, origin: origin as PrismaBidOrigin, acceptedIntentId: intent.id, acceptedSequence: nextSequence } });
    } else {
      await client.proxyBid.updateMany({ where: { lotId: lot.id, userId: input.userId, active: true }, data: { active: false } });
    }
    const effectivePriceCents = origin === 'ONLINE' && evaluation.runnerUp === null && evaluation.leader.userId === input.userId
      ? amountCents
      : evaluation.effectivePriceCents;
    const priceChanged = lot.currentPriceCents !== effectivePriceCents;
    const leaderChanged = lot.currentBidderId !== evaluation.leader.userId;
    let endsAt = lot.endsAt;
    let timerExtended = false;
    if (endsAt && lot.extensionWindowSeconds > 0 && lot.extensionSeconds > 0 && endsAt.getTime() - Date.now() <= lot.extensionWindowSeconds * 1000 && (lot.maxExtensions === null || lot.extensionCount < lot.maxExtensions)) {
      endsAt = new Date(endsAt.getTime() + lot.extensionSeconds * 1000);
      timerExtended = true;
    }
    const newVersion = lot.version + 1n;
    await client.auctionLotExecution.update({ where: { id: lot.id }, data: {
      currentPriceCents: effectivePriceCents, currentBidderId: evaluation.leader.userId,
      currentBidderAlias: participantAlias(lot.auctionId, evaluation.leader.userId, evaluation.leader.displayName), lotSequence: nextSequence, version: newVersion,
      endsAt, ...(timerExtended ? { extensionCount: { increment: 1 } } : {}),
    } });
    let effectiveBidId: string | undefined;
    if (priceChanged || leaderChanged) {
      const effective = await client.effectiveBid.create({ data: {
        lotId: lot.id, bidIntentId: intent.id, userId: evaluation.leader.userId, origin: evaluation.leader.origin as PrismaBidOrigin,
        phase: phase as PrismaBidPhase, amountCents: effectivePriceCents, lotSequence: nextSequence, causedByIntentId: intent.id,
      } });
      effectiveBidId = effective.id;
    }
    const result: BidCommandResult = {
      status: 'ACCEPTED', bidRequestId, lotId: lot.id, lotSequence: nextSequence.toString(), version: newVersion.toString(),
      currentPriceCents: effectivePriceCents.toString(), nextBidCents: (effectivePriceCents + lot.incrementCents).toString(), currentBidderAlias: participantAlias(lot.auctionId, evaluation.leader.userId, evaluation.leader.displayName), currentBidderName: evaluation.leader.displayName ?? null,
      phase, acceptedAt: acceptedAt.toISOString(), endsAt: endsAt?.toISOString() ?? null, serverTime: acceptedAt.toISOString(),
      ...(origin === 'PROXY' ? { proxyMaxBidCents: amountCents.toString() } : {}),
      ...(effectiveBidId ? { effectiveBidId } : {}), ...(timerExtended ? { timerExtended: true } : {}),
    };
    await client.bidRequest.update({ where: { id: bidRequestId }, data: { status: 'ACCEPTED', phase: phase as PrismaBidPhase, result: result as unknown as Prisma.InputJsonValue, completedAt: acceptedAt } });
    await appendDomainEvent(client, {
      eventType: 'bid.accepted', routingKey: 'bid.accepted', aggregateType: 'auction_lot_execution', aggregateId: lot.id,
      auctionId: lot.auctionId, lotId: lot.id, aggregateVersion: newVersion, lotSequence: nextSequence,
      correlationId: input.correlationId, causationId: bidRequestId, actorId: approvalActorId ?? input.actorId,
      payload: { bidRequestId, lotId: lot.id, externalLotId: lot.externalLotId, lotSequence: nextSequence.toString(), version: newVersion.toString(), currentPriceCents: effectivePriceCents.toString(), nextBidCents: (effectivePriceCents + lot.incrementCents).toString(), currentBidderAlias: participantAlias(lot.auctionId, evaluation.leader.userId, evaluation.leader.displayName), currentBidderName: evaluation.leader.displayName ?? null, bidOrigin: evaluation.leader.origin, phase, acceptedAt: acceptedAt.toISOString(), endsAt: endsAt?.toISOString() ?? null, timerExtended, serverTime: result.serverTime },
    });
    return result;
  }

  private pendingResult(requestId: string, lot: LockedLot, phase: BidPhase, receivedAt: string): BidCommandResult {
    return { status: 'PENDING_APPROVAL', bidRequestId: requestId, lotId: lot.id, phase, receivedAt, lotSequence: lot.lotSequence.toString(), version: lot.version.toString(), currentPriceCents: lot.currentPriceCents?.toString() ?? null, nextBidCents: (lot.currentPriceCents === null ? (lot.startingBidCents > 0n ? lot.startingBidCents : lot.incrementCents) : lot.currentPriceCents + lot.incrementCents).toString(), currentBidderAlias: lot.currentBidderAlias, endsAt: lot.endsAt?.toISOString() ?? null, serverTime: new Date().toISOString() };
  }

  private rejectedResult(requestId: string, lot: LockedLot, phase: BidPhase, code: string): BidCommandResult {
    return { status: 'REJECTED', bidRequestId: requestId, lotId: lot.id, phase, lotSequence: lot.lotSequence.toString(), version: lot.version.toString(), currentPriceCents: lot.currentPriceCents?.toString() ?? null, nextBidCents: (lot.currentPriceCents === null ? (lot.startingBidCents > 0n ? lot.startingBidCents : lot.incrementCents) : lot.currentPriceCents + lot.incrementCents).toString(), currentBidderAlias: lot.currentBidderAlias, endsAt: lot.endsAt?.toISOString() ?? null, serverTime: new Date().toISOString(), errorCode: code };
  }

  private phaseFor(lot: LockedLot): BidPhase {
    return isPreBidWindow(lot.auction.mode, lot.auction.status, lot.auction.preBidEnabled) ? 'PRE_BID' : 'LIVE_BID';
  }

  private async loadClosedResult(client: PrismaTransaction, lot: LockedLot): Promise<Record<string, unknown>> {
    const award = await client.winnerAward.findUnique({ where: { lotId: lot.id }, include: { settlement: true } });
    return { lotId: lot.id, status: lot.status, lotSequence: lot.lotSequence.toString(), version: lot.version.toString(), currentPriceCents: lot.currentPriceCents?.toString() ?? null, currentBidderAlias: lot.currentBidderAlias, awardId: award?.id ?? null, settlementId: award?.settlement?.id ?? null };
  }
}
