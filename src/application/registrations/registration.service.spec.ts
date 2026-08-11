import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../infrastructure/database/db.js';
import { RegistrationService } from './registration.service.js';

function serviceWithClient(client: Record<string, unknown>) {
  const database = {
    prisma: client,
    transaction: async (work: (transactionClient: Record<string, unknown>) => unknown) => work(client),
  } as unknown as Database;
  return new RegistrationService(database);
}

describe('RegistrationService', () => {
  it('creates a pending registration for manual validation', async () => {
    const acceptedAt = new Date('2026-08-05T12:00:00.000Z');
    const client = {
      auctionExecution: { findUnique: vi.fn().mockResolvedValue({ id: 'auction-id' }) },
      auctionRegistration: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'registration-id', acceptedAt }),
      },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const service = serviceWithClient(client);

    const result = await service.register('auction-id', 'user-id', 'terms-v1', 'registration-key', 'correlation-id');

    expect(result).toMatchObject({ registrationId: 'registration-id', status: 'PENDING', userId: 'user-id' });
    expect(client.auctionRegistration.create).toHaveBeenCalledWith({ data: { auctionId: 'auction-id', userId: 'user-id', status: 'PENDING', termsVersion: 'terms-v1' } });
    expect(client.outboxEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'registration.requested' }) }));
  });

  it('approves registration immediately when the backend confirms global eligibility', async () => {
    const acceptedAt = new Date('2026-08-05T12:00:00.000Z');
    const client = {
      auctionExecution: { findUnique: vi.fn().mockResolvedValue({ id: 'auction-id' }) },
      auctionRegistration: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'registration-id', acceptedAt }),
      },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const service = serviceWithClient(client);

    const result = await service.register('auction-id', 'user-id', 'terms-v1', 'registration-key', 'correlation-id', true);

    expect(result).toMatchObject({ registrationId: 'registration-id', status: 'APPROVED', userId: 'user-id' });
    expect(client.auctionRegistration.create).toHaveBeenCalledWith({ data: { auctionId: 'auction-id', userId: 'user-id', status: 'APPROVED', termsVersion: 'terms-v1' } });
    expect(client.outboxEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'registration.approved' }) }));
  });

  it('enables a participant idempotently through a manager action', async () => {
    const acceptedAt = new Date('2026-08-05T12:00:00.000Z');
    const client = {
      managerAction: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      auctionRegistration: {
        findFirst: vi.fn().mockResolvedValue({ id: 'registration-id', auctionId: 'auction-id', userId: 'user-id', status: 'PENDING', termsVersion: 'terms-v1', acceptedAt }),
        update: vi.fn().mockResolvedValue({ id: 'registration-id', auctionId: 'auction-id', userId: 'user-id', status: 'APPROVED', termsVersion: 'terms-v1', acceptedAt }),
      },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
      $queryRaw: vi.fn().mockResolvedValue([]),
    };
    const service = serviceWithClient(client);

    const result = await service.setEnabled('auction-id', 'registration-id', true, 'manager-id', 'approval-key', 'correlation-id');

    expect(result).toMatchObject({ registrationId: 'registration-id', status: 'APPROVED', enabled: true });
    expect(client.managerAction.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'enable-registration', idempotencyKey: 'approval-key' }) });
    expect(client.outboxEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'registration.approved' }) }));
  });

  it('returns manager registrations with a stable cursor over acceptedAt and id', async () => {
    const firstAcceptedAt = new Date('2026-08-11T15:00:00.000Z');
    const secondAcceptedAt = new Date('2026-08-11T15:00:00.000Z');
    const registrations = [
      { id: '11111111-1111-4111-8111-111111111111', userId: 'user-a', status: 'PENDING', termsVersion: 'terms-v1', acceptedAt: firstAcceptedAt },
      { id: '22222222-2222-4222-8222-222222222222', userId: 'user-b', status: 'APPROVED', termsVersion: 'terms-v1', acceptedAt: secondAcceptedAt },
    ];
    const firstRegistration = registrations[0]!;
    const findMany = vi.fn().mockResolvedValue(registrations);
    const client = {
      auctionExecution: { findUnique: vi.fn().mockResolvedValue({ id: 'auction-id' }) },
      auctionRegistration: { findMany },
    };
    const service = serviceWithClient(client);

    const firstPage = await service.listForAuction('auction-id', { limit: 1 });

    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    await service.listForAuction('auction-id', { cursor: firstPage.nextCursor!, limit: 1 });
    expect(findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [
          { acceptedAt: { gt: firstAcceptedAt } },
          { acceptedAt: firstAcceptedAt, id: { gt: firstRegistration.id } },
        ],
      }),
      orderBy: [{ acceptedAt: 'asc' }, { id: 'asc' }],
      take: 2,
    }));
  });
});
