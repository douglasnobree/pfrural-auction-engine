import { Database } from '../../infrastructure/database/db.js';
import { asBigInt, asDate } from '../../infrastructure/database/rows.js';
import { DomainError } from '../../domain/errors.js';
import { centsToJson } from '../../domain/money.js';
import { participantAlias } from '../../domain/identity.js';
import { activeIncrementCents, nextBidCents } from '../../domain/bid-increment.js';

function publicBidderAlias(auctionId: string, userId: string | null): string | null {
  return userId ? participantAlias(auctionId, userId) : null;
}

function sanitizePublicEventPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...payload };
  if ('currentBidderName' in sanitized) sanitized.currentBidderName = null;
  if ('winnerName' in sanitized && typeof sanitized.winnerName === 'string') sanitized.winnerName = null;
  if (
    typeof sanitized.currentBidderAlias === 'string' &&
    !/^Participante [A-F0-9]{6}$/.test(sanitized.currentBidderAlias)
  ) {
    sanitized.currentBidderAlias = 'Participante';
  }
  return sanitized;
}

export class AuctionQueryService {
  constructor(private readonly database: Database) {}

  async getAuctionSnapshot(auctionId: string): Promise<Record<string, unknown>> {
    const auction = await this.database.prisma.auctionExecution.findUnique({ where: { id: auctionId }, include: { lots: { orderBy: { lotNumber: 'asc' }, include: { winnerAward: true } } } });
    if (!auction) throw new DomainError('AUCTION_NOT_FOUND', 'Auction not found', 404);
    const stream = await this.database.prisma.streamSession.findFirst({ where: { auctionId }, orderBy: { createdAt: 'desc' } });
    const serverTime = new Date().toISOString();
    return {
      auction: {
        id: auction.id, externalId: auction.externalAuctionId, title: auction.title, mode: auction.mode, status: auction.status,
        currency: auction.currency.trim(), regulationVersion: auction.regulationVersion, approvalMode: 'AUTOMATIC',
        preBidEnabled: auction.preBidEnabled, preBidStartsAt: asDate(auction.preBidStartsAt)?.toISOString() ?? null, preBidEndsAt: asDate(auction.preBidEndsAt)?.toISOString() ?? null,
        version: asBigInt(auction.version).toString(), startsAt: asDate(auction.startsAt)?.toISOString() ?? null, endsAt: asDate(auction.endsAt)?.toISOString() ?? null,
      },
      serverTime,
      stream: stream ? {
        id: stream.id,
        provider: stream.provider,
        playbackUrl: stream.playbackUrl,
        providerStreamId: stream.providerStreamId,
        status: stream.status,
        version: asBigInt(stream.version).toString(),
        updatedAt: stream.updatedAt.toISOString(),
      } : null,
      lots: auction.lots.map((lot) => ({
        id: lot.id, externalId: lot.externalLotId, lotNumber: lot.lotNumber, title: lot.title, status: lot.status,
        startingBidCents: asBigInt(lot.startingBidCents).toString(), incrementCents: asBigInt(lot.incrementCents).toString(), secondaryIncrementCents: lot.secondaryIncrementCents == null ? null : asBigInt(lot.secondaryIncrementCents).toString(),
        currentIncrementCents: activeIncrementCents({ incrementCents: asBigInt(lot.incrementCents), secondaryIncrementCents: lot.secondaryIncrementCents == null ? null : asBigInt(lot.secondaryIncrementCents), nextIncrementIsSecondary: lot.nextIncrementIsSecondary }).toString(),
        fixedPriceCents: lot.fixedPriceCents === null ? null : asBigInt(lot.fixedPriceCents).toString(),
        quantity: lot.quantity, availableQuantity: lot.availableQuantity,
        startsAt: asDate(lot.startsAt)?.toISOString() ?? null, endsAt: asDate(lot.endsAt)?.toISOString() ?? null,
        currentPriceCents: centsToJson(lot.currentPriceCents === null ? null : asBigInt(lot.currentPriceCents)),
        nextBidCents: nextBidCents(lot.currentPriceCents === null ? null : asBigInt(lot.currentPriceCents), asBigInt(lot.startingBidCents), { incrementCents: asBigInt(lot.incrementCents), secondaryIncrementCents: lot.secondaryIncrementCents == null ? null : asBigInt(lot.secondaryIncrementCents), nextIncrementIsSecondary: lot.nextIncrementIsSecondary }).toString(),
        currentBidderAlias: publicBidderAlias(auction.id, lot.currentBidderId),
        currentBidderName: null,
        winnerName: lot.winnerAward ? publicBidderAlias(auction.id, lot.currentBidderId) : null,
        winningAmountCents: lot.winnerAward ? lot.winnerAward.winningAmountCents.toString() : null,
        closedAt: ['SOLD', 'UNSOLD', 'CANCELLED'].includes(lot.status) ? lot.updatedAt.toISOString() : null,
        lotSequence: asBigInt(lot.lotSequence).toString(), version: asBigInt(lot.version).toString(),
      })),
    };
  }

