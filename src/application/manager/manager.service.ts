import { Prisma, StreamStatus } from '@prisma/client';
import type { PrismaTransaction } from '../../infrastructure/database/db.js';
import { Database } from '../../infrastructure/database/db.js';
import { appendDomainEvent } from '../../infrastructure/events/envelope.js';
import { DomainError } from '../../domain/errors.js';
import { assertAuctionTransition, assertLotTransition } from '../../domain/state-machine.js';
import type { AuctionStatus, LotStatus } from '../../domain/types.js';
import { BiddingService } from '../bidding/bidding.service.js';

export class ManagerService {
  constructor(private readonly database: Database, private readonly bidding: BiddingService) {}

  async auctionCommand(auctionId: string, action: 'start' | 'pause' | 'resume' | 'finish', actorId: string, idempotencyKey: string, expectedVersion: bigint | undefined, correlationId: string): Promise<Record<string, unknown>> {
    const target: Record<typeof action, AuctionStatus> = { start: 'RUNNING', pause: 'PAUSED', resume: 'RUNNING', finish: 'FINISHED' };
    if (action === 'finish') await this.closeScheduledPreBidLots(auctionId, actorId, correlationId);
    return this.database.transaction(async (client) => {
      const saved = await this.findAction(client, actorId, idempotencyKey);
      if (saved) return saved;
      await client.$queryRaw`SELECT id FROM auction_execution WHERE id = ${auctionId}::uuid FOR UPDATE`;
      const auction = await client.auctionExecution.findUnique({ where: { id: auctionId } });
      if (!auction) throw new DomainError('AUCTION_NOT_FOUND', 'Auction not found', 404);
      if (expectedVersion !== undefined && expectedVersion !== auction.version) throw new DomainError('VERSION_CONFLICT', 'Auction version is stale', 409, { currentVersion: auction.version.toString() });
      assertAuctionTransition(auction.status, target[action], auction.mode);
      const version = auction.version + 1n;
      await client.auctionExecution.update({ where: { id: auctionId }, data: { status: target[action], version } });
      const response = { auctionId, externalAuctionId: auction.externalAuctionId, status: target[action], version: version.toString(), serverTime: new Date().toISOString() };
      await this.saveAction(client, actorId, action, 'auction', auctionId, idempotencyKey, expectedVersion, response);
      const eventName = action === 'start' ? 'started' : action === 'finish' ? 'closed' : action === 'resume' ? 'resumed' : 'paused';
      await appendDomainEvent(client, { eventType: `auction.${eventName}`, routingKey: `auction.${eventName}`, aggregateType: 'auction_execution', aggregateId: auctionId, auctionId, aggregateVersion: version, correlationId, actorId, payload: response, writeEventLog: false });
      return response;
    });
  }

  private async closeScheduledPreBidLots(auctionId: string, actorId: string, correlationId: string): Promise<void> {
    const auction = await this.database.prisma.auctionExecution.findUnique({ where: { id: auctionId }, select: { mode: true, status: true } });
    if (!auction || auction.mode === 'LIVE' || auction.status !== 'SCHEDULED') return;
    const lots = await this.database.prisma.auctionLotExecution.findMany({ where: { auctionId, status: { in: ['OPEN', 'PAUSED', 'CLOSING'] } }, select: { id: true } });
    for (const lot of lots) await this.bidding.closeLot(lot.id, correlationId, actorId);
  }

