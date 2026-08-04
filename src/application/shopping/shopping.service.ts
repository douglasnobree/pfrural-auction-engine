import { Prisma } from '@prisma/client';
import { Database } from '../../infrastructure/database/db.js';
import { appendDomainEvent } from '../../infrastructure/events/envelope.js';
import { DomainError } from '../../domain/errors.js';

export class ShoppingService {
  constructor(private readonly database: Database) {}

  async reserve(lotId: string, userId: string, quantity: number, idempotencyKey: string, correlationId: string): Promise<Record<string, unknown>> {
    if (!Number.isInteger(quantity) || quantity < 1) throw new DomainError('INVALID_QUANTITY', 'quantity must be a positive integer', 400);
    return this.database.transaction(async (client) => {
      const existing = await client.shoppingReservation.findFirst({ where: { lotId, userId, idempotencyKey } });
      if (existing) return { reservationId: existing.id, lotId, quantity: existing.quantity, status: existing.status, expiresAt: existing.expiresAt.toISOString() };
      await client.$queryRaw`SELECT id FROM auction_lot_execution WHERE id = ${lotId}::uuid FOR UPDATE`;
      const lot = await client.auctionLotExecution.findUnique({ where: { id: lotId }, include: { auction: true } });
      if (!lot) throw new DomainError('LOT_NOT_FOUND', 'Lot not found', 404);
      if (lot.auction.mode !== 'SHOPPING') throw new DomainError('WRONG_AUCTION_MODE', 'Lot is not a shopping lot', 422);
      if (lot.status !== 'OPEN') throw new DomainError('LOT_NOT_OPEN', 'Shopping lot is not open', 409);
      if (lot.fixedPriceCents === null) throw new DomainError('FIXED_PRICE_REQUIRED', 'Shopping lot has no fixed price', 422);
      if (lot.availableQuantity < quantity) throw new DomainError('INSUFFICIENT_QUANTITY', 'Requested quantity is not available', 409);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
      let reservation;
      try {
        reservation = await client.shoppingReservation.create({ data: { lotId, userId, idempotencyKey, quantity, expiresAt } });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
        const concurrent = await client.shoppingReservation.findFirst({ where: { lotId, userId, idempotencyKey } });
        if (!concurrent) throw error;
        return { reservationId: concurrent.id, lotId, quantity: concurrent.quantity, status: concurrent.status, expiresAt: concurrent.expiresAt.toISOString() };
      }
      await client.auctionLotExecution.update({ where: { id: lotId }, data: { availableQuantity: { decrement: quantity } } });
      const response = { reservationId: reservation.id, lotId, quantity, status: reservation.status, priceCents: lot.fixedPriceCents.toString(), expiresAt: expiresAt.toISOString(), serverTime: new Date().toISOString() };
      await appendDomainEvent(client, { eventType: 'shopping.reserved', routingKey: 'shopping.reserved', aggregateType: 'shopping_reservation', aggregateId: reservation.id, auctionId: lot.auctionId, lotId, correlationId, payload: response });
      return response;
    });
  }
}
