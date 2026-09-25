import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { z, ZodError } from 'zod';
import { config } from '../config.js';
import { DomainError } from '../domain/errors.js';
import { actorFromRequest, correlationId, header, idempotencyKey, internalRequest, managerFromRequest, trustedDisplayName } from './auth.js';
import { auctionParam, bidBody, bidHistoryQuery, bidManagementDeleteBody, bidManagementUpdateBody, currentLotBody, externalLotQuery, floorBidBody, idParam, internalRegistrationBody, lotParam, managerBody, parseBody, pendingBidsQuery, publishExecutionBody, proxyBidBody, rejectBody, registrationApprovalBody, registrationBody, registrationListQuery, reservationBody, sandboxBody, streamBody, whatsappConsentBody } from './contracts.js';
import { AuctionQueryService } from '../application/auctions/auction-query.service.js';
import { BiddingService } from '../application/bidding/bidding.service.js';
import { ManagerService } from '../application/manager/manager.service.js';
import { RegistrationService } from '../application/registrations/registration.service.js';
import { RealtimeTicketService } from '../application/realtime/ticket.service.js';
import { ShoppingService } from '../application/shopping/shopping.service.js';
import { ExecutionPublishService } from '../application/catalog/execution-publish.service.js';
import { Database } from '../infrastructure/database/db.js';
import { EventHub } from '../infrastructure/realtime/event-hub.js';
import { RealtimeGateway } from '../infrastructure/realtime/gateway.js';
import { RabbitMq } from '../infrastructure/messaging/rabbitmq.js';
import { RedisService } from '../infrastructure/redis/redis.service.js';
import { SandboxService } from '../application/sandbox/sandbox.service.js';
import { isPublicRealtimeEvent } from '../domain/public-events.js';
import { logEvent, logRecovered, logRepeatedFailure } from '../infrastructure/logging/logger.js';

export interface AppContext {
  database: Database;
  rabbit: RabbitMq;
  queries: AuctionQueryService;
  bidding: BiddingService;
  manager: ManagerService;
  registrations: RegistrationService;
  tickets: RealtimeTicketService;
  shopping: ShoppingService;
  executions: ExecutionPublishService;
  hub: EventHub;
  realtime: RealtimeGateway;
  redis: RedisService;
  sandbox: SandboxService;
}

function errorLogFields(error: unknown): Record<string, unknown> {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const constraint = error.meta?.target ?? error.meta?.constraint;
    const errorMessage = error.code === 'P2002'
      ? 'Unique constraint violation'
      : error.code === 'P2003'
        ? 'Foreign key constraint violation'
        : error.code === 'P2025'
          ? 'Required record was not found'
          : 'Database request failed';
    return {
      errorName: error.name,
      errorCode: error.code,
      errorMessage,
      ...(constraint !== undefined ? { constraint } : {}),
    };
  }
  if (error instanceof Error) {
    return { errorName: error.name, errorMessage: error.message.slice(0, 500) };
  }
  return { errorName: 'UnknownError', errorMessage: String(error).slice(0, 500) };
}

export function createContext(): AppContext {
  const database = new Database();
  const rabbit = new RabbitMq();
  const queries = new AuctionQueryService(database);
  const bidding = new BiddingService(database);
  const tickets = new RealtimeTicketService(database);
  const hub = new EventHub();
  const redis = new RedisService();
  return { database, rabbit, queries, bidding, manager: new ManagerService(database, bidding), registrations: new RegistrationService(database, bidding), tickets, shopping: new ShoppingService(bidding), executions: new ExecutionPublishService(database), sandbox: new SandboxService(database), hub, redis, realtime: new RealtimeGateway(tickets, queries, hub) };
}

