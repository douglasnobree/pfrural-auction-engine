import amqp, { type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import { config } from '../../config.js';
import type { EventEnvelope } from '../events/envelope.js';
import { clearRepeatedFailure, logEvent, logRecovered, logRepeatedFailure } from '../logging/logger.js';

export const DOMAIN_EXCHANGE = 'auction.events.v1';
export const RETRY_EXCHANGE = 'auction.events.retry.v1';
export const DEAD_EXCHANGE = 'auction.events.dlx.v1';

export interface RabbitMessageHandler {
  (envelope: EventEnvelope, message: ConsumeMessage): Promise<void>;
}

function errorDetails(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) };

  const details: Record<string, unknown> = {
    name: error.name,
    message: error.message.replace(/\b(amqps?:\/\/)[^@\s/]+@/gi, '$1[credentials-redacted]@'),
  };
  const rabbitError = error as Error & {
    code?: unknown;
    errno?: unknown;
    syscall?: unknown;
    address?: unknown;
    port?: unknown;
    replyCode?: unknown;
    classId?: unknown;
    methodId?: unknown;
    cause?: unknown;
  };

  for (const field of ['code', 'errno', 'syscall', 'address', 'port', 'replyCode', 'classId', 'methodId'] as const) {
    const value = rabbitError[field];
    if (typeof value === 'string' || typeof value === 'number') details[field] = value;
  }
  if (depth < 2 && rabbitError.cause !== undefined) details.cause = errorDetails(rabbitError.cause, depth + 1);
  return details;
}

function rabbitTarget(): { protocol: string; host: string; port: number } {
  const url = new URL(config.RABBITMQ_URL);
  return {
    protocol: url.protocol.slice(0, -1),
    host: url.hostname,
    port: Number(url.port || (url.protocol === 'amqps:' ? 5671 : 5672)),
  };
}

export class RabbitMq {
  private connection: ChannelModel | null = null;
  private channel: ConfirmChannel | null = null;
  private connectionUnavailable = false;
  private hasConnected = false;
  private lastFailureSignature: string | null = null;
  private closing = false;

  async connect(): Promise<void> {
    if (this.channel) return;
    let connection: ChannelModel;
    try {
      connection = await amqp.connect(config.RABBITMQ_URL);
    } catch (error) {
      this.logConnectionError(error, 'amqp_handshake');
      throw error;
    }
    let intentionalClose = false;
    connection.on('error', (error: Error) => this.logConnectionError(error, 'connection_runtime'));
    connection.on('close', () => {
      if (!this.closing && !intentionalClose && !this.connectionUnavailable) {
        this.connectionUnavailable = true;
        logEvent('warn', 'rabbitmq', 'connection.lost', { target: rabbitTarget() });
      }
    });
    let channel: ConfirmChannel;
    try {
      channel = await connection.createConfirmChannel();
    } catch (error) {
      this.logConnectionError(error, 'confirm_channel_setup');
      intentionalClose = true;
      await connection.close().catch(() => undefined);
      throw error;
    }
    channel.on('error', (error: Error) => this.logConnectionError(error, 'channel_runtime'));
    try {
      await this.configureTopology(channel);
    } catch (error) {
      this.logConnectionError(error, 'topology_setup');
      intentionalClose = true;
      await channel.close().catch(() => undefined);
      await connection.close().catch(() => undefined);
      throw error;
    }
    this.connection = connection;
    this.channel = channel;
    logEvent('info', 'rabbitmq', this.hasConnected ? 'connection.restored' : 'connection.ready', { target: rabbitTarget(), topology: 'ready' });
    this.hasConnected = true;
    this.connectionUnavailable = false;
    this.lastFailureSignature = null;
  }

  isConnected(): boolean {
    return this.channel !== null;
  }

  async publish(routingKey: string, envelope: EventEnvelope, headers?: Record<string, unknown>): Promise<void> {
    await this.connect();
    if (!this.channel) throw new Error('RabbitMQ channel unavailable');
    this.channel.publish(DOMAIN_EXCHANGE, routingKey, Buffer.from(JSON.stringify(envelope)), { persistent: true, contentType: 'application/json', headers });
    await this.channel.waitForConfirms();
  }

