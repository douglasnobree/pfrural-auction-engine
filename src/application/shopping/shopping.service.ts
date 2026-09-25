import { BiddingService, type ShoppingReservationResult } from '../bidding/bidding.service.js';
import { DomainError } from '../../domain/errors.js';

export class ShoppingService {
  constructor(private readonly bidding: BiddingService) {}

  async reserve(lotId: string, userId: string, quantity: number, idempotencyKey: string, correlationId: string, displayName?: string): Promise<ShoppingReservationResult> {
    if (quantity !== 1) throw new DomainError('INVALID_QUANTITY', 'Shopping purchases are limited to one lot', 400);
    return this.bidding.reserveShoppingLot({ lotId, userId, idempotencyKey, correlationId, displayName });
  }
}