  async lotCommand(lotId: string, action: 'open' | 'pause' | 'resume' | 'announce' | 'withdraw', actorId: string, idempotencyKey: string, expectedVersion: bigint | undefined, correlationId: string): Promise<Record<string, unknown>> {
    if (action === 'announce') return this.recordLotAnnouncement(lotId, actorId, idempotencyKey, correlationId);
    return this.database.transaction(async (client) => {
      const saved = await this.findAction(client, actorId, idempotencyKey);
      if (saved) return saved;
      await client.$queryRaw`SELECT id FROM auction_lot_execution WHERE id = ${lotId}::uuid FOR UPDATE`;
      const lot = await client.auctionLotExecution.findUnique({ where: { id: lotId } });
      if (!lot) throw new DomainError('LOT_NOT_FOUND', 'Lot not found', 404);
      if (expectedVersion !== undefined && expectedVersion !== lot.version) throw new DomainError('VERSION_CONFLICT', 'Lot version is stale', 409, { currentVersion: lot.version.toString() });
      const status: LotStatus = action === 'open' ? 'OPEN' : action === 'pause' ? 'PAUSED' : action === 'resume' ? 'OPEN' : 'CANCELLED';
      assertLotTransition(lot.status, status);
      const version = lot.version + 1n;
      const lotSequence = lot.lotSequence + 1n;
      const openingNow = status === 'OPEN' && lot.status !== 'OPEN';
      const openingTime = new Date();
      await client.auctionLotExecution.update({
        where: { id: lotId },
        data: {
          status,
          version,
          lotSequence,
          ...(openingNow && (!lot.startsAt || lot.startsAt > openingTime) ? { startsAt: openingTime } : {}),
          ...(openingNow && (!lot.endsAt || lot.endsAt <= openingTime) ? { endsAt: new Date(openingTime.getTime() + 30 * 60 * 1000) } : {}),
        },
      });
      const response = {
        lotId,
        externalLotId: lot.externalLotId,
        status,
        version: version.toString(),
        lotSequence: lotSequence.toString(),
        startsAt: openingNow && (!lot.startsAt || lot.startsAt > openingTime) ? openingTime.toISOString() : lot.startsAt?.toISOString() ?? null,
        endsAt: openingNow && (!lot.endsAt || lot.endsAt <= openingTime) ? new Date(openingTime.getTime() + 30 * 60 * 1000).toISOString() : lot.endsAt?.toISOString() ?? null,
        serverTime: new Date().toISOString(),
      };
      await this.saveAction(client, actorId, action, 'lot', lotId, idempotencyKey, expectedVersion, response);
      const eventName = action === 'withdraw' ? 'withdrawn' : action === 'open' ? 'opened' : action === 'resume' ? 'resumed' : 'paused';
      await appendDomainEvent(client, { eventType: `lot.${eventName}`, routingKey: `lot.${eventName}`, aggregateType: 'auction_lot_execution', aggregateId: lotId, auctionId: lot.auctionId, lotId, aggregateVersion: version, lotSequence, correlationId, actorId, payload: response });
      return response;
    });
  }

  async sellLot(lotId: string, actorId: string, idempotencyKey: string, expectedVersion: bigint | undefined, correlationId: string): Promise<Record<string, unknown>> {
    const saved = await this.database.prisma.managerAction.findUnique({ where: { actorId_idempotencyKey: { actorId, idempotencyKey } } });
    if (saved?.result) return saved.result as Record<string, unknown>;
    const lot = await this.bidding.closeLot(lotId, correlationId, actorId, expectedVersion);
    try {
      await this.database.prisma.managerAction.create({ data: { actorId, action: 'sell', targetType: 'lot', targetId: lotId, idempotencyKey, expectedVersion, result: lot as Prisma.InputJsonValue } });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    }
    return lot;
  }

  async recordLotAnnouncement(lotId: string, actorId: string, idempotencyKey: string, correlationId: string): Promise<Record<string, unknown>> {
    return this.database.transaction(async (client) => {
      const saved = await this.findAction(client, actorId, idempotencyKey);
      if (saved) return saved;
      await client.$queryRaw`SELECT id FROM auction_lot_execution WHERE id = ${lotId}::uuid FOR UPDATE`;
      const lot = await client.auctionLotExecution.findUnique({ where: { id: lotId } });
      if (!lot) throw new DomainError('LOT_NOT_FOUND', 'Lot not found', 404);
      const response = { lotId, action: 'announce', version: lot.version.toString(), serverTime: new Date().toISOString() };
      await this.saveAction(client, actorId, 'announce', 'lot', lotId, idempotencyKey, undefined, response);
      await appendDomainEvent(client, { eventType: 'lot.announced', routingKey: 'lot.announced', aggregateType: 'auction_lot_execution', aggregateId: lotId, auctionId: lot.auctionId, lotId, correlationId, actorId, payload: response, writeEventLog: false });
      return response;
    });
  }

