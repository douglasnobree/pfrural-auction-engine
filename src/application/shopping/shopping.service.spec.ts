import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '../../domain/errors.js';
import { ShoppingService } from './shopping.service.js';

describe('ShoppingService', () => {
  it('delegates a single shopping purchase to the transactional bidding service', async () => {
    const result = { status: 'ACCEPTED', lotId: 'lot-id', lotStatus: 'SOLD' };
    const bidding = { buyShoppingLot: vi.fn().mockResolvedValue(result) };
    const service = new ShoppingService(bidding as never);

    await expect(service.reserve('lot-id', 'user-id', 1, 'purchase-key', 'correlation-id')).resolves.toEqual(result);
    expect(bidding.buyShoppingLot).toHaveBeenCalledWith({ lotId: 'lot-id', userId: 'user-id', idempotencyKey: 'purchase-key', correlationId: 'correlation-id' });
  });

  it('does not allow shopping reservations with a quantity greater than one', async () => {
    const bidding = { buyShoppingLot: vi.fn() };
    const service = new ShoppingService(bidding as never);

    await expect(service.reserve('lot-id', 'user-id', 2, 'purchase-key', 'correlation-id')).rejects.toMatchObject({ code: 'INVALID_QUANTITY', statusCode: 400 } satisfies Partial<DomainError>);
    expect(bidding.buyShoppingLot).not.toHaveBeenCalled();
  });
});
