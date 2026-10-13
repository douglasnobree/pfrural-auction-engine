import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../infrastructure/database/db.js';
import { ExecutionPublishService } from './execution-publish.service.js';

describe('execution deletion', () => {
  function setup() {
    const models = ['auctionLotExecution', 'effectiveBid', 'bidRequest', 'auctionRegistration', 'streamSession', 'outboxEvent', 'auctionEventLog', 'managerAction', 'consumerInbox', 'shoppingReservation', 'settlement', 'winnerAward', 'proxyBid', 'bidIntent', 'realtimeTicket'] as const;
    const calls: string[] = [];
    const client = {
      ...Object.fromEntries(models.map((model) => [model, {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockImplementation(async () => { calls.push(model); return { count: 1 }; }),
      }])) as Record<(typeof models)[number], { findMany: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> }>,
      auctionExecution: {
        findUnique: vi.fn().mockResolvedValue({ id: 'auction-1' }),
        update: vi.fn().mockImplementation(async () => { calls.push('clear-current-lot'); }),
        delete: vi.fn().mockImplementation(async () => { calls.push('auctionExecution'); }),
      },
      $queryRaw: vi.fn().mockResolvedValue([]),
    };
    client.auctionLotExecution.findMany.mockResolvedValue([{ id: 'lot-1' }]);
    client.effectiveBid.findMany.mockResolvedValue([{ id: 'bid-1' }]);
    client.bidRequest.findMany.mockResolvedValue([{ id: 'request-1' }]);
    client.auctionRegistration.findMany.mockResolvedValue([{ id: 'registration-1' }]);
    client.outboxEvent.findMany.mockResolvedValue([{ eventId: 'event-1' }, { eventId: 'event-2' }]);
    client.auctionEventLog.findMany.mockResolvedValue([{ eventId: 'event-1' }]);
    const database = { transaction: vi.fn().mockImplementation((work) => work(client)) };
    return { client, calls, database, service: new ExecutionPublishService(database as unknown as Database) };
  }

  it('deletes the complete ledger in foreign-key order and preserves unrelated auctions', async () => {
    const { client, calls, service } = setup();
    await expect(service.purge('external-1')).resolves.toEqual({ eventIds: ['event-1', 'event-2'] });
    expect(client.auctionExecution.findUnique).toHaveBeenCalledWith({ where: { externalAuctionId: 'external-1' } });
    expect(client.$queryRaw).toHaveBeenCalledTimes(2);
    for (const model of ['shoppingReservation', 'winnerAward', 'effectiveBid', 'proxyBid', 'bidIntent', 'bidRequest'] as const) {
      expect(client[model].deleteMany).toHaveBeenCalledWith({ where: { lotId: { in: ['lot-1'] } } });
    }
    expect(client.managerAction.deleteMany).toHaveBeenCalledWith({ where: { targetId: { in: ['auction-1', 'lot-1', 'bid-1', 'request-1', 'registration-1'] } } });
    expect(client.consumerInbox.deleteMany).toHaveBeenCalledWith({ where: { messageId: { in: ['event-1', 'event-2'] } } });
    expect(calls.indexOf('shoppingReservation')).toBeLessThan(calls.indexOf('settlement'));
    expect(calls.indexOf('settlement')).toBeLessThan(calls.indexOf('winnerAward'));
    expect(calls.indexOf('winnerAward')).toBeLessThan(calls.indexOf('effectiveBid'));
    expect(calls.indexOf('effectiveBid')).toBeLessThan(calls.indexOf('bidIntent'));
    expect(calls.indexOf('proxyBid')).toBeLessThan(calls.indexOf('bidIntent'));
    expect(calls.indexOf('bidIntent')).toBeLessThan(calls.indexOf('bidRequest'));
    expect(calls.indexOf('clear-current-lot')).toBeLessThan(calls.indexOf('auctionLotExecution'));
    expect(calls.at(-1)).toBe('auctionExecution');
    expect(client.auctionExecution.delete).toHaveBeenCalledWith({ where: { id: 'auction-1' } });
  });

  it('succeeds for a draft or a repeated cleanup after the execution is gone', async () => {
    const { client, calls, service } = setup();
    client.auctionExecution.findUnique.mockResolvedValue(null);
    await expect(service.purge('missing')).resolves.toEqual({ eventIds: [] });
    expect(calls).toEqual([]);
  });

  it('propagates transaction failures without reporting deletion success', async () => {
    const { client, service } = setup();
    client.settlement.deleteMany.mockRejectedValue(new Error('Database failure'));
    await expect(service.purge('external-1')).rejects.toThrow('Database failure');
    expect(client.auctionExecution.delete).not.toHaveBeenCalled();
  });
});
