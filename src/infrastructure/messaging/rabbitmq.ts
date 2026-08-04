import amqp, { type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import { config } from '../../config.js';
import type { EventEnvelope } from '../events/envelope.js';

export const DOMAIN_EXCHANGE = 'auction.events.v1';
export const RETRY_EXCHANGE = 'auction.events.retry.v1';
export const DEAD_EXCHANGE = 'auction.events.dlx.v1';

export interface RabbitMessageHandler {
  (envelope: EventEnvelope, message: ConsumeMessage): Promise<void>;
}

export class RabbitMq {
  private connection: ChannelModel | null = null;
  private channel: ConfirmChannel | null = null;

  async connect(): Promise<void> {
    if (this.channel) return;
    const connection = await amqp.connect(config.RABBITMQ_URL);
    const channel = await connection.createConfirmChannel();
    this.connection = connection;
    this.channel = channel;
    await this.configureTopology(channel);
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
    await this.channel.assertQueue(queue, { durable: true });
    await this.channel.bindQueue(queue, DOMAIN_EXCHANGE, '#');
    await this.channel.consume(queue, async (message) => {
      if (!message) return;
      try {
        const envelope = JSON.parse(message.content.toString()) as EventEnvelope;
        await handler(envelope, message);
        this.channel?.ack(message);
      } catch (error) {
        const retryCount = Number(message.properties.headers?.['x-retry-count'] ?? 0);
        const envelope = JSON.parse(message.content.toString()) as EventEnvelope;
        if (retryCount < 5) await this.publishRetry(message.fields.routingKey, envelope, retryCount + 1);
        else await this.publishDead(message.fields.routingKey, envelope, error instanceof Error ? error.message : 'consumer failure');
        this.channel?.ack(message);
      }
    });
  }

  async close(): Promise<void> {
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
    this.channel = null;
    this.connection = null;
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
