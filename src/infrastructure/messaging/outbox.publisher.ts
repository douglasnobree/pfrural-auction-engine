import { config } from '../../config.js';
import { Database } from '../database/db.js';
import type { EventEnvelope } from '../events/envelope.js';
import { RabbitMq } from './rabbitmq.js';

export class OutboxPublisher {
  private stopped = false;

  constructor(private readonly database: Database, private readonly rabbit: RabbitMq) {}

  async runOnce(): Promise<number> {
    const rows = await this.database.prisma.outboxEvent.findMany({ where: { publishedAt: null, nextAttemptAt: { lte: new Date() }, attempts: { lt: config.OUTBOX_MAX_ATTEMPTS } }, orderBy: [{ nextAttemptAt: 'asc' }, { occurredAt: 'asc' }], take: config.OUTBOX_BATCH_SIZE });
    let published = 0;
    for (const row of rows) {
      const claimed = await this.database.prisma.outboxEvent.updateMany({ where: { id: row.id, publishedAt: null, nextAttemptAt: { lte: new Date() } }, data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + 60000) } });
      if (claimed.count !== 1) continue;
      try {
        await this.rabbit.publish(row.routingKey, row.payload as unknown as EventEnvelope);
        await this.database.prisma.outboxEvent.update({ where: { id: row.id }, data: { publishedAt: new Date(), lastError: null } });
        published += 1;
      } catch (error) {
        const attempts = row.attempts + 1;
        const message = error instanceof Error ? error.message.slice(0, 1000) : 'publisher failure';
        if (attempts >= config.OUTBOX_MAX_ATTEMPTS) {
          await this.rabbit.publishDead(row.routingKey, row.payload as unknown as EventEnvelope, message).catch(() => undefined);
          await this.database.prisma.outboxEvent.update({ where: { id: row.id }, data: { publishedAt: new Date(), lastError: `DLQ: ${message}` } });
        } else {
          const delayMs = Math.min(60000, 1000 * 2 ** Math.min(attempts, 6));
          await this.database.prisma.outboxEvent.update({ where: { id: row.id }, data: { nextAttemptAt: new Date(Date.now() + delayMs), lastError: message } });
        }
      }
    }
    return published;
  }

  async runLoop(intervalMs = 250): Promise<void> {
    while (!this.stopped) {
      try { await this.runOnce(); } catch (error) { console.error('outbox publisher unavailable', error); }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  stop(): void { this.stopped = true; }
}
