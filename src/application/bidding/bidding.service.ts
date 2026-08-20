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
import { BID_APPROVAL_FEATURE_ENABLED, requiresManagerApproval } from '../../domain/bid-approval.js';
import { activeIncrementCents, advanceIncrementState, nextBidCents as calculateNextBidCents, openingBidCents } from '../../domain/bid-increment.js';
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
  autoApproveRegistration?: boolean;
}

export interface BidCommandResult {
  status: 'ACCEPTED' | 'PENDING_ELIGIBILITY' | 'PENDING_APPROVAL' | 'REJECTED';
  bidRequestId: string;
  lotId: string;
  lotSequence: string;
  version: string;
  currentPriceCents: string | null;
  currentIncrementCents: string;
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
  status: 'ACTIVE' | 'VOIDED';
  voidedAt?: string;
  voidReason?: string;
  management?: { canEdit: boolean; canDelete: boolean; isLatest: boolean; mode: 'BID' | 'PROXY'; proxyMaxBidCents?: string };
}

export interface BidHistoryPage {
  items: BidHistoryItem[];
  nextBeforeSequence: string | null;
  hasMore: boolean;
}

export interface BidManagementResult {
  status: 'UPDATED' | 'VOIDED';
  bidId: string;
  bidRequestId: string;
  lotId: string;
  amountCents: string;
  previousAmountCents?: string;
  proxyMaxBidCents?: string;
  currentPriceCents: string | null;
  currentIncrementCents: string;
  nextBidCents: string;
  currentBidderAlias: string | null;
  lotSequence: string;
  version: string;
  reason: string;
  serverTime: string;
}

