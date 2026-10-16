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
        id: lot.auctionId,
        externalAuctionId: 'external-auction',
        version: 7n,
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
  it('selects an announced lot and emits its new current-lot state without opening it', async () => {
    const { service, client, lot } = createManager({
      currentLotId: '33333333-3333-4333-8333-333333333333',
      currentLotStatus: 'OPEN',
    });

    await expect(service.lotCommand(
      lot.id, 'announce', 'manager-1', 'announce-lot-2', lot.version, 'correlation-1',
    )).resolves.toMatchObject({
      lotId: lot.id, action: 'announce', version: '3', currentLotId: lot.id, auctionVersion: '8',
    });

    expect(client.auctionExecution.update).toHaveBeenCalledWith({
      where: { id: lot.auctionId },
      data: { currentLotId: lot.id, version: 8n },
    });
    expect(client.auctionLotExecution.update).not.toHaveBeenCalled();
    expect(client.outboxEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'auction.current_lot.changed',
        auctionId: lot.auctionId,
        aggregateVersion: 8n,
        payload: expect.objectContaining({
          payload: expect.objectContaining({ currentLotId: lot.id, externalAuctionId: 'external-auction' }),
        }),
      }),
    }));
    expect(client.outboxEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'lot.announced', lotId: lot.id }),
    }));
  });

  it('rejects a stale announcement without changing the current lot', async () => {
    const { service, client, lot } = createManager({ currentLotId: null, currentLotStatus: null });

    await expect(service.lotCommand(
      lot.id, 'announce', 'manager-1', 'announce-stale', 2n, 'correlation-1',
    )).rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });

    expect(client.auctionExecution.update).not.toHaveBeenCalled();
    expect(client.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('replays an announcement without selecting the lot or emitting events again', async () => {
    const { service, client, lot } = createManager({ currentLotId: null, currentLotStatus: null });
    const saved = { lotId: lot.id, action: 'announce', version: '3', currentLotId: lot.id, auctionVersion: '8' };
    client.managerAction.findUnique.mockResolvedValue({ result: saved } as never);

    await expect(service.lotCommand(
      lot.id, 'announce', 'manager-1', 'announce-replay', lot.version, 'correlation-1',
    )).resolves.toEqual(saved);

    expect(client.auctionExecution.update).not.toHaveBeenCalled();
    expect(client.outboxEvent.create).not.toHaveBeenCalled();
  });

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

describe('pre-bid expiration during a manual live opening', () => {
  function setup(status: string) {
    const { client, lot } = createManager({ currentLotId: null, currentLotStatus: null });
    lot.status = 'OPEN';
    client.auctionExecution.findUnique.mockResolvedValue({ status, currentLotId: null, currentLot: null } as never);
    const prisma = {
      auctionExecution: {
        findMany: vi.fn().mockResolvedValue([{
          id: lot.auctionId, mode: 'LIVE',
          preBidEndsAt: new Date('2026-10-13T12:00:00Z'),
          startsAt: new Date('2026-10-13T14:00:00Z'),
        }]),
      },
      auctionLotExecution: { findMany: vi.fn().mockResolvedValue([{ id: lot.id }]) },
    };
    const database = {
      prisma,
      transaction: vi.fn(async (work: (transaction: typeof client) => Promise<unknown>) => work(client)),
    };
    return { service: new ManagerService(database as unknown as Database, {} as never), client, prisma, lot };
  }

  it('pauses open pre-bid lots when the auction is still scheduled', async () => {
    const { service, client, prisma } = setup('SCHEDULED');
    await expect(service.expirePreBidWindows(new Date('2026-10-13T12:00:00Z'))).resolves.toEqual({ finishedAuctions: 0, pausedLiveLots: 1 });
    expect(prisma.auctionExecution.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'SCHEDULED' }) }));
    expect(client.auctionLotExecution.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PAUSED' }) }));
  });

  it('does not pause a lot when the auction starts after the worker query', async () => {
    const { service, client } = setup('RUNNING');
    await expect(service.expirePreBidWindows(new Date('2026-10-13T12:00:00Z'))).resolves.toEqual({ finishedAuctions: 0, pausedLiveLots: 0 });
    expect(client.auctionLotExecution.update).not.toHaveBeenCalled();
    expect(client.managerAction.create).not.toHaveBeenCalled();
    expect(client.outboxEvent.create).not.toHaveBeenCalled();
  });
});
