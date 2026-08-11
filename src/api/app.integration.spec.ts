import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp } from './app.js';

const runIntegration = process.env.RUN_INTEGRATION_TESTS === 'true';

describe.skipIf(!runIntegration)('auction engine API integration', () => {
  it('serves an authoritative snapshot and keeps registration/bid commands idempotent', async () => {
    const { app, context } = await createApp();
    try {
      const sandbox = await context.sandbox.create({ participantId: 'user-demo', lotCount: 1, idempotencyKey: 'integration-sandbox-contract-v3' }, 'integration-sandbox-contract-v3');
      const sandboxAuctionId = String((sandbox as { auctionId: string }).auctionId);
      const auction = await context.database.prisma.auctionExecution.findUniqueOrThrow({ where: { id: sandboxAuctionId }, include: { lots: true } });
      const lot = auction.lots[0];
      if (!lot) throw new Error('Sandbox integration lot is missing');
      await app.listen({ port: 0, host: '127.0.0.1' });
      const snapshot = await app.inject({
        method: 'GET',
        url: `/v1/auctions/${auction.id}/snapshot`,
      });
      expect(snapshot.statusCode).toBe(200);
      expect(snapshot.json().auction.id).toBe(auction.id);

      const registration = {
        method: 'POST' as const,
        url: `/v1/auctions/${auction.id}/registrations`,
        headers: { 'x-user-id': 'user-demo', 'idempotency-key': 'integration-registration-v1' },
        payload: { termsVersion: 'sandbox-v1' },
      };
      const firstRegistration = await app.inject(registration);
      const secondRegistration = await app.inject(registration);
      expect(firstRegistration.statusCode).toBe(200);
      expect(secondRegistration.json().registrationId).toBe(firstRegistration.json().registrationId);

      const bid = {
        method: 'POST' as const,
        url: `/v1/lots/${lot.id}/bids`,
        headers: { 'x-user-id': 'user-demo', 'idempotency-key': 'integration-bid-contract-v2' },
        payload: { amountCents: '999999' },
      };
      const firstBid = await app.inject(bid);
      const secondBid = await app.inject(bid);
      expect(firstBid.statusCode).toBe(200);
      expect(secondBid.json().bidRequestId).toBe(firstBid.json().bidRequestId);

      const history = await app.inject({ method: 'GET', url: `/v1/lots/${lot.id}/bids?limit=10` });
      expect(history.statusCode).toBe(200);
      expect(history.json()).toMatchObject({ hasMore: false, nextBeforeSequence: null });
      expect(history.json().items[0]).toMatchObject({
        bidRequestId: firstBid.json().bidRequestId,
        amountCents: '999999',
        origin: 'ONLINE',
        phase: 'LIVE_BID',
        lotSequence: expect.any(String),
        acceptedAt: expect.any(String),
        createdAt: expect.any(String),
        bidderAlias: expect.stringMatching(/^Participante [A-F0-9]{6}$/),
      });
      const invalidHistoryLimit = await app.inject({ method: 'GET', url: `/v1/lots/${lot.id}/bids?limit=101` });
      expect(invalidHistoryLimit.statusCode).toBe(400);

      const ticket = await context.tickets.issue(auction.id, 'user-ws', []);
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('Test server address is unavailable');
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws?ticket=${encodeURIComponent(ticket.ticket)}&auctionId=${auction.id}`);
      const snapshotMessage = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WebSocket snapshot timed out')), 5000);
        socket.on('message', (raw) => {
          const message = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (message.type === 'snapshot') {
            clearTimeout(timeout);
            resolve(message);
          }
        });
        socket.on('error', reject);
      });
      expect(snapshotMessage.type).toBe('snapshot');
      const eventMessage = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WebSocket event timed out')), 5000);
        socket.on('message', (raw) => {
          const message = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (message.type === 'event') {
            clearTimeout(timeout);
            resolve(message);
          }
        });
        socket.on('error', reject);
      });
      context.hub.broadcast({
        eventId: 'integration-ws-event',
        eventType: 'bid.accepted',
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        auctionId: auction.id,
        lotId: lot.id,
        correlationId: 'integration-ws',
        payload: { lotId: lot.id, currentPriceCents: '10000' },
      });
      expect((await eventMessage).type).toBe('event');
      socket.close();
    } finally {
      context.realtime.close();
      await app.close();
      await context.rabbit.close();
      await context.redis.close();
      await context.database.close();
    }
  });
});
