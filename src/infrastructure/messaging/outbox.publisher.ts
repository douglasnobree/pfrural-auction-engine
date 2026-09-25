import { config } from '../../config.js';
import { Database } from '../database/db.js';
import type { EventEnvelope } from '../events/envelope.js';
import { logEvent, logRecovered, logRepeatedFailure } from '../logging/logger.js';
import { RabbitMq } from './rabbitmq.js';

function notificationType(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return 'unknown';
  const eventPayload = (payload as { payload?: unknown }).payload;
  if (!eventPayload || typeof eventPayload !== 'object') return 'unknown';
  const type = (eventPayload as { type?: unknown }).type;
  return typeof type === 'string' ? type : 'unknown';
}

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
        const safeMessage = message.replace(/\b(amqps?:\/\/)[^@\s/]+@/gi, '$1[credentials-redacted]@');
        if (attempts >= config.OUTBOX_MAX_ATTEMPTS) {
          await this.rabbit.publishDead(row.routingKey, row.payload as unknown as EventEnvelope, message).catch((deadLetterError: unknown) => {
            logEvent('error', 'outbox', 'event.dead_letter_publish_failed', {
              eventId: row.eventId,
              eventType: row.eventType,
              routingKey: row.routingKey,
              error: deadLetterError,
            });
          });
          await this.database.prisma.outboxEvent.update({ where: { id: row.id }, data: { publishedAt: new Date(), lastError: `DLQ: ${message}` } });
        } else {
          const delayMs = Math.min(60000, 1000 * 2 ** Math.min(attempts, 6));
          await this.database.prisma.outboxEvent.update({ where: { id: row.id }, data: { nextAttemptAt: new Date(Date.now() + delayMs), lastError: message } });
        }
        logEvent('error', 'outbox', attempts >= config.OUTBOX_MAX_ATTEMPTS ? 'event.dead_lettered' : 'event.publish_failed', {
          eventId: row.eventId,
          eventType: row.eventType,
          ...(row.eventType === 'participant.notification.requested'
            ? { notificationType: notificationType(row.payload) }
            : {}),
          routingKey: row.routingKey,
          attempt: attempts,
          maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
          sentToDeadLetterQueue: attempts >= config.OUTBOX_MAX_ATTEMPTS,
          error: safeMessage,
        });
      }
    }
    return published;
  }

  async runLoop(intervalMs = 250): Promise<void> {
    while (!this.stopped) {
      try {
        await this.runOnce();
        logRecovered('outbox', 'publisher.recovered', 'outbox:publisher.loop');
      } catch (error) {
        logRepeatedFailure('outbox', 'publisher.unavailable', 'outbox:publisher.loop', error);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  stop(): void { this.stopped = true; }
}