  async publishRetry(routingKey: string, envelope: EventEnvelope, retryCount: number): Promise<void> {
    await this.connect();
    if (!this.channel) throw new Error('RabbitMQ channel unavailable');
    this.channel.publish(RETRY_EXCHANGE, routingKey, Buffer.from(JSON.stringify(envelope)), { persistent: true, contentType: 'application/json', headers: { 'x-retry-count': retryCount } });
    await this.channel.waitForConfirms();
  }

  async publishDead(routingKey: string, envelope: EventEnvelope, error: string): Promise<void> {
    await this.connect();
    if (!this.channel) throw new Error('RabbitMQ channel unavailable');
    this.channel.publish(DEAD_EXCHANGE, routingKey, Buffer.from(JSON.stringify(envelope)), { persistent: true, contentType: 'application/json', headers: { 'x-error': error } });
    await this.channel.waitForConfirms();
  }

  async consume(queue: string, handler: RabbitMessageHandler): Promise<void> {
    await this.connect();
    if (!this.channel) throw new Error('RabbitMQ channel unavailable');
    try {
      await this.channel.assertQueue(queue, { durable: true });
      await this.channel.bindQueue(queue, DOMAIN_EXCHANGE, '#');
      await this.channel.consume(queue, async (message) => {
        if (!message) return;
        try {
          const envelope = JSON.parse(message.content.toString()) as EventEnvelope;
          await handler(envelope, message);
          this.channel?.ack(message);
          logRecovered('rabbitmq', 'consumer.message.recovered', `rabbitmq:${queue}:${envelope.eventId}`, {
            queue,
            eventId: envelope.eventId,
            eventType: envelope.eventType,
          });
        } catch (error) {
          const retryCount = Number(message.properties.headers?.['x-retry-count'] ?? 0);
          const envelope = JSON.parse(message.content.toString()) as EventEnvelope;
          const failureKey = `rabbitmq:${queue}:${envelope.eventId}`;
          const details = errorDetails(error);
          const failureFields = {
            queue,
            routingKey: message.fields.routingKey,
            eventId: envelope.eventId,
            eventType: envelope.eventType,
            retryCount,
            ...Object.fromEntries(Object.entries(details).filter(([key]) => key !== 'name' && key !== 'message')),
          };
          if (retryCount < 5) {
            logRepeatedFailure('rabbitmq', 'consumer.message.retrying', failureKey, error, { ...failureFields, nextAction: 'retry', maxRetries: 5 });
            await this.publishRetry(message.fields.routingKey, envelope, retryCount + 1);
          } else {
            clearRepeatedFailure(failureKey);
            logEvent('error', 'rabbitmq', 'consumer.message.dead_lettered', { ...failureFields, ...details, nextAction: 'dead_letter' });
            await this.publishDead(message.fields.routingKey, envelope, error instanceof Error ? error.message : 'consumer failure');
          }
          this.channel?.ack(message);
        }
      });
    } catch (error) {
      this.logConnectionError(error, 'consumer_setup', { queue });
      throw error;
    }
    logEvent('info', 'rabbitmq', 'consumer.ready', { queue });
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
    this.channel = null;
    this.connection = null;
    this.closing = false;
  }

  private logConnectionError(error: unknown, phase: string, context: Record<string, unknown> = {}): void {
    this.connectionUnavailable = true;
    const details = errorDetails(error);
    const signature = JSON.stringify({ phase, context, details });
    if (signature === this.lastFailureSignature) return;
    this.lastFailureSignature = signature;
    logEvent('error', 'rabbitmq', 'connection.failed', { phase, target: rabbitTarget(), ...context, ...details });
  }

  private async configureTopology(channel: ConfirmChannel): Promise<void> {
    await channel.assertExchange(DOMAIN_EXCHANGE, 'topic', { durable: true });
    await channel.assertExchange(RETRY_EXCHANGE, 'topic', { durable: true });
    await channel.assertExchange(DEAD_EXCHANGE, 'topic', { durable: true });
    const retryQueue = 'auction.events.retry.v1';
    const deadQueue = 'auction.events.dlq.v1';
    await channel.assertQueue(retryQueue, { durable: true, arguments: { 'x-message-ttl': 5000, 'x-dead-letter-exchange': DOMAIN_EXCHANGE } });
    await channel.bindQueue(retryQueue, RETRY_EXCHANGE, '#');
    await channel.assertQueue(deadQueue, { durable: true });
    await channel.bindQueue(deadQueue, DEAD_EXCHANGE, '#');
  }
}
