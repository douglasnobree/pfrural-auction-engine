import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp } from './app.js';

const runIntegration = process.env.RUN_INTEGRATION_TESTS === 'true';

describe.skipIf(!runIntegration)('auction engine API integration', () => {
  it('queues every online pre-bid for management approval and preserves FIFO decisions', async () => {
    const { app, context } = await createApp();
    try {
      const integrationKey = `integration-prebid-${Date.now().toString(36)}`;
      const sandbox = await context.sandbox.create({ participantId: 'prebid-user-one', lotCount: 1, idempotencyKey: integrationKey }, integrationKey);
      const auctionId = String((sandbox as { auctionId: string }).auctionId);
      const auction = await context.database.prisma.auctionExecution.findUniqueOrThrow({ where: { id: auctionId }, include: { lots: true } });
      const lot = auction.lots[0];
      if (!lot) throw new Error('Pre-bid integration lot is missing');

      const now = Date.now();
      await context.database.prisma.auctionExecution.update({
        where: { id: auction.id },
        data: {
          mode: 'TIMED',
          status: 'SCHEDULED',
          approvalMode: 'AUTOMATIC',
          preBidEnabled: true,
          preBidStartsAt: new Date(now - 60_000),
          preBidEndsAt: new Date(now + 60 * 60_000),
          startsAt: new Date(now + 2 * 60 * 60_000),
        },
      });
      await context.database.prisma.auctionLotExecution.update({
        where: { id: lot.id },
        data: { status: 'OPEN', startsAt: new Date(now + 2 * 60 * 60_000), endsAt: new Date(now + 3 * 60 * 60_000) },
      });
      await context.database.prisma.auctionRegistration.create({
        data: { auctionId: auction.id, userId: 'prebid-user-two', status: 'APPROVED', termsVersion: 'sandbox-v1' },
      });

      const firstBid = await app.inject({
        method: 'POST',
        url: `/v1/lots/${lot.id}/bids`,
        headers: { 'x-user-id': 'prebid-user-one', 'idempotency-key': `${integrationKey}-bid-one` },
        payload: { amountCents: '15000' },
      });
      const secondBid = await app.inject({
        method: 'POST',
        url: `/v1/lots/${lot.id}/bids`,
        headers: { 'x-user-id': 'prebid-user-two', 'idempotency-key': `${integrationKey}-bid-two` },
        payload: { amountCents: '16000' },
      });
      expect(firstBid.statusCode).toBe(200);
      expect(firstBid.json()).toMatchObject({ status: 'PENDING_APPROVAL', phase: 'PRE_BID', currentPriceCents: null });
      expect(secondBid.statusCode).toBe(200);
      expect(secondBid.json()).toMatchObject({ status: 'PENDING_APPROVAL', phase: 'PRE_BID', currentPriceCents: null });

      const managerHeaders = {
        'x-user-id': 'prebid-manager',
        'x-actor-role': 'manager',
        'x-internal-token': process.env.INTERNAL_SERVICE_TOKEN ?? 'local-development-token',
      };
      const pending = await app.inject({ method: 'GET', url: `/v1/manager/auctions/${auction.id}/pending-bids`, headers: managerHeaders });
      expect(pending.statusCode).toBe(200);
      expect(pending.json().items.map((item: { bidRequestId: string }) => item.bidRequestId)).toEqual([firstBid.json().bidRequestId, secondBid.json().bidRequestId]);

      const outOfOrderApproval = await app.inject({
        method: 'POST',
        url: `/v1/manager/bids/${secondBid.json().bidRequestId}/approve`,
        headers: { ...managerHeaders, 'idempotency-key': `${integrationKey}-approve-two` },
      });
      expect(outOfOrderApproval.statusCode).toBe(409);
      expect(outOfOrderApproval.json().error.code).toBe('APPROVAL_NOT_FIFO');

      const rejected = await app.inject({
        method: 'POST',
        url: `/v1/manager/bids/${firstBid.json().bidRequestId}/reject`,
        headers: { ...managerHeaders, 'idempotency-key': `${integrationKey}-reject-one` },
        payload: { reason: 'Valor recusado no teste' },
      });
      expect(rejected.statusCode).toBe(200);
      expect(rejected.json()).toMatchObject({ status: 'REJECTED', phase: 'PRE_BID', errorCode: 'MANAGER_REJECTED' });

      const approved = await app.inject({
        method: 'POST',
        url: `/v1/manager/bids/${secondBid.json().bidRequestId}/approve`,
        headers: { ...managerHeaders, 'idempotency-key': `${integrationKey}-approve-two-after-reject` },
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json()).toMatchObject({ status: 'ACCEPTED', phase: 'PRE_BID', currentPriceCents: '16000' });

      const history = await app.inject({ method: 'GET', url: `/v1/lots/${lot.id}/bids?limit=10` });
      expect(history.statusCode).toBe(200);
      expect(history.json().items).toEqual([expect.objectContaining({ bidRequestId: secondBid.json().bidRequestId, phase: 'PRE_BID', amountCents: '16000' })]);
    } finally {
      context.realtime.close();
      await app.close();
      await context.rabbit.close();
      await context.redis.close();
      await context.database.close();
    }
  });

  it('alternates the authoritative quick-bid increment globally and accepts higher personalized bids', async () => {
    const { app, context } = await createApp();
    try {
      const integrationKey = `integration-alternating-${Date.now().toString(36)}`;
      const sandbox = await context.sandbox.create({ participantId: 'alternating-user-one', lotCount: 1, idempotencyKey: integrationKey }, integrationKey);
      const auctionId = String((sandbox as { auctionId: string }).auctionId);
      const auction = await context.database.prisma.auctionExecution.findUniqueOrThrow({ where: { id: auctionId }, include: { lots: true } });
      const lot = auction.lots[0];
      if (!lot) throw new Error('Alternating-increment integration lot is missing');

      await context.database.prisma.auctionExecution.update({
        where: { id: auction.id },
        data: { mode: 'TIMED', status: 'RUNNING', approvalMode: 'AUTOMATIC', preBidEnabled: true },
      });
      await context.database.prisma.auctionLotExecution.update({
        where: { id: lot.id },
        data: { status: 'OPEN', startingBidCents: 10000n, incrementCents: 2000n, secondaryIncrementCents: 3000n },
      });
      for (const userId of ['alternating-user-one', 'alternating-user-two', 'alternating-user-three', 'alternating-user-four']) {
        await context.database.prisma.auctionRegistration.upsert({
          where: { auctionId_userId: { auctionId: auction.id, userId } },
          create: { auctionId: auction.id, userId, status: 'APPROVED', termsVersion: 'sandbox-v1' },
          update: { status: 'APPROVED' },
        });
      }

      const bid = async (userId: string, amountCents: string, expectedVersion?: string) => app.inject({
        method: 'POST',
        url: `/v1/lots/${lot.id}/bids`,
        headers: { 'x-user-id': userId, 'idempotency-key': `${integrationKey}-${userId}-${amountCents}` },
        payload: { amountCents, ...(expectedVersion ? { expectedVersion } : {}) },
      });

      const opening = await bid('alternating-user-one', '10000');
      expect(opening.statusCode).toBe(200);
      expect(opening.json()).toMatchObject({ currentPriceCents: '10000', currentIncrementCents: '2000', nextBidCents: '12000' });

      const standard = await bid('alternating-user-two', '12000', opening.json().version);
      expect(standard.statusCode).toBe(200);
      expect(standard.json()).toMatchObject({ currentPriceCents: '12000', currentIncrementCents: '3000', nextBidCents: '15000' });

      const alternative = await bid('alternating-user-three', '15000', standard.json().version);
      expect(alternative.statusCode).toBe(200);
      expect(alternative.json()).toMatchObject({ currentPriceCents: '15000', currentIncrementCents: '2000', nextBidCents: '17000' });

      const personalized = await bid('alternating-user-four', '18500', alternative.json().version);
      expect(personalized.statusCode).toBe(200);
      expect(personalized.json()).toMatchObject({ currentPriceCents: '18500', currentIncrementCents: '3000', nextBidCents: '21500' });

      const snapshot = await app.inject({ method: 'GET', url: `/v1/auctions/${auction.id}/snapshot` });
      expect(snapshot.statusCode).toBe(200);
      expect(snapshot.json().lots[0]).toMatchObject({ currentPriceCents: '18500', currentIncrementCents: '3000', nextBidCents: '21500' });
    } finally {
      context.realtime.close();
      await app.close();
      await context.rabbit.close();
      await context.redis.close();
      await context.database.close();
    }
  });

  it('serves an authoritative snapshot and keeps registration/bid commands idempotent', async () => {
    const { app, context } = await createApp();
    try {
      const integrationKey = `integration-sandbox-${Date.now().toString(36)}`;
      const sandbox = await context.sandbox.create({ participantId: 'user-demo', lotCount: 1, idempotencyKey: integrationKey }, integrationKey);
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

      const secondParticipantRegistration = await app.inject({
        method: 'POST',
        url: `/v1/auctions/${auction.id}/registrations`,
        headers: { 'x-user-id': 'user-second', 'idempotency-key': `integration-registration-second-${Date.now().toString(36)}` },
        payload: { termsVersion: 'sandbox-v1' },
      });
      expect(secondParticipantRegistration.statusCode).toBe(200);
      await context.database.prisma.auctionRegistration.update({
        where: { auctionId_userId: { auctionId: auction.id, userId: 'user-second' } },
        data: { status: 'APPROVED' },
      });
      const secondParticipantBid = await app.inject({
        method: 'POST',
        url: `/v1/lots/${lot.id}/bids`,
        headers: { 'x-user-id': 'user-second', 'idempotency-key': `integration-bid-second-${Date.now().toString(36)}` },
        payload: { amountCents: '1000999' },
      });
      expect(secondParticipantBid.statusCode).toBe(200);
      const managerHeaders = {
        'x-user-id': 'integration-manager',
        'x-actor-role': 'manager',
        'x-internal-token': process.env.INTERNAL_SERVICE_TOKEN ?? 'local-development-token',
      };
      const managementKey = Date.now().toString(36);
      const floorBid = await app.inject({
        method: 'POST',
        url: `/v1/manager/lots/${lot.id}/floor-bids`,
        headers: { ...managerHeaders, 'idempotency-key': `integration-floor-${managementKey}` },
        payload: { participantId: 'user-demo', amountCents: '1100000', origin: 'FLOOR', displayName: 'Participante de teste' },
      });
      expect(floorBid.statusCode).toBe(200);
      expect(floorBid.json().currentPriceCents).toBe('1000999');

      const managerHistory = await app.inject({ method: 'GET', url: `/v1/manager/lots/${lot.id}/bids?limit=10`, headers: managerHeaders });
      expect(managerHistory.statusCode).toBe(200);
      expect(managerHistory.json().items[0]).toMatchObject({ origin: 'FLOOR', status: 'ACTIVE', management: { canEdit: true, canDelete: true } });
      const managedBidId = managerHistory.json().items[0].id as string;
      const updatedBid = await app.inject({
        method: 'PATCH',
        url: `/v1/manager/bids/${managedBidId}`,
        headers: { ...managerHeaders, 'idempotency-key': `integration-update-${managementKey}` },
        payload: { amountCents: '1200000', reason: 'Correção operacional de teste', expectedVersion: floorBid.json().version },
      });
      expect(updatedBid.statusCode).toBe(200);
      expect(updatedBid.json()).toMatchObject({ status: 'UPDATED', bidId: managedBidId, amountCents: '1200000' });

      const voidedBid = await app.inject({
        method: 'DELETE',
        url: `/v1/manager/bids/${managedBidId}`,
        headers: { ...managerHeaders, 'idempotency-key': `integration-void-${managementKey}` },
        payload: { reason: 'Anulação operacional de teste', expectedVersion: updatedBid.json().version },
      });
      expect(voidedBid.statusCode).toBe(200);
      expect(voidedBid.json()).toMatchObject({ status: 'VOIDED', bidId: managedBidId, currentPriceCents: '1000999' });
      const publicHistoryAfterVoid = await app.inject({ method: 'GET', url: `/v1/lots/${lot.id}/bids?limit=10` });
      expect(publicHistoryAfterVoid.statusCode).toBe(200);
      expect(publicHistoryAfterVoid.json().items.some((item: { id: string }) => item.id === managedBidId)).toBe(false);
      const managerHistoryAfterVoid = await app.inject({ method: 'GET', url: `/v1/manager/lots/${lot.id}/bids?limit=10`, headers: managerHeaders });
      expect(managerHistoryAfterVoid.json().items.find((item: { id: string }) => item.id === managedBidId)).toMatchObject({ status: 'VOIDED', voidReason: 'Anulação operacional de teste', management: { canEdit: false, canDelete: false } });

      const proxyBid = await app.inject({
        method: 'PUT',
        url: `/v1/lots/${lot.id}/proxy-bid`,
        headers: { 'x-user-id': 'user-demo', 'idempotency-key': `integration-proxy-${managementKey}` },
        payload: { amountCents: '1300000', expectedVersion: voidedBid.json().version },
      });
      expect(proxyBid.statusCode).toBe(200);
      const proxyBidId = proxyBid.json().effectiveBidId as string;
      expect(proxyBidId).toBeTruthy();
      const managerHistoryWithProxy = await app.inject({ method: 'GET', url: `/v1/manager/lots/${lot.id}/bids?limit=10`, headers: managerHeaders });
      expect(managerHistoryWithProxy.json().items.find((item: { id: string }) => item.id === proxyBidId)).toMatchObject({ origin: 'PROXY', status: 'ACTIVE', management: { canEdit: true, canDelete: true, mode: 'PROXY', proxyMaxBidCents: '1300000' } });
      const updatedProxy = await app.inject({
        method: 'PATCH',
        url: `/v1/manager/bids/${proxyBidId}`,
        headers: { ...managerHeaders, 'idempotency-key': `integration-proxy-update-${managementKey}` },
        payload: { amountCents: '1400000', reason: 'Ajuste de teto automático', expectedVersion: proxyBid.json().version },
      });
      expect(updatedProxy.statusCode).toBe(200);
      expect(updatedProxy.json()).toMatchObject({ status: 'UPDATED', bidId: proxyBidId, proxyMaxBidCents: '1400000' });
      const proxyAfterUpdate = await app.inject({ method: 'GET', url: `/v1/manager/lots/${lot.id}/bids?limit=10`, headers: managerHeaders });
      expect(proxyAfterUpdate.json().items.find((item: { id: string }) => item.id === proxyBidId)).toMatchObject({ management: { mode: 'PROXY', proxyMaxBidCents: '1400000' } });
      const voidedProxy = await app.inject({
        method: 'DELETE',
        url: `/v1/manager/bids/${proxyBidId}`,
        headers: { ...managerHeaders, 'idempotency-key': `integration-proxy-void-${managementKey}` },
        payload: { reason: 'Desativação de automação de teste', expectedVersion: updatedProxy.json().version },
      });
      expect(voidedProxy.statusCode).toBe(200);
      expect(voidedProxy.json()).toMatchObject({ status: 'VOIDED', bidId: proxyBidId });

      const onlineAfterProxy = await app.inject({
        method: 'POST',
        url: `/v1/lots/${lot.id}/bids`,
        headers: { 'x-user-id': 'user-second', 'idempotency-key': `integration-online-after-proxy-${managementKey}` },
        payload: { amountCents: '1100999', expectedVersion: voidedProxy.json().version },
      });
      expect(onlineAfterProxy.statusCode).toBe(200);
      const onlineBidId = onlineAfterProxy.json().effectiveBidId as string;
      const onlineManagerHistory = await app.inject({ method: 'GET', url: `/v1/manager/lots/${lot.id}/bids?limit=10`, headers: managerHeaders });
      expect(onlineManagerHistory.json().items.find((item: { id: string }) => item.id === onlineBidId)).toMatchObject({ origin: 'ONLINE', status: 'ACTIVE', management: { canEdit: true, canDelete: true, mode: 'BID' } });
      const updatedOnline = await app.inject({
        method: 'PATCH',
        url: `/v1/manager/bids/${onlineBidId}`,
        headers: { ...managerHeaders, 'idempotency-key': `integration-online-update-${managementKey}` },
        payload: { amountCents: '1200999', reason: 'Correção de lance online', expectedVersion: onlineAfterProxy.json().version },
      });
      expect(updatedOnline.statusCode).toBe(200);
      expect(updatedOnline.json()).toMatchObject({ status: 'UPDATED', bidId: onlineBidId, amountCents: '1200999' });
      const olderOnlineBidId = firstBid.json().effectiveBidId as string;
      const olderOnlineHistory = await app.inject({ method: 'GET', url: `/v1/manager/lots/${lot.id}/bids?limit=10`, headers: managerHeaders });
      expect(olderOnlineHistory.json().items.find((item: { id: string }) => item.id === olderOnlineBidId)).toMatchObject({ origin: 'ONLINE', status: 'ACTIVE', management: { canEdit: true, canDelete: true, isLatest: false, mode: 'BID' } });
      const updatedOlderOnline = await app.inject({
        method: 'PATCH',
        url: `/v1/manager/bids/${olderOnlineBidId}`,
        headers: { ...managerHeaders, 'idempotency-key': `integration-older-online-update-${managementKey}` },
        payload: { amountCents: '999500', reason: 'Correção de histórico online', expectedVersion: updatedOnline.json().version },
      });
      expect(updatedOlderOnline.statusCode).toBe(200);
      expect(updatedOlderOnline.json()).toMatchObject({ status: 'UPDATED', bidId: olderOnlineBidId, amountCents: '999500', currentPriceCents: '1200999' });
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
