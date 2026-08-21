import { config } from '../config.js';
import { BiddingService } from '../application/bidding/bidding.service.js';
import { ManagerService } from '../application/manager/manager.service.js';
import { Database } from '../infrastructure/database/db.js';
import { ConsumerInbox } from '../infrastructure/messaging/inbox.js';
import { OutboxPublisher } from '../infrastructure/messaging/outbox.publisher.js';
import { RabbitMq } from '../infrastructure/messaging/rabbitmq.js';

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
  for (const lot of due) await bidding.closeLot(lot.id, `timer:${lot.id}`).catch((error: unknown) => console.error('lot close failed', lot.id, error));
};

let lifecycleRunning = false;
const runLifecycle = async (): Promise<void> => {
  if (lifecycleRunning) return;
  lifecycleRunning = true;
  try {
    await manager.expirePreBidWindows();
    await closeDueLots();
  } catch (error) {
    console.error('auction lifecycle failed', error);
  } finally {
    lifecycleRunning = false;
  }
};

const start = async (): Promise<void> => {
  await database.connect();
  try {
    await rabbit.consume('auction.notifications.v1', async (envelope) => {
      await inbox.once('auction-engine.notifications.v1', envelope, async () => {
        if (['winner.declared', 'settlement.created', 'settlement.updated'].includes(envelope.eventType)) console.log('notification event', envelope.eventType, envelope.eventId);
      });
    });
  } catch (error) {
    console.error('RabbitMQ consumer unavailable; outbox will retry', error);
  }
  void publisher.runLoop();
  setInterval(() => void runLifecycle(), 1000);
  console.log(`auction-engine-worker started with outbox batch ${config.OUTBOX_BATCH_SIZE}`);
};

await start();

const shutdown = async (): Promise<void> => {
  publisher.stop();
  await rabbit.close();
  await database.close();
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
