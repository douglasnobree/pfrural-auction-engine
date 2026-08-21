import { Database } from '../../infrastructure/database/db.js';
import { asBigInt, asDate } from '../../infrastructure/database/rows.js';
import { DomainError } from '../../domain/errors.js';
import { centsToJson } from '../../domain/money.js';
import { participantAlias, readableParticipantName } from '../../domain/identity.js';
import { activeIncrementCents, nextBidCents } from '../../domain/bid-increment.js';

type BidderProjection = {
  currentBidderId: string | null;
  currentBidderAlias: string | null;
  effectiveBids?: Array<{
    userId: string;
    bidIntent: { displayName: string | null };
  }>;
}

function currentBidderName(lot: BidderProjection): string | null {
  const latestBid = lot.effectiveBids?.[0];
  if (latestBid?.userId === lot.currentBidderId) {
    const latestName = readableParticipantName(latestBid.bidIntent.displayName);
    if (latestName) return latestName;
  }

  return readableParticipantName(lot.currentBidderAlias);
}

function currentBidderAlias(auctionId: string, lot: BidderProjection, name: string | null): string | null {
  return lot.currentBidderId
    ? participantAlias(auctionId, lot.currentBidderId, name ?? lot.currentBidderAlias)
    : null;
}

function normalizePublicEventPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...payload };
  const name = readableParticipantName(
    typeof normalized.currentBidderName === 'string'
      ? normalized.currentBidderName
      : typeof normalized.currentBidderAlias === 'string'
        ? normalized.currentBidderAlias
        : null,
  );

  if ('currentBidderName' in normalized) normalized.currentBidderName = name;
  if ('winnerName' in normalized && typeof normalized.winnerName === 'string') {
    normalized.winnerName = readableParticipantName(normalized.winnerName);
  }
  return normalized;
}

export class AuctionQueryService {
  constructor(private readonly database: Database) {}

  async getAuctionSnapshot(auctionId: string): Promise<Record<string, unknown>> {
    const auction = await this.database.prisma.auctionExecution.findUnique({ where: { id: auctionId }, include: { lots: { orderBy: { lotNumber: 'asc' }, include: { winnerAward: true, effectiveBids: { where: { voidedAt: null }, orderBy: { lotSequence: 'desc' }, take: 1, include: { bidIntent: { select: { displayName: true } } } } } } } });
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
        ...(() => {
          const name = currentBidderName(lot);
          return {
            currentBidderAlias: currentBidderAlias(auction.id, lot, name),
            currentBidderName: name,
            winnerName: lot.winnerAward ? name : null,
          };
        })(),
        id: lot.id, externalId: lot.externalLotId, lotNumber: lot.lotNumber, title: lot.title, status: lot.status,
        startingBidCents: asBigInt(lot.startingBidCents).toString(), incrementCents: asBigInt(lot.incrementCents).toString(), secondaryIncrementCents: lot.secondaryIncrementCents == null ? null : asBigInt(lot.secondaryIncrementCents).toString(),
        currentIncrementCents: activeIncrementCents({ incrementCents: asBigInt(lot.incrementCents), secondaryIncrementCents: lot.secondaryIncrementCents == null ? null : asBigInt(lot.secondaryIncrementCents), nextIncrementIsSecondary: lot.nextIncrementIsSecondary }).toString(),
        fixedPriceCents: lot.fixedPriceCents === null ? null : asBigInt(lot.fixedPriceCents).toString(),
        quantity: lot.quantity, availableQuantity: lot.availableQuantity,
        startsAt: asDate(lot.startsAt)?.toISOString() ?? null, endsAt: asDate(lot.endsAt)?.toISOString() ?? null,
        currentPriceCents: centsToJson(lot.currentPriceCents === null ? null : asBigInt(lot.currentPriceCents)),
        nextBidCents: nextBidCents(lot.currentPriceCents === null ? null : asBigInt(lot.currentPriceCents), asBigInt(lot.startingBidCents), { incrementCents: asBigInt(lot.incrementCents), secondaryIncrementCents: lot.secondaryIncrementCents == null ? null : asBigInt(lot.secondaryIncrementCents), nextIncrementIsSecondary: lot.nextIncrementIsSecondary }).toString(),
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
    const lot = await this.database.prisma.auctionLotExecution.findFirst({ where: { externalLotId, auction: { externalAuctionId } }, include: { auction: true, winnerAward: true, effectiveBids: { where: { voidedAt: null }, orderBy: { lotSequence: 'desc' }, take: 1, include: { bidIntent: { select: { displayName: true } } } } } });
    if (!lot) throw new DomainError('LOT_NOT_FOUND', 'Lot not found', 404);
    const name = currentBidderName(lot);
    const bidderAlias = currentBidderAlias(lot.auctionId, lot, name);
    return { id: lot.id, auctionId: lot.auctionId, mode: lot.auction.mode, status: lot.status, currentPriceCents: lot.currentPriceCents?.toString() ?? null, currentBidderAlias: bidderAlias, currentBidderName: name, winnerName: lot.winnerAward ? name : null, winningAmountCents: lot.winnerAward?.winningAmountCents.toString() ?? null, lotSequence: lot.lotSequence.toString(), version: lot.version.toString(), endsAt: lot.endsAt?.toISOString() ?? null };
  }

  async getLot(lotId: string): Promise<{ id: string; auctionId: string; mode: string; status: string; currentPriceCents: string | null; currentBidderAlias: string | null; currentBidderName: string | null; winnerName: string | null; winningAmountCents: string | null; lotSequence: string; version: string; endsAt: string | null }> {
    const lot = await this.database.prisma.auctionLotExecution.findUnique({ where: { id: lotId }, include: { auction: true, winnerAward: true, effectiveBids: { where: { voidedAt: null }, orderBy: { lotSequence: 'desc' }, take: 1, include: { bidIntent: { select: { displayName: true } } } } } });
    if (!lot) throw new DomainError('LOT_NOT_FOUND', 'Lot not found', 404);
    const name = currentBidderName(lot);
    return {
      id: lot.id, auctionId: lot.auctionId, mode: lot.auction.mode, status: lot.status,
      currentPriceCents: lot.currentPriceCents === null ? null : asBigInt(lot.currentPriceCents).toString(),
      currentBidderAlias: currentBidderAlias(lot.auctionId, lot, name), lotSequence: asBigInt(lot.lotSequence).toString(), version: asBigInt(lot.version).toString(),
      currentBidderName: name,
      winnerName: lot.winnerAward ? name : null,
      winningAmountCents: lot.winnerAward?.winningAmountCents.toString() ?? null,
      endsAt: lot.endsAt?.toISOString() ?? null,
    };
  }

  async getEvents(lotId: string, since: bigint, limit = 500): Promise<Array<Record<string, unknown>>> {
    const result = await this.database.prisma.auctionEventLog.findMany({ where: { lotId, lotSequence: { gt: since } }, orderBy: { lotSequence: 'asc' }, take: limit });
    return result.map((row) => ({ ...normalizePublicEventPayload(row.payload as Record<string, unknown>), lotSequence: row.lotSequence?.toString() ?? null }));
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