  async getAuctionSnapshotByExternalId(externalAuctionId: string): Promise<Record<string, unknown>> {
    const auction = await this.database.prisma.auctionExecution.findUnique({ where: { externalAuctionId }, select: { id: true } });
    if (!auction) throw new DomainError('AUCTION_NOT_FOUND', 'Auction not found', 404);
    return this.getAuctionSnapshot(auction.id);
  }

  async getLotByExternalId(externalAuctionId: string, externalLotId: string): Promise<{ id: string; auctionId: string; mode: string; status: string; currentPriceCents: string | null; currentBidderAlias: string | null; currentBidderName: string | null; winnerName: string | null; winningAmountCents: string | null; lotSequence: string; version: string; endsAt: string | null }> {
    const lot = await this.database.prisma.auctionLotExecution.findFirst({ where: { externalLotId, auction: { externalAuctionId } }, include: { auction: true, winnerAward: true } });
    if (!lot) throw new DomainError('LOT_NOT_FOUND', 'Lot not found', 404);
    const bidderAlias = publicBidderAlias(lot.auctionId, lot.currentBidderId);
    return { id: lot.id, auctionId: lot.auctionId, mode: lot.auction.mode, status: lot.status, currentPriceCents: lot.currentPriceCents?.toString() ?? null, currentBidderAlias: bidderAlias, currentBidderName: null, winnerName: lot.winnerAward ? bidderAlias : null, winningAmountCents: lot.winnerAward?.winningAmountCents.toString() ?? null, lotSequence: lot.lotSequence.toString(), version: lot.version.toString(), endsAt: lot.endsAt?.toISOString() ?? null };
  }

  async getLot(lotId: string): Promise<{ id: string; auctionId: string; mode: string; status: string; currentPriceCents: string | null; currentBidderAlias: string | null; currentBidderName: string | null; winnerName: string | null; winningAmountCents: string | null; lotSequence: string; version: string; endsAt: string | null }> {
    const lot = await this.database.prisma.auctionLotExecution.findUnique({ where: { id: lotId }, include: { auction: true, winnerAward: true } });
    if (!lot) throw new DomainError('LOT_NOT_FOUND', 'Lot not found', 404);
    return {
      id: lot.id, auctionId: lot.auctionId, mode: lot.auction.mode, status: lot.status,
      currentPriceCents: lot.currentPriceCents === null ? null : asBigInt(lot.currentPriceCents).toString(),
      currentBidderAlias: publicBidderAlias(lot.auctionId, lot.currentBidderId), lotSequence: asBigInt(lot.lotSequence).toString(), version: asBigInt(lot.version).toString(),
      currentBidderName: null,
      winnerName: lot.winnerAward ? publicBidderAlias(lot.auctionId, lot.currentBidderId) : null,
      winningAmountCents: lot.winnerAward?.winningAmountCents.toString() ?? null,
      endsAt: lot.endsAt?.toISOString() ?? null,
    };
  }

  async getEvents(lotId: string, since: bigint, limit = 500): Promise<Array<Record<string, unknown>>> {
    const result = await this.database.prisma.auctionEventLog.findMany({ where: { lotId, lotSequence: { gt: since } }, orderBy: { lotSequence: 'asc' }, take: limit });
    return result.map((row) => ({ ...sanitizePublicEventPayload(row.payload as Record<string, unknown>), lotSequence: row.lotSequence?.toString() ?? null }));
  }

  async getAuctionIdForLot(lotId: string): Promise<string> {
    const auctionId = (await this.database.prisma.auctionLotExecution.findUnique({ where: { id: lotId }, select: { auctionId: true } }))?.auctionId;
    if (!auctionId) throw new DomainError('LOT_NOT_FOUND', 'Lot not found', 404);
    return auctionId;
  }

  participantAlias(auctionId: string, userId: string): string {
    return participantAlias(auctionId, userId);
  }
}