export interface PendingBidApproval {
  bidRequestId: string;
  lotId: string;
  externalLotId: string;
  lotNumber: number;
  lotTitle: string;
  participantId: string;
  displayName: string | null;
  amountCents: string;
  origin: BidOrigin;
  phase: BidPhase | null;
  status: 'PENDING_APPROVAL';
  receivedAt: string;
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
        await this.validateBid(
          client,
          lot,
          input,
          origin,
          amountCents,
          true,
        );
        if (input.autoApproveRegistration) {
          await this.ensureManagerRegistration(client, lot, input);
        }
        const registration = await client.auctionRegistration.findUnique({ where: { auctionId_userId: { auctionId: lot.auctionId, userId: input.userId } } });
        if (!input.autoApproveRegistration && !registration) {
          throw new DomainError('REGISTRATION_REQUIRED', 'Participant registration is required before bidding', 403);
        }
        if (!input.autoApproveRegistration && registration?.status === 'PENDING') {
          const pending = this.pendingEligibilityResult(request.row.id, lot, phase, request.row.receivedAt.toISOString());
          await client.bidRequest.update({ where: { id: request.row.id }, data: { status: 'PENDING_ELIGIBILITY', result: pending as unknown as Prisma.InputJsonValue } });
          return pending;
        }
        if (!input.autoApproveRegistration && registration?.status !== 'APPROVED') {
          throw new DomainError('REGISTRATION_REQUIRED', 'Participant is not approved for this auction', 403);
        }
        if (BID_APPROVAL_FEATURE_ENABLED && requiresManagerApproval({ origin, phase, mode: lot.auction.mode, approvalMode: lot.auction.approvalMode })) {
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

  async approveBidRequest(bidRequestId: string, actorId: string, idempotencyKey: string, correlationId: string): Promise<BidCommandResult> {
    if (!BID_APPROVAL_FEATURE_ENABLED) throw new DomainError('BID_APPROVAL_LEGACY', 'Bid approval is a legacy feature and is disabled', 410);
    return this.database.transaction(async (client) => {
      const saved = await client.managerAction.findUnique({ where: { actorId_idempotencyKey: { actorId, idempotencyKey } } });
      if (saved) {
        if (saved.targetId !== bidRequestId) throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used for another approval', 409);
        const savedResult = asJson<BidCommandResult>(saved.result);
        if (savedResult) return savedResult;
      }
      await client.$queryRaw`SELECT id FROM bid_request WHERE id = ${bidRequestId}::uuid FOR UPDATE`;
      const request = await client.bidRequest.findUnique({ where: { id: bidRequestId } });
      if (!request) throw new DomainError('BID_REQUEST_NOT_FOUND', 'Bid request not found', 404);
      if (request.status === 'ACCEPTED') {
        const result = asJson<BidCommandResult>(request.result);
        if (!result) throw new DomainError('BID_RESULT_MISSING', 'Accepted bid result is missing', 500);
        await this.saveManagerBidAction(client, actorId, idempotencyKey, 'approve-bid', bidRequestId, result);
        return result;
      }
      if (request.status !== 'PENDING_APPROVAL') throw new DomainError('BID_NOT_PENDING', 'Bid request is not pending approval', 409);
      const first = await client.bidRequest.findFirst({ where: { lotId: request.lotId, status: 'PENDING_APPROVAL' }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }] });
      if (first?.id !== request.id) throw new DomainError('APPROVAL_NOT_FIFO', 'Only the oldest pending bid can be approved', 409);
      const lot = await this.lockLot(client, request.lotId);
      const phase = storedBidPhase(request.phase as BidPhase | null);
      await this.validateBid(client, lot, { lotId: lot.id, userId: request.userId, amountCents: request.requestedAmountCents.toString(), idempotencyKey: request.id, correlationId, displayName: request.displayName ?? undefined }, request.origin, request.requestedAmountCents);
      const result = await this.acceptRequestLocked(client, lot, request.id, request.requestedAmountCents, request.origin, phase, { lotId: lot.id, userId: request.userId, amountCents: request.requestedAmountCents.toString(), idempotencyKey: request.id, correlationId, actorId, displayName: request.displayName ?? undefined }, actorId);
      await this.saveManagerBidAction(client, actorId, idempotencyKey, 'approve-bid', bidRequestId, result);
      return result;
    });
  }

  async rejectBidRequest(bidRequestId: string, actorId: string, reason: string, idempotencyKey: string, correlationId: string): Promise<BidCommandResult> {
    if (!BID_APPROVAL_FEATURE_ENABLED) throw new DomainError('BID_APPROVAL_LEGACY', 'Bid approval is a legacy feature and is disabled', 410);
    if (reason.trim().length < 3) throw new DomainError('REJECTION_REASON_REQUIRED', 'A rejection reason is required', 400);
    return this.database.transaction(async (client) => {
      const saved = await client.managerAction.findUnique({ where: { actorId_idempotencyKey: { actorId, idempotencyKey } } });
      if (saved) {
        if (saved.targetId !== bidRequestId) throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used for another rejection', 409);
        const savedResult = asJson<BidCommandResult>(saved.result);
        if (savedResult) return savedResult;
      }
      await client.$queryRaw`SELECT id FROM bid_request WHERE id = ${bidRequestId}::uuid FOR UPDATE`;
      const request = await client.bidRequest.findUnique({ where: { id: bidRequestId } });
      if (!request) throw new DomainError('BID_REQUEST_NOT_FOUND', 'Bid request not found', 404);
      if (request.status === 'REJECTED') {
        const saved = asJson<BidCommandResult>(request.result);
        if (saved) {
          await this.saveManagerBidAction(client, actorId, idempotencyKey, 'reject-bid', bidRequestId, saved, { reason });
          return saved;
        }
      }
      if (request.status !== 'PENDING_APPROVAL') throw new DomainError('BID_NOT_PENDING', 'Bid request is not pending approval', 409);
      const lot = await this.lockLot(client, request.lotId);
      const rejected = this.rejectedResult(request.id, lot, storedBidPhase(request.phase as BidPhase | null), 'MANAGER_REJECTED');
      await client.bidRequest.update({ where: { id: request.id }, data: { status: 'REJECTED', errorCode: 'MANAGER_REJECTED', result: rejected as unknown as Prisma.InputJsonValue, completedAt: new Date() } });
      await appendDomainEvent(client, {
        eventType: 'bid.rejected', routingKey: 'bid.rejected', aggregateType: 'bid_request', aggregateId: request.id,
        auctionId: lot.auctionId, lotId: lot.id, correlationId, actorId,
        payload: { bidRequestId: request.id, lotId: lot.id, externalLotId: lot.externalLotId, code: 'MANAGER_REJECTED', reason }, writeEventLog: false,
      });
      await this.saveManagerBidAction(client, actorId, idempotencyKey, 'reject-bid', bidRequestId, rejected, { reason });
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
        currentPriceCents: lot.currentPriceCents?.toString() ?? null, currentBidderAlias: winner ? participantAlias(lot.auctionId, winner) : null,
        currentBidderName: null,
        winnerName: sold && winner ? participantAlias(lot.auctionId, winner) : null,
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
        auctionId: lot.auctionId, lotId: lot.id, correlationId, actorId, payload: { lotId: lot.id, externalLotId: lot.externalLotId, awardId, settlementId, winnerName: winner ? participantAlias(lot.auctionId, winner) : null, winningAmountCents: lot.currentPriceCents?.toString() ?? null }, writeEventLog: false,
      });
      return payload;
    });
  }

  async listEffectiveBids(lotId: string, beforeSequence?: bigint, limit = 50, includeVoided = false): Promise<BidHistoryPage> {
    const lot = includeVoided ? await this.database.prisma.auctionLotExecution.findUnique({ where: { id: lotId }, select: { status: true, winnerAward: { select: { id: true } }, proxyBids: { where: { active: true }, select: { userId: true, maxBidCents: true } } } }) : null;
    const latestActive = includeVoided ? await this.database.prisma.effectiveBid.findFirst({ where: { lotId, voidedAt: null }, orderBy: { lotSequence: 'desc' }, select: { id: true } }) : null;
    const rows = await this.database.prisma.effectiveBid.findMany({
      where: { lotId, ...(includeVoided ? {} : { voidedAt: null }), ...(beforeSequence !== undefined ? { lotSequence: { lt: beforeSequence } } : {}) },
      include: { lot: { select: { auctionId: true } }, bidIntent: { select: { bidRequestId: true, displayName: true, phase: true, approvedAt: true } } },
      orderBy: { lotSequence: 'desc' },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const canManage = Boolean(lot && ['OPEN', 'PAUSED', 'CLOSING'].includes(lot.status) && !lot.winnerAward);
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
      status: row.voidedAt ? 'VOIDED' as const : 'ACTIVE' as const,
      ...(includeVoided && row.voidedAt ? { voidedAt: row.voidedAt.toISOString(), ...(row.voidReason ? { voidReason: row.voidReason } : {}) } : {}),
      ...(includeVoided ? {
        management: {
          canEdit: canManage && !row.voidedAt,
          canDelete: canManage && !row.voidedAt,
          isLatest: latestActive?.id === row.id,
          mode: row.origin === 'PROXY' ? 'PROXY' as const : 'BID' as const,
          ...(row.origin === 'PROXY' ? { proxyMaxBidCents: lot?.proxyBids.find((proxy) => proxy.userId === row.userId)?.maxBidCents.toString() } : {}),
        },
      } : {}),
    }));
    return { items, nextBeforeSequence: hasMore ? items.at(-1)?.lotSequence ?? null : null, hasMore };
  }

  async listManagerEffectiveBids(lotId: string, beforeSequence?: bigint, limit = 50): Promise<BidHistoryPage> {
    return this.listEffectiveBids(lotId, beforeSequence, limit, true);
  }

  async updateManagerBid(bidId: string, amountInput: unknown, reason: string, actorId: string, idempotencyKey: string, correlationId: string, expectedVersion?: bigint): Promise<BidManagementResult> {
    const amountCents = parseCents(amountInput);
    if (reason.trim().length < 3) throw new DomainError('MANAGEMENT_REASON_REQUIRED', 'A management reason is required', 400);
    return this.database.transaction(async (client) => {
      const saved = await this.loadManagerMutation(client, actorId, idempotencyKey, bidId);
      if (saved) return saved;
      const { lot, bid, proxy, isLatest } = await this.prepareManagerBid(client, bidId, expectedVersion);
      if (bid.origin === 'PROXY') {
        if (!proxy) throw new DomainError('BID_PROXY_NOT_ACTIVE', 'The automatic ceiling for this bid is no longer active', 409);
        if (proxy.maxBidCents === amountCents) throw new DomainError('BID_NO_CHANGE', 'The updated automatic ceiling must be different', 422);
        if (lot.currentPriceCents !== null && amountCents < lot.currentPriceCents) throw new DomainError('BID_PROXY_BELOW_CURRENT_PRICE', 'The automatic ceiling cannot be below the current price', 422, { currentPriceCents: lot.currentPriceCents.toString() });
        const now = new Date();
        const nextSequence = lot.lotSequence + 1n;
        const newVersion = lot.version + 1n;
        await client.proxyBid.update({ where: { id: proxy.id }, data: { maxBidCents: amountCents } });
        await client.auctionLotExecution.update({ where: { id: lot.id }, data: { lotSequence: nextSequence, version: newVersion } });
        const result: BidManagementResult = {
          status: 'UPDATED', bidId: bid.id, bidRequestId: bid.bidIntent.bidRequestId, lotId: lot.id,
          amountCents: bid.amountCents.toString(), previousAmountCents: bid.amountCents.toString(), proxyMaxBidCents: amountCents.toString(),
          currentPriceCents: lot.currentPriceCents?.toString() ?? null, currentIncrementCents: this.currentIncrementCents(lot), nextBidCents: this.nextBidCents(lot),
          currentBidderAlias: lot.currentBidderAlias, lotSequence: nextSequence.toString(), version: newVersion.toString(), reason: reason.trim(), serverTime: now.toISOString(),
        };
        await appendDomainEvent(client, {
          eventType: 'bid.updated', routingKey: 'bid.updated', aggregateType: 'auction_lot_execution', aggregateId: lot.id,
          auctionId: lot.auctionId, lotId: lot.id, aggregateVersion: newVersion, lotSequence: nextSequence, correlationId, causationId: bid.bidIntent.bidRequestId, actorId,
          payload: { bidId: bid.id, bidRequestId: bid.bidIntent.bidRequestId, lotId: lot.id, origin: 'PROXY', proxyMaxBidCents: amountCents.toString(), currentPriceCents: lot.currentPriceCents?.toString() ?? null, currentIncrementCents: this.currentIncrementCents(lot), nextBidCents: this.nextBidCents(lot), reason: reason.trim(), lotSequence: nextSequence.toString(), version: newVersion.toString() },
        });
        await this.saveManagerMutation(client, actorId, idempotencyKey, 'update-proxy-bid', bid.id, expectedVersion, result, { reason: reason.trim(), proxyMaxBidCents: amountCents.toString() });
        return result;
      }
      if (bid.amountCents === amountCents) throw new DomainError('BID_NO_CHANGE', 'The updated amount must be different', 422);
      const previous = await client.effectiveBid.findFirst({ where: { lotId: lot.id, voidedAt: null, lotSequence: { lt: bid.lotSequence } }, orderBy: { lotSequence: 'desc' } });
      const next = await client.effectiveBid.findFirst({ where: { lotId: lot.id, voidedAt: null, lotSequence: { gt: bid.lotSequence } }, orderBy: { lotSequence: 'asc' } });
      const minimum = isLatest
        ? (previous ? previous.amountCents + lot.incrementCents : (lot.startingBidCents > 0n ? lot.startingBidCents : lot.incrementCents))
        : (previous?.amountCents ?? (lot.startingBidCents > 0n ? lot.startingBidCents : lot.incrementCents));
      if (amountCents < minimum) throw new DomainError('BID_BELOW_MINIMUM', 'The updated amount is below the next valid bid', 422, { minimumAmountCents: minimum.toString() });
      if (next && amountCents > next.amountCents) throw new DomainError('BID_HISTORY_ORDER_INVALID', 'An older bid cannot exceed the following active bid', 422, { maximumAmountCents: next.amountCents.toString() });
      if (isLatest) {
        const activeProxy = await client.proxyBid.findFirst({ where: { lotId: lot.id, active: true, userId: { not: bid.userId } }, select: { maxBidCents: true } });
        if (activeProxy && amountCents <= activeProxy.maxBidCents) throw new DomainError('BID_BELOW_ACTIVE_PROXY', 'The updated bid must remain above the active automatic ceiling', 422, { activeProxyMaxBidCents: activeProxy.maxBidCents.toString() });
      }
      const now = new Date();
      const nextSequence = lot.lotSequence + 1n;
      const newVersion = lot.version + 1n;
      const bidderAlias = participantAlias(lot.auctionId, bid.userId, bid.bidIntent.displayName);
      await client.effectiveBid.update({ where: { id: bid.id }, data: { amountCents } });
      await client.bidIntent.update({ where: { id: bid.bidIntentId }, data: { requestedAmountCents: amountCents } });
      await client.bidRequest.update({ where: { id: bid.bidIntent.bidRequestId }, data: { requestedAmountCents: amountCents } });
      const nextIncrementIsSecondary = await this.recalculateIncrementState(client, lot);
      const resultLot = { ...lot, currentPriceCents: isLatest ? amountCents : lot.currentPriceCents, nextIncrementIsSecondary };
      await client.auctionLotExecution.update({ where: { id: lot.id }, data: isLatest
        ? { currentPriceCents: amountCents, currentBidderId: bid.userId, currentBidderAlias: bidderAlias, nextIncrementIsSecondary, lotSequence: nextSequence, version: newVersion }
        : { nextIncrementIsSecondary, lotSequence: nextSequence, version: newVersion } });
      const result: BidManagementResult = {
        status: 'UPDATED', bidId: bid.id, bidRequestId: bid.bidIntent.bidRequestId, lotId: lot.id,
        amountCents: amountCents.toString(), previousAmountCents: bid.amountCents.toString(), currentPriceCents: isLatest ? amountCents.toString() : lot.currentPriceCents?.toString() ?? null,
        currentIncrementCents: this.currentIncrementCents(resultLot), nextBidCents: this.nextBidCents(resultLot), currentBidderAlias: isLatest ? bidderAlias : lot.currentBidderAlias,
        lotSequence: nextSequence.toString(), version: newVersion.toString(), reason: reason.trim(), serverTime: now.toISOString(),
      };
      await appendDomainEvent(client, {
        eventType: 'bid.updated', routingKey: 'bid.updated', aggregateType: 'auction_lot_execution', aggregateId: lot.id,
        auctionId: lot.auctionId, lotId: lot.id, aggregateVersion: newVersion, lotSequence: nextSequence, correlationId, causationId: bid.bidIntent.bidRequestId, actorId,
        payload: { bidId: bid.id, bidRequestId: bid.bidIntent.bidRequestId, lotId: lot.id, previousAmountCents: bid.amountCents.toString(), amountCents: amountCents.toString(), reason: reason.trim(), isLatest, currentPriceCents: isLatest ? amountCents.toString() : lot.currentPriceCents?.toString() ?? null, currentIncrementCents: this.currentIncrementCents(resultLot), nextBidCents: this.nextBidCents(resultLot), currentBidderAlias: isLatest ? participantAlias(lot.auctionId, bid.userId) : lot.currentBidderAlias, lotSequence: nextSequence.toString(), version: newVersion.toString() },
      });
      await this.saveManagerMutation(client, actorId, idempotencyKey, 'update-bid', bid.id, expectedVersion, result, { reason: reason.trim(), previousAmountCents: bid.amountCents.toString(), amountCents: amountCents.toString() });
      return result;
    });
  }

  async voidManagerBid(bidId: string, reason: string, actorId: string, idempotencyKey: string, correlationId: string, expectedVersion?: bigint): Promise<BidManagementResult> {
    if (reason.trim().length < 3) throw new DomainError('MANAGEMENT_REASON_REQUIRED', 'A management reason is required', 400);
    return this.database.transaction(async (client) => {
      const saved = await this.loadManagerMutation(client, actorId, idempotencyKey, bidId);
      if (saved) return saved;
      const { lot, bid, proxy, isLatest } = await this.prepareManagerBid(client, bidId, expectedVersion);
      const current = await client.effectiveBid.findFirst({ where: { lotId: lot.id, voidedAt: null, id: { not: bid.id } }, include: { bidIntent: { select: { displayName: true } } }, orderBy: { lotSequence: 'desc' } });
      const now = new Date();
      const nextSequence = lot.lotSequence + 1n;
      const newVersion = lot.version + 1n;
      const currentPriceCents = current?.amountCents ?? null;
      const currentBidderAlias = current ? participantAlias(lot.auctionId, current.userId, current.bidIntent.displayName) : null;
      if (proxy && isLatest) await client.proxyBid.update({ where: { id: proxy.id }, data: { active: false } });
      await client.effectiveBid.update({ where: { id: bid.id }, data: { voidedAt: now, voidedBy: actorId, voidReason: reason.trim() } });
      const recalculatedIncrementIsSecondary = await this.recalculateIncrementState(client, lot);
      const recalculatedResultLot = { ...lot, currentPriceCents, nextIncrementIsSecondary: recalculatedIncrementIsSecondary };
      await client.auctionLotExecution.update({ where: { id: lot.id }, data: { currentPriceCents, currentBidderId: current?.userId ?? null, currentBidderAlias, nextIncrementIsSecondary: recalculatedIncrementIsSecondary, lotSequence: nextSequence, version: newVersion } });
      const result: BidManagementResult = {
        status: 'VOIDED', bidId: bid.id, bidRequestId: bid.bidIntent.bidRequestId, lotId: lot.id,
        amountCents: bid.amountCents.toString(), currentPriceCents: currentPriceCents?.toString() ?? null,
        currentIncrementCents: this.currentIncrementCents(recalculatedResultLot), nextBidCents: this.nextBidCents(recalculatedResultLot), currentBidderAlias,
        lotSequence: nextSequence.toString(), version: newVersion.toString(), reason: reason.trim(), serverTime: now.toISOString(),
      };
      await appendDomainEvent(client, {
        eventType: 'bid.voided', routingKey: 'bid.voided', aggregateType: 'auction_lot_execution', aggregateId: lot.id,
        auctionId: lot.auctionId, lotId: lot.id, aggregateVersion: newVersion, lotSequence: nextSequence, correlationId, causationId: bid.bidIntent.bidRequestId, actorId,
        payload: { bidId: bid.id, bidRequestId: bid.bidIntent.bidRequestId, lotId: lot.id, origin: bid.origin, voidedAmountCents: bid.amountCents.toString(), isLatest, ...(proxy && isLatest ? { proxyId: proxy.id } : {}), reason: reason.trim(), currentPriceCents: currentPriceCents?.toString() ?? null, currentIncrementCents: this.currentIncrementCents(recalculatedResultLot), nextBidCents: this.nextBidCents(recalculatedResultLot), currentBidderAlias: current ? participantAlias(lot.auctionId, current.userId) : null, lotSequence: nextSequence.toString(), version: newVersion.toString() },
      });
      await this.saveManagerMutation(client, actorId, idempotencyKey, 'void-bid', bid.id, expectedVersion, result, { reason: reason.trim(), voidedAmountCents: bid.amountCents.toString() });
      return result;
    });
  }

  private async prepareManagerBid(client: PrismaTransaction, bidId: string, expectedVersion?: bigint): Promise<{ lot: LockedLot; bid: Prisma.EffectiveBidGetPayload<{ include: { bidIntent: true } }>; proxy: { id: string; maxBidCents: bigint } | null; isLatest: boolean }> {
    const initial = await client.effectiveBid.findUnique({ where: { id: bidId }, include: { bidIntent: true } });
    if (!initial) throw new DomainError('BID_NOT_FOUND', 'Bid not found', 404);
    const lot = await this.lockLot(client, initial.lotId);
    if (expectedVersion !== undefined && expectedVersion !== lot.version) throw new DomainError('VERSION_CONFLICT', 'Lot version is stale', 409, { currentVersion: lot.version.toString() });
    if (!['OPEN', 'PAUSED', 'CLOSING'].includes(lot.status)) throw new DomainError('BID_MANAGEMENT_CLOSED', 'Bids cannot be managed after the lot is closed', 409);
    const award = await client.winnerAward.findUnique({ where: { lotId: lot.id }, select: { id: true } });
    if (award) throw new DomainError('BID_MANAGEMENT_CLOSED', 'Bids cannot be managed after a winner is declared', 409);
    const bid = await client.effectiveBid.findUnique({ where: { id: bidId }, include: { bidIntent: true } });
    if (!bid) throw new DomainError('BID_NOT_FOUND', 'Bid not found', 404);
    if (bid.voidedAt) throw new DomainError('BID_ALREADY_VOIDED', 'This bid has already been voided', 409);
    const latest = await client.effectiveBid.findFirst({ where: { lotId: lot.id, voidedAt: null }, orderBy: { lotSequence: 'desc' }, select: { id: true } });
    const proxy = bid.origin === 'PROXY' ? await client.proxyBid.findFirst({ where: { lotId: lot.id, userId: bid.userId, active: true }, orderBy: { createdAt: 'desc' }, select: { id: true, maxBidCents: true } }) : null;
    if (bid.origin === 'PROXY' && !proxy) throw new DomainError('BID_PROXY_NOT_ACTIVE', 'The automatic ceiling for this bid is no longer active', 409);
    return { lot, bid, proxy, isLatest: latest?.id === bid.id };
  }

  private async loadManagerMutation(client: PrismaTransaction, actorId: string, idempotencyKey: string, bidId: string): Promise<BidManagementResult | null> {
    const saved = await client.managerAction.findUnique({ where: { actorId_idempotencyKey: { actorId, idempotencyKey } } });
    if (!saved) return null;
    if (saved.targetId !== bidId) throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used for another bid', 409);
    const result = asJson<BidManagementResult>(saved.result);
    if (!result) throw new DomainError('COMMAND_IN_PROGRESS', 'The command is already being processed', 409);
    return result;
  }

  async activatePendingBids(auctionId: string, userId: string, actorId: string, correlationId: string): Promise<{ processed: number; accepted: number; rejected: number }> {
    const pendingRequests = await this.database.prisma.bidRequest.findMany({
      where: { userId, status: 'PENDING_ELIGIBILITY', lot: { auctionId } },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    let accepted = 0;
    let rejected = 0;
    for (const pending of pendingRequests) {
      const result = await this.activatePendingBid(pending.id, userId, actorId, correlationId);
      if (result === 'ACCEPTED') accepted += 1;
      if (result === 'REJECTED') rejected += 1;
    }
    return { processed: accepted + rejected, accepted, rejected };
  }

  private async activatePendingBid(bidRequestId: string, userId: string, actorId: string, correlationId: string): Promise<'ACCEPTED' | 'REJECTED' | 'SKIPPED'> {
    return this.database.transaction(async (client) => {
      await client.$queryRaw`SELECT id FROM bid_request WHERE id = ${bidRequestId}::uuid FOR UPDATE`;
      const request = await client.bidRequest.findUnique({ where: { id: bidRequestId } });
      if (!request || request.status !== 'PENDING_ELIGIBILITY' || request.userId !== userId) return 'SKIPPED';
      const lot = await this.lockLot(client, request.lotId);
      const phase = storedBidPhase(request.phase as BidPhase | null);
      const input: PlaceBidInput = {
        lotId: lot.id,
        userId,
        amountCents: request.requestedAmountCents.toString(),
        idempotencyKey: request.idempotencyKey,
        correlationId,
        displayName: request.displayName ?? undefined,
      };
      try {
        await this.validateBid(client, lot, input, request.origin, request.requestedAmountCents);
        await this.acceptRequestLocked(client, lot, request.id, request.requestedAmountCents, request.origin, phase, input, undefined);
        return 'ACCEPTED';
      } catch (error) {
        if (!isDomainError(error)) throw error;
        const rejected = this.rejectedResult(request.id, lot, phase, error.code);
        await client.bidRequest.update({ where: { id: request.id }, data: { status: 'REJECTED', errorCode: error.code, result: rejected as unknown as Prisma.InputJsonValue, completedAt: new Date() } });
        await appendDomainEvent(client, {
          eventType: 'bid.rejected', routingKey: 'bid.rejected', aggregateType: 'bid_request', aggregateId: request.id,
          auctionId: lot.auctionId, lotId: lot.id, correlationId, actorId,
          payload: { bidRequestId: request.id, lotId: lot.id, externalLotId: lot.externalLotId, code: error.code }, writeEventLog: false,
        });
        return 'REJECTED';
      }
    });
  }

  private async saveManagerMutation(client: PrismaTransaction, actorId: string, idempotencyKey: string, action: string, bidId: string, expectedVersion: bigint | undefined, result: BidManagementResult, payload: Record<string, unknown>): Promise<void> {
    try {
      await client.managerAction.create({ data: { actorId, action, targetType: 'effective_bid', targetId: bidId, idempotencyKey, expectedVersion, payload: payload as Prisma.InputJsonValue, result: result as unknown as Prisma.InputJsonValue } });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    }
  }

  private currentIncrementCents(lot: LockedLot): string {
    return activeIncrementCents({
      incrementCents: lot.incrementCents,
      secondaryIncrementCents: lot.secondaryIncrementCents,
      nextIncrementIsSecondary: lot.nextIncrementIsSecondary,
    }).toString();
  }

  private nextBidCents(lot: LockedLot): string {
    return calculateNextBidCents(lot.currentPriceCents, lot.startingBidCents, {
      incrementCents: lot.incrementCents,
      secondaryIncrementCents: lot.secondaryIncrementCents,
      nextIncrementIsSecondary: lot.nextIncrementIsSecondary,
    }).toString();
  }

  private async recalculateIncrementState(client: PrismaTransaction, lot: LockedLot): Promise<boolean> {
    const bids = await client.effectiveBid.findMany({
      where: { lotId: lot.id, voidedAt: null },
      orderBy: { lotSequence: 'asc' },
      select: { amountCents: true },
    });
    let nextIncrementIsSecondary = false;
    let previousPriceCents: bigint | null = null;
    const opening = openingBidCents(lot.startingBidCents, lot.incrementCents);
    for (const bid of bids) {
      if (previousPriceCents === null) {
        if (bid.amountCents > opening) nextIncrementIsSecondary = true;
      } else if (bid.amountCents > previousPriceCents) {
        nextIncrementIsSecondary = !nextIncrementIsSecondary;
      }
      previousPriceCents = bid.amountCents;
    }
    return nextIncrementIsSecondary;
  }

  async listPendingApprovals(auctionId: string, lotId?: string, limit = 100): Promise<{ items: PendingBidApproval[]; hasMore: boolean }> {
    if (!BID_APPROVAL_FEATURE_ENABLED) return { items: [], hasMore: false };
    const rows = await this.database.prisma.bidRequest.findMany({
      where: { status: 'PENDING_APPROVAL', lot: { auctionId, ...(lotId ? { id: lotId } : {}) } },
      include: { lot: { select: { externalLotId: true, lotNumber: true, title: true } } },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    return {
      hasMore: rows.length > limit,
      items: rows.slice(0, limit).map((row) => ({
        bidRequestId: row.id,
        lotId: row.lotId,
        externalLotId: row.lot.externalLotId,
        lotNumber: row.lot.lotNumber,
        lotTitle: row.lot.title,
        participantId: row.userId,
        displayName: row.displayName,
        amountCents: row.requestedAmountCents.toString(),
        origin: row.origin,
        phase: row.phase as BidPhase | null,
        status: 'PENDING_APPROVAL',
        receivedAt: row.receivedAt.toISOString(),
      })),
    };
  }

  private async saveManagerBidAction(client: PrismaTransaction, actorId: string, idempotencyKey: string, action: string, bidRequestId: string, result: BidCommandResult, payload: Record<string, unknown> = {}): Promise<void> {
    try {
      await client.managerAction.create({ data: { actorId, action, targetType: 'bid_request', targetId: bidRequestId, idempotencyKey, payload: payload as Prisma.InputJsonValue, result: result as unknown as Prisma.InputJsonValue } });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    }
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

  private async validateBid(
    client: PrismaTransaction,
    lot: LockedLot,
    input: PlaceBidInput,
    origin: BidOrigin,
    amountCents: bigint,
    allowUnapprovedRegistration = false,
  ): Promise<void> {
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
    if (!allowUnapprovedRegistration) {
      const registration = await client.auctionRegistration.findUnique({ where: { auctionId_userId: { auctionId: lot.auctionId, userId: input.userId } } });
      if (registration?.status !== 'APPROVED') throw new DomainError('REGISTRATION_REQUIRED', 'Participant is not approved for this auction', 403);
    }
    if (amountCents <= 0n) throw new DomainError('INVALID_AMOUNT', 'Bid must be positive', 422);
  }

  private async ensureManagerRegistration(client: PrismaTransaction, lot: LockedLot, input: PlaceBidInput): Promise<void> {
    const existing = await client.auctionRegistration.findUnique({ where: { auctionId_userId: { auctionId: lot.auctionId, userId: input.userId } } });
    if (existing?.status === 'APPROVED') return;

    const registration = existing
      ? await client.auctionRegistration.update({ where: { id: existing.id }, data: { status: 'APPROVED' } })
      : await client.auctionRegistration.create({ data: { auctionId: lot.auctionId, userId: input.userId, status: 'APPROVED', termsVersion: lot.auction.regulationVersion } });

    await appendDomainEvent(client, {
      eventType: 'registration.approved',
      routingKey: 'registration.approved',
      aggregateType: 'auction_registration',
      aggregateId: registration.id,
      auctionId: lot.auctionId,
      lotId: lot.id,
      correlationId: input.correlationId,
      causationId: input.idempotencyKey,
      actorId: input.actorId,
      payload: {
        registrationId: registration.id,
        auctionId: lot.auctionId,
        userId: input.userId,
        termsVersion: registration.termsVersion,
        source: 'manager-floor-bid',
      },
      writeEventLog: false,
    });
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
    const incrementCents = activeIncrementCents({
      incrementCents: lot.incrementCents,
      secondaryIncrementCents: lot.secondaryIncrementCents,
      nextIncrementIsSecondary: lot.nextIncrementIsSecondary,
    });
    const evaluation = evaluateProxyBid({ entries, candidate: { userId: input.userId, displayName: input.displayName, maxBidCents: amountCents, origin, acceptedSequence: nextSequence, intentId: intent.id }, currentPriceCents: lot.currentPriceCents, currentBidderId: lot.currentBidderId, startingBidCents: lot.startingBidCents, incrementCents });
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
    const nextIncrementIsSecondary = priceChanged
      ? advanceIncrementState({
          currentPriceCents: lot.currentPriceCents,
          startingBidCents: lot.startingBidCents,
          incrementCents: lot.incrementCents,
          acceptedPriceCents: effectivePriceCents,
          nextIncrementIsSecondary: lot.nextIncrementIsSecondary,
        })
      : lot.nextIncrementIsSecondary;
    const nextIncrement = activeIncrementCents({
      incrementCents: lot.incrementCents,
      secondaryIncrementCents: lot.secondaryIncrementCents,
      nextIncrementIsSecondary,
    });
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
      nextIncrementIsSecondary,
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
      currentPriceCents: effectivePriceCents.toString(), currentIncrementCents: nextIncrement.toString(), nextBidCents: (effectivePriceCents + nextIncrement).toString(), currentBidderAlias: participantAlias(lot.auctionId, evaluation.leader.userId, evaluation.leader.displayName), currentBidderName: evaluation.leader.displayName ?? null,
      phase, acceptedAt: acceptedAt.toISOString(), endsAt: endsAt?.toISOString() ?? null, serverTime: acceptedAt.toISOString(),
      ...(origin === 'PROXY' ? { proxyMaxBidCents: amountCents.toString() } : {}),
      ...(effectiveBidId ? { effectiveBidId } : {}), ...(timerExtended ? { timerExtended: true } : {}),
    };
    await client.bidRequest.update({ where: { id: bidRequestId }, data: { status: 'ACCEPTED', result: result as unknown as Prisma.InputJsonValue, completedAt: acceptedAt } });
    const publicBidderAlias = participantAlias(lot.auctionId, evaluation.leader.userId);
    await appendDomainEvent(client, {
      eventType: 'bid.accepted', routingKey: 'bid.accepted', aggregateType: 'auction_lot_execution', aggregateId: lot.id,
      auctionId: lot.auctionId, lotId: lot.id, aggregateVersion: newVersion, lotSequence: nextSequence,
      correlationId: input.correlationId, causationId: bidRequestId, actorId: approvalActorId ?? input.actorId,
      payload: { bidRequestId, lotId: lot.id, externalLotId: lot.externalLotId, lotSequence: nextSequence.toString(), version: newVersion.toString(), currentPriceCents: effectivePriceCents.toString(), currentIncrementCents: nextIncrement.toString(), nextBidCents: (effectivePriceCents + nextIncrement).toString(), currentBidderAlias: publicBidderAlias, currentBidderName: null, bidOrigin: evaluation.leader.origin, phase, acceptedAt: acceptedAt.toISOString(), endsAt: endsAt?.toISOString() ?? null, timerExtended, serverTime: result.serverTime },
    });
    return result;
  }

  private pendingResult(requestId: string, lot: LockedLot, phase: BidPhase, receivedAt: string): BidCommandResult {
    return { status: 'PENDING_APPROVAL', bidRequestId: requestId, lotId: lot.id, phase, receivedAt, lotSequence: lot.lotSequence.toString(), version: lot.version.toString(), currentPriceCents: lot.currentPriceCents?.toString() ?? null, currentIncrementCents: this.currentIncrementCents(lot), nextBidCents: this.nextBidCents(lot), currentBidderAlias: lot.currentBidderAlias, endsAt: lot.endsAt?.toISOString() ?? null, serverTime: new Date().toISOString() };
  }

  private pendingEligibilityResult(requestId: string, lot: LockedLot, phase: BidPhase, receivedAt: string): BidCommandResult {
    return { status: 'PENDING_ELIGIBILITY', bidRequestId: requestId, lotId: lot.id, phase, receivedAt, lotSequence: lot.lotSequence.toString(), version: lot.version.toString(), currentPriceCents: lot.currentPriceCents?.toString() ?? null, currentIncrementCents: this.currentIncrementCents(lot), nextBidCents: this.nextBidCents(lot), currentBidderAlias: lot.currentBidderAlias, endsAt: lot.endsAt?.toISOString() ?? null, serverTime: new Date().toISOString() };
  }

  private rejectedResult(requestId: string, lot: LockedLot, phase: BidPhase, code: string): BidCommandResult {
    return { status: 'REJECTED', bidRequestId: requestId, lotId: lot.id, phase, lotSequence: lot.lotSequence.toString(), version: lot.version.toString(), currentPriceCents: lot.currentPriceCents?.toString() ?? null, currentIncrementCents: this.currentIncrementCents(lot), nextBidCents: this.nextBidCents(lot), currentBidderAlias: lot.currentBidderAlias, endsAt: lot.endsAt?.toISOString() ?? null, serverTime: new Date().toISOString(), errorCode: code };
  }

  private phaseFor(lot: LockedLot): BidPhase {
    return isPreBidWindow(lot.auction.mode, lot.auction.status, lot.auction.preBidEnabled) ? 'PRE_BID' : 'LIVE_BID';
  }

  private async loadClosedResult(client: PrismaTransaction, lot: LockedLot): Promise<Record<string, unknown>> {
    const award = await client.winnerAward.findUnique({ where: { lotId: lot.id }, include: { settlement: true } });
    return { lotId: lot.id, status: lot.status, lotSequence: lot.lotSequence.toString(), version: lot.version.toString(), currentPriceCents: lot.currentPriceCents?.toString() ?? null, currentBidderAlias: lot.currentBidderAlias, awardId: award?.id ?? null, settlementId: award?.settlement?.id ?? null };
  }
}

export function storedBidPhase(phase: BidPhase | null | undefined): BidPhase {
  if (phase === 'PRE_BID' || phase === 'LIVE_BID') return phase;
  throw new DomainError('BID_PHASE_MISSING', 'Historical bid phase is missing', 409);
}
