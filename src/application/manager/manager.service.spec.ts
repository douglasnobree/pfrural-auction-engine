import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../infrastructure/database/db.js';
import { ManagerService } from './manager.service.js';

function createManager(options: { currentLotId: string | null; currentLotStatus: string | null }) {
  const lot = {
    id: '22222222-2222-4222-8222-222222222222',
    auctionId: '11111111-1111-4111-8111-111111111111',
    externalLotId: 'external-lot-2',
    status: 'QUEUED',
    version: 3n,
    lotSequence: 1n,
    startsAt: null,
    endsAt: null,
  };
  const client = {
    $queryRaw: vi.fn(),
    auctionLotExecution: {
      findUnique: vi.fn().mockResolvedValue(lot),
      update: vi.fn().mockResolvedValue(lot),
    },
    auctionExecution: {
      findUnique: vi.fn().mockResolvedValue({
        currentLotId: options.currentLotId,
        currentLot: options.currentLotStatus
          ? { status: options.currentLotStatus }
          : null,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    managerAction: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    auctionEventLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const database = {
    transaction: vi.fn(async (work: (transaction: typeof client) => Promise<unknown>) => work(client)),
  } as unknown as Database;

  return {
    service: new ManagerService(database, {} as never),
    client,
    lot,
  };
}

describe('manager lot progression', () => {
  it('promotes an opened lot when the previous current lot is sold', async () => {
    const { service, client, lot } = createManager({
      currentLotId: '33333333-3333-4333-8333-333333333333',
      currentLotStatus: 'SOLD',
    });

    await service.lotCommand(
      lot.id,
      'open',
      'manager-1',
      'open-lot-2',
      undefined,
      'correlation-1',
    );

    expect(client.auctionExecution.update).toHaveBeenCalledWith({
      where: { id: lot.auctionId },
      data: { currentLotId: lot.id, version: { increment: 1 } },
    });
  });

  it('keeps the current lot when another lot is opened in parallel', async () => {
    const { service, client, lot } = createManager({
      currentLotId: '33333333-3333-4333-8333-333333333333',
      currentLotStatus: 'OPEN',
    });

    await service.lotCommand(
      lot.id,
      'open',
      'manager-1',
      'open-lot-2',
      undefined,
      'correlation-1',
    );

    expect(client.auctionExecution.update).not.toHaveBeenCalled();
  });
});