export async function createApp(context = createContext()): Promise<{ app: FastifyInstance; context: AppContext }> {
  const app = Fastify({ logger: false, disableRequestLogging: true });
  const loggedServerErrors = new WeakSet<object>();
  const requestLogFields = (request: FastifyRequest, statusCode: number, durationMs: number, includeCommandDetails = false) => {
    const params = request.params && typeof request.params === 'object'
      ? request.params as Record<string, unknown>
      : {};
    const body = request.body && typeof request.body === 'object'
      ? request.body as Record<string, unknown>
      : {};
    const targetId = params.lotId ?? params.auctionId ?? params.id ?? params.externalLotId ?? params.externalAuctionId;
    const action = params.action;
    const amountCents = body.amountCents;
    const quantity = body.quantity;
    const origin = body.origin;
    const externalCorrelationId = header(request, 'x-correlation-id');
    return {
      correlationId: externalCorrelationId ?? request.id,
      ...(externalCorrelationId && externalCorrelationId !== request.id ? { requestId: request.id } : {}),
      method: request.method,
      route: request.routeOptions.url ?? request.url.split('?')[0],
      status: statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      ...(typeof targetId === 'string' ? { targetId } : {}),
      ...(includeCommandDetails && typeof action === 'string' ? { action } : {}),
      ...(includeCommandDetails && (typeof amountCents === 'string' || typeof amountCents === 'number') ? { amountCents } : {}),
      ...(includeCommandDetails && typeof quantity === 'number' ? { quantity } : {}),
      ...(includeCommandDetails && typeof origin === 'string' ? { origin } : {}),
    };
  };
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => done(null, body));
  await app.register(cors, {
    origin: true,
    credentials: true,
  });
  context.realtime = new RealtimeGateway(context.tickets, context.queries, context.hub);
  context.realtime.attach(app.server);
  void context.rabbit.consume('auction.websocket.v1', async (envelope) => {
    if (isPublicRealtimeEvent(envelope.eventType)) context.hub.broadcast(envelope);
  }).catch((error: unknown) => logEvent('warn', 'api', 'websocket.consumer.unavailable', { error }));

  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url;
    if (route === '/ready') {
      const failureKey = 'api:readiness';
      const fields = requestLogFields(request, reply.statusCode, reply.elapsedTime);
      if (reply.statusCode >= 500) {
        logRepeatedFailure('api', 'readiness.failed', failureKey, 'Database readiness query failed', { ...fields, code: 'NOT_READY' });
      } else {
        logRecovered('api', 'readiness.recovered', failureKey, fields);
      }
      return;
    }
    if (reply.statusCode >= 500) {
      if (!loggedServerErrors.has(request)) {
        logEvent('error', 'api', 'request.failed', requestLogFields(request, reply.statusCode, reply.elapsedTime));
      }
      return;
    }
    if (reply.statusCode === 404 && !request.routeOptions.url) {
      logEvent('debug', 'api', 'request.rejected', { ...requestLogFields(request, reply.statusCode, reply.elapsedTime), code: 'ROUTE_NOT_FOUND' });
      return;
    }
    if (reply.statusCode >= 400) return;
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    if (request.routeOptions.url === '/v1/realtime/tickets') return;
    logEvent('info', 'api', 'command.completed', requestLogFields(request, reply.statusCode, reply.elapsedTime, true));
  });

  app.addHook('onRequest', async (request, reply) => {
    const pathname = request.url.split('?')[0] ?? '';
    const isCommand = request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH' || request.method === 'DELETE';
    const isRateLimited = isCommand && (
      pathname.includes('/bids') ||
      pathname.includes('/proxy-bid') ||
      pathname.includes('/registrations') ||
      pathname.includes('/reservations')
    );
    if (!isRateLimited) return;
    const actorKey = String(request.headers['x-user-id'] ?? request.ip);
    const allowed = await context.redis.consumeRateLimit(actorKey, config.RATE_LIMIT_PER_MINUTE, 60);
    if (!allowed) {
      reply.header('Retry-After', '60');
      throw new DomainError('RATE_LIMITED', 'Too many auction commands', 429);
    }
  });

  app.get('/health', async () => ({ status: 'ok', service: 'pfrural-auction-engine', serverTime: new Date().toISOString() }));
  app.get('/ready', async (_request, reply) => {
    try { await context.database.prisma.$queryRaw`SELECT 1`; return { status: 'ready' }; } catch { return reply.code(503).send({ status: 'not_ready' }); }
  });
  app.get('/v1/auctions/:auctionId/snapshot', async (request) => context.queries.getAuctionSnapshot(auctionParam.parse(request.params).auctionId));
  app.get('/v1/internal/auctions/by-external/:externalAuctionId/snapshot', async (request) => { internalRequest(request); return context.queries.getAuctionSnapshotByExternalId(String((request.params as { externalAuctionId: string }).externalAuctionId)); });
  app.get('/v1/internal/lots/by-external/:externalLotId', async (request) => { internalRequest(request); const params = z.object({ externalLotId: z.string().min(1) }).parse(request.params); return context.queries.getLotByExternalId(externalLotQuery.parse(request.query).externalAuctionId, params.externalLotId); });
  app.post('/v1/internal/executions/publish', async (request) => { internalRequest(request); return context.executions.publish(parseBody(publishExecutionBody, request.body), correlationId(request)); });
  app.post('/v1/internal/sandbox/auctions', async (request) => { internalRequest(request); if (!config.SANDBOX_ENABLED || config.NODE_ENV === 'production') throw new DomainError('SANDBOX_DISABLED', 'Sandbox creation is disabled in this environment', 403); const body = parseBody(sandboxBody, request.body); return context.sandbox.create({ ...body, idempotencyKey: idempotencyKey(request) }, correlationId(request)); });
  app.post('/v1/internal/auctions/by-external/:externalAuctionId/registrations', async (request) => { internalRequest(request); const actor = actorFromRequest(request); const { externalAuctionId } = request.params as { externalAuctionId: string }; const body = parseBody(internalRegistrationBody, request.body); const snapshot = await context.queries.getAuctionSnapshotByExternalId(externalAuctionId); const auctionId = (snapshot.auction as { id: string }).id; return context.registrations.register(auctionId, actor.userId, body.termsVersion, idempotencyKey(request), correlationId(request), body.globallyEnabled, body.acquisitionSource, body.whatsappOptIn); });
  app.post('/v1/auctions/:auctionId/registrations', async (request) => {
    const actor = actorFromRequest(request); const { auctionId } = auctionParam.parse(request.params); const body = parseBody(registrationBody, request.body);
    return context.registrations.register(auctionId, actor.userId, body.termsVersion, idempotencyKey(request), correlationId(request), false, body.acquisitionSource, body.whatsappOptIn);
  });
  app.put('/v1/auctions/:auctionId/registrations/whatsapp-consent', async (request) => {
    const actor = actorFromRequest(request); const { auctionId } = auctionParam.parse(request.params); const body = parseBody(whatsappConsentBody, request.body);
    return context.registrations.setWhatsAppConsent(auctionId, actor.userId, body.whatsappOptIn, idempotencyKey(request), correlationId(request));
  });
  app.get('/v1/auctions/:auctionId/registrations/me', async (request) => {
    const actor = actorFromRequest(request); const { auctionId } = auctionParam.parse(request.params); return context.registrations.getForUser(auctionId, actor.userId);
  });
  app.get('/v1/manager/auctions/:auctionId/registrations', async (request) => {
    managerFromRequest(request); const { auctionId } = auctionParam.parse(request.params); const query = registrationListQuery.parse(request.query); return context.registrations.listForAuction(auctionId, query);
  });
  app.put('/v1/manager/auctions/:auctionId/registrations/:id', async (request) => {
    const actor = managerFromRequest(request); const { auctionId } = auctionParam.parse(request.params); const { id } = idParam.parse(request.params); const body = parseBody(registrationApprovalBody, request.body);
    return context.registrations.setEnabled(auctionId, id, body.enabled, actor.userId, idempotencyKey(request), correlationId(request));
  });
  app.post('/v1/lots/:lotId/bids', async (request) => {
    const actor = actorFromRequest(request); const { lotId } = lotParam.parse(request.params); const body = parseBody(bidBody, request.body);
    return context.bidding.placeBid({ lotId, userId: actor.userId, amountCents: body.amountCents, commandId: body.commandId, expectedVersion: body.expectedVersion ? BigInt(body.expectedVersion) : undefined, displayName: trustedDisplayName(request, body.displayName), idempotencyKey: idempotencyKey(request), correlationId: correlationId(request) });
  });
  app.put('/v1/lots/:lotId/proxy-bid', async (request) => {
    const actor = actorFromRequest(request); const { lotId } = lotParam.parse(request.params); const body = parseBody(proxyBidBody, request.body);
    return context.bidding.placeBid({ lotId, userId: actor.userId, amountCents: body.amountCents, commandId: body.commandId, expectedVersion: body.expectedVersion ? BigInt(body.expectedVersion) : undefined, displayName: trustedDisplayName(request, body.displayName), origin: 'PROXY', idempotencyKey: idempotencyKey(request), correlationId: correlationId(request) });
  });
  app.get('/v1/lots/:lotId/proxy-bid/me', async (request) => {
    const actor = actorFromRequest(request); const { lotId } = lotParam.parse(request.params);
    return context.bidding.getActiveProxyBid(lotId, actor.userId);
  });
  app.get('/v1/lots/:lotId/bids', async (request) => {
    const { lotId } = lotParam.parse(request.params);
    const query = bidHistoryQuery.parse(request.query);
    return context.bidding.listEffectiveBids(lotId, query.beforeSequence, query.limit);
  });
  app.post('/v1/realtime/tickets', async (request) => {
    const actor = actorFromRequest(request); const body = z.object({ auctionId: z.string().uuid() }).parse(request.body); await context.redis.markPresence(body.auctionId, actor.userId); return context.tickets.issue(body.auctionId, actor.userId, actor.roles);
  });
  app.post('/v1/shopping-lots/:lotId/reservations', async (request) => {
    const actor = actorFromRequest(request); const { lotId } = lotParam.parse(request.params); const body = parseBody(reservationBody, request.body); return context.shopping.reserve(lotId, actor.userId, body.quantity, idempotencyKey(request), correlationId(request), trustedDisplayName(request, body.displayName));
  });

  app.post('/v1/manager/auctions/:id/:action', async (request) => {
    const actor = managerFromRequest(request); const { id, action } = z.object({ id: z.string().uuid(), action: z.enum(['start', 'pause', 'resume', 'finish']) }).parse(request.params); const body = parseBody(managerBody, request.body);
    return context.manager.auctionCommand(id, action, actor.userId, idempotencyKey(request), body.expectedVersion ? BigInt(body.expectedVersion) : undefined, correlationId(request));
  });
  app.post('/v1/manager/lots/:lotId/:action', async (request) => {
    const actor = managerFromRequest(request); const { lotId, action } = z.object({ lotId: z.string().uuid(), action: z.enum(['open', 'pause', 'resume', 'announce', 'withdraw', 'sell']) }).parse(request.params); const body = parseBody(managerBody, request.body);
    if (action === 'sell') return context.manager.sellLot(lotId, actor.userId, idempotencyKey(request), body.expectedVersion ? BigInt(body.expectedVersion) : undefined, correlationId(request));
    return context.manager.lotCommand(lotId, action, actor.userId, idempotencyKey(request), body.expectedVersion ? BigInt(body.expectedVersion) : undefined, correlationId(request));
  });
  app.post('/v1/manager/lots/:lotId/floor-bids', async (request) => {
    const actor = managerFromRequest(request); const { lotId } = lotParam.parse(request.params); const body = parseBody(floorBidBody, request.body);
    return context.bidding.placeBid({ lotId, userId: body.participantId, amountCents: body.amountCents, expectedVersion: body.expectedVersion ? BigInt(body.expectedVersion) : undefined, origin: body.origin, acquisitionSource: body.acquisitionSource, whatsappOptIn: body.whatsappOptIn, displayName: trustedDisplayName(request, body.displayName), actorId: actor.userId, autoApproveRegistration: true, idempotencyKey: idempotencyKey(request), correlationId: correlationId(request) });
  });
  app.get('/v1/manager/auctions/:auctionId/pending-bids', async (request) => {
    managerFromRequest(request); const { auctionId } = auctionParam.parse(request.params); const query = pendingBidsQuery.parse(request.query);
    return context.bidding.listPendingApprovals(auctionId, query.lotId, query.limit);
  });
  app.get('/v1/manager/auctions/:auctionId/pending-eligibility-bids', async (request) => {
    managerFromRequest(request); const { auctionId } = auctionParam.parse(request.params); const query = pendingBidsQuery.parse(request.query);
    return context.bidding.listPendingEligibilityBids(auctionId, query.lotId, query.limit);
  });
  app.get('/v1/manager/auctions/:auctionId/shopping-sales', async (request) => {
    managerFromRequest(request);
    const { auctionId } = auctionParam.parse(request.params);
    return context.bidding.listShoppingSales(auctionId);
  });
  app.get('/v1/manager/lots/:lotId/bids', async (request) => {
    managerFromRequest(request); const { lotId } = lotParam.parse(request.params); const query = bidHistoryQuery.parse(request.query);
    return context.bidding.listManagerEffectiveBids(lotId, query.beforeSequence, query.limit);
  });
  app.post('/v1/manager/bids/:id/approve', async (request) => {
    const actor = managerFromRequest(request); return context.bidding.approveBidRequest(idParam.parse(request.params).id, actor.userId, idempotencyKey(request), correlationId(request));
  });
  app.post('/v1/manager/bids/:id/reject', async (request) => {
    const actor = managerFromRequest(request); const body = parseBody(rejectBody, request.body); return context.bidding.rejectBidRequest(idParam.parse(request.params).id, actor.userId, body.reason, idempotencyKey(request), correlationId(request));
  });
  app.patch('/v1/manager/bids/:id', async (request) => {
    const actor = managerFromRequest(request); const { id } = idParam.parse(request.params); const body = parseBody(bidManagementUpdateBody, request.body);
    return context.bidding.updateManagerBid(id, body.amountCents, body.reason, actor.userId, idempotencyKey(request), correlationId(request), body.expectedVersion ? BigInt(body.expectedVersion) : undefined);
  });
  app.delete('/v1/manager/bids/:id', async (request) => {
    const actor = managerFromRequest(request); const { id } = idParam.parse(request.params); const body = parseBody(bidManagementDeleteBody, request.body);
    return context.bidding.voidManagerBid(id, body.reason, actor.userId, idempotencyKey(request), correlationId(request), body.expectedVersion ? BigInt(body.expectedVersion) : undefined);
  });
  app.put('/v1/manager/auctions/:auctionId/current-lot', async (request) => {
    const actor = managerFromRequest(request); const { auctionId } = auctionParam.parse(request.params); const body = parseBody(currentLotBody, request.body); return context.manager.setCurrentLot(auctionId, body.lotId, actor.userId, idempotencyKey(request), body.expectedVersion ? BigInt(body.expectedVersion) : undefined, correlationId(request));
  });
  app.put('/v1/manager/auctions/:auctionId/stream', async (request) => {
    const actor = managerFromRequest(request); const { auctionId } = auctionParam.parse(request.params); const body = parseBody(streamBody, request.body); return context.manager.updateStream(auctionId, actor.userId, idempotencyKey(request), body, body.expectedVersion ? BigInt(body.expectedVersion) : undefined, correlationId(request));
  });
  app.get('/v1/manager/auctions/:auctionId/control-room', async (request) => {
    managerFromRequest(request); const { auctionId } = auctionParam.parse(request.params); return context.queries.getAuctionSnapshot(auctionId);
  });

  app.setErrorHandler((error, request, reply) => {
    const correlation = correlationId(request);
    if (error instanceof ZodError) {
      logEvent('warn', 'api', 'request.rejected', { ...requestLogFields(request, 400, reply.elapsedTime), code: 'VALIDATION_ERROR', issueCount: error.issues.length });
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: error.flatten() }, correlationId: correlation });
    }
    if (error instanceof DomainError) {
      if (error.statusCode >= 500) loggedServerErrors.add(request);
      logEvent(error.statusCode >= 500 ? 'error' : 'warn', 'api', error.statusCode >= 500 ? 'request.failed' : 'request.rejected', {
        ...requestLogFields(request, error.statusCode, reply.elapsedTime),
        code: error.code,
        ...(error.statusCode >= 500 ? errorLogFields(error) : {}),
      });
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }, correlationId: correlation });
    }
    if (typeof error === 'object' && error !== null && 'statusCode' in error && (error as { statusCode?: unknown }).statusCode === 415) {
      logEvent('warn', 'api', 'request.rejected', { ...requestLogFields(request, 415, reply.elapsedTime), code: 'UNSUPPORTED_MEDIA_TYPE' });
      return reply.code(415).send({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type is not supported' }, correlationId: correlation });
    }
    loggedServerErrors.add(request);
    logEvent('error', 'api', 'request.failed', { ...requestLogFields(request, 500, reply.elapsedTime), ...errorLogFields(error) });
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' }, correlationId: correlation });
  });
  return { app, context };
}