  async setCurrentLot(auctionId: string, lotId: string, actorId: string, idempotencyKey: string, expectedVersion: bigint | undefined, correlationId: string): Promise<Record<string, unknown>> {
    return this.database.transaction(async (client) => {
      const saved = await this.findAction(client, actorId, idempotencyKey);
      if (saved) return saved;
      await client.$queryRaw`SELECT id FROM auction_execution WHERE id = ${auctionId}::uuid FOR UPDATE`;
      const auction = await client.auctionExecution.findUnique({ where: { id: auctionId } });
      const lot = await client.auctionLotExecution.findFirst({ where: { id: lotId, auctionId } });
      if (!auction || !lot) throw new DomainError('LOT_NOT_FOUND', 'Auction or lot not found', 404);
      if (expectedVersion !== undefined && expectedVersion !== auction.version) throw new DomainError('VERSION_CONFLICT', 'Auction version is stale', 409);
      const version = auction.version + 1n;
      await client.auctionExecution.update({ where: { id: auctionId }, data: { currentLotId: lotId, version } });
      const response = { auctionId, currentLotId: lotId, version: version.toString(), serverTime: new Date().toISOString() };
      await this.saveAction(client, actorId, 'set-current-lot', 'auction', auctionId, idempotencyKey, expectedVersion, response);
      await appendDomainEvent(client, { eventType: 'auction.current_lot.changed', routingKey: 'auction.current_lot.changed', aggregateType: 'auction_execution', aggregateId: auctionId, auctionId, aggregateVersion: version, correlationId, actorId, payload: response, writeEventLog: false });
      return response;
    });
  }

  async updateStream(auctionId: string, actorId: string, idempotencyKey: string, input: { provider: string; playbackUrl?: string; providerStreamId?: string; status?: string }, expectedVersion: bigint | undefined, correlationId: string): Promise<Record<string, unknown>> {
    return this.database.transaction(async (client) => {
      const saved = await this.findAction(client, actorId, idempotencyKey);
      if (saved) return saved;
      await client.$queryRaw`SELECT id FROM auction_execution WHERE id = ${auctionId}::uuid FOR UPDATE`;
      const auction = await client.auctionExecution.findUnique({ where: { id: auctionId } });
      if (!auction) throw new DomainError('AUCTION_NOT_FOUND', 'Auction not found', 404);
      const current = await client.streamSession.findFirst({ where: { auctionId }, orderBy: { createdAt: 'desc' } });
      const status = (input.status ?? 'CREATED') as StreamStatus;
      if (!Object.values(StreamStatus).includes(status)) throw new DomainError('INVALID_STREAM_STATUS', 'Invalid stream status', 400);
      const stream = current ? await client.streamSession.update({ where: { id: current.id }, data: { provider: input.provider, playbackUrl: input.playbackUrl, providerStreamId: input.providerStreamId, status, version: { increment: 1 } } }) : await client.streamSession.create({ data: { auctionId, provider: input.provider, playbackUrl: input.playbackUrl, providerStreamId: input.providerStreamId, status } });
      const response = { auctionId, streamId: stream.id, provider: stream.provider, playbackUrl: stream.playbackUrl ?? null, status: stream.status, serverTime: new Date().toISOString() };
      await this.saveAction(client, actorId, 'stream', 'auction', auctionId, idempotencyKey, expectedVersion, response);
      await appendDomainEvent(client, { eventType: 'stream.changed', routingKey: 'stream.changed', aggregateType: 'stream_session', aggregateId: stream.id, auctionId, correlationId, actorId, payload: response, writeEventLog: false });
      return response;
    });
  }

  private async findAction(client: PrismaTransaction, actorId: string, idempotencyKey: string): Promise<Record<string, unknown> | null> {
    const action = await client.managerAction.findUnique({ where: { actorId_idempotencyKey: { actorId, idempotencyKey } } });
    return action?.result ? action.result as Record<string, unknown> : null;
  }

  private async saveAction(client: PrismaTransaction, actorId: string, action: string, targetType: string, targetId: string, idempotencyKey: string, expectedVersion: bigint | undefined, result: Record<string, unknown>): Promise<void> {
    await client.managerAction.create({ data: { actorId, action, targetType, targetId, idempotencyKey, expectedVersion, result: result as Prisma.InputJsonValue } });
  }
}
