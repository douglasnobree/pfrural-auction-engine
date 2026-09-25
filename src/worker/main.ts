import { config } from '../config.js';
import { BiddingService } from '../application/bidding/bidding.service.js';
import { ManagerService } from '../application/manager/manager.service.js';
import { Database } from '../infrastructure/database/db.js';
import { ConsumerInbox } from '../infrastructure/messaging/inbox.js';
import { OutboxPublisher } from '../infrastructure/messaging/outbox.publisher.js';
import { RabbitMq } from '../infrastructure/messaging/rabbitmq.js';
import { logEvent, logRecovered, logRepeatedFailure } from '../infrastructure/logging/logger.js';

const database = new Database();
const rabbit = new RabbitMq();
const bidding = new BiddingService(database);
const manager = new ManagerService(database, bidding);
const publisher = new OutboxPublisher(database, rabbit);
const inbox = new ConsumerInbox(database);

const closeDueLots = async (): Promise<void> => {
  const due = await database.prisma.auctionLotExecution.findMany({
    where: {
      status: 'OPEN',
      endsAt: { lte: new Date() },
      auction: { OR: [{ mode: { not: 'LIVE' } }, { status: 'RUNNING' }] },
    },
    select: { id: true },
    take: 100,
  });
  for (const lot of due) {
    const failureKey = `worker:lot-close:${lot.id}`;
    try {
      const result = await bidding.closeLot(lot.id, `timer:${lot.id}`);
      logRecovered('worker', 'lot.close.recovered', failureKey, { lotId: lot.id });
      logEvent('info', 'worker', 'lot.closed', {
        lotId: lot.id,
        externalLotId: result.externalLotId,
        status: result.status,
        winningAmountCents: result.winningAmountCents,
        winnerDeclared: result.winnerDeclared,
        awardId: result.awardId,
        trigger: 'timer',
      });
    } catch (error) {
      logRepeatedFailure('worker', 'lot.close.failed', failureKey, error, { lotId: lot.id });
    }
  }
};

let lifecycleRunning = false;
const runLifecycle = async (): Promise<void> => {
  if (lifecycleRunning) return;
  lifecycleRunning = true;
  try {
    const preBid = await manager.expirePreBidWindows();
    if (preBid.finishedAuctions > 0 || preBid.pausedLiveLots > 0) {
      logEvent('info', 'worker', 'lifecycle.prebid_windows_expired', preBid);
    }
    await closeDueLots();
    logRecovered('worker', 'lifecycle.recovered', 'worker:lifecycle');
  } catch (error) {
    logRepeatedFailure('worker', 'lifecycle.failed', 'worker:lifecycle', error);
  } finally {
    lifecycleRunning = false;
  }
};

const start = async (): Promise<void> => {
  await database.connect();
  try {
    await rabbit.consume('auction.notifications.v1', async (envelope) => {
      await inbox.once('auction-engine.notifications.v1', envelope, async () => {
        if (['winner.declared', 'settlement.created', 'settlement.updated'].includes(envelope.eventType)) {
          logEvent('info', 'worker', 'auction.outcome.consumed', {
            eventId: envelope.eventId,
            eventType: envelope.eventType,
            queue: 'auction.notifications.v1',
          });
        }
      });
    });
  } catch (error) {
    logEvent('error', 'worker', 'notification_consumer.unavailable', { error, fallback: 'outbox_retry' });
  }
  void publisher.runLoop();
  setInterval(() => void runLifecycle(), 1000);
  logEvent('info', 'worker', 'service.ready', {
    outboxBatchSize: config.OUTBOX_BATCH_SIZE,
    lifecycleIntervalMs: 1000,
    database: 'connected',
  });
};

await start().catch(async (error: unknown) => {
  logEvent('error', 'worker', 'service.start_failed', { error });
  await rabbit.close().catch(() => undefined);
  await database.close().catch(() => undefined);
  process.exitCode = 1;
});

const shutdown = async (): Promise<void> => {
  logEvent('info', 'worker', 'service.stopping');
  publisher.stop();
  await rabbit.close();
  await database.close();
  logEvent('info', 'worker', 'service.stopped');
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
