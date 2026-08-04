import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { PrismaTransaction } from '../database/db.js';

export interface EventEnvelope<T = Record<string, unknown>> {
  eventId: string;
  eventType: string;
  schemaVersion: number;
  occurredAt: string;
  auctionId?: string;
  lotId?: string;
  aggregateVersion?: string;
  lotSequence?: string;
  correlationId: string;
  causationId?: string;
  traceId?: string;
  actorId?: string;
  payload: T;
}

export interface DomainEventInput<T = Record<string, unknown>> {
  eventType: string;
  routingKey: string;
  aggregateType: string;
  aggregateId: string;
  auctionId?: string;
  lotId?: string;
  aggregateVersion?: bigint;
  lotSequence?: bigint;
  correlationId: string;
  causationId?: string;
  traceId?: string;
  actorId?: string;
  payload: T;
  writeEventLog?: boolean;
}

export async function appendDomainEvent<T>(client: PrismaTransaction, input: DomainEventInput<T>): Promise<EventEnvelope<T>> {
  const eventId = randomUUID();
  const occurredAt = new Date().toISOString();
  const envelope: EventEnvelope<T> = {
    eventId,
    eventType: input.eventType,
    schemaVersion: 1,
    occurredAt,
    ...(input.auctionId ? { auctionId: input.auctionId } : {}),
    ...(input.lotId ? { lotId: input.lotId } : {}),
    ...(input.aggregateVersion !== undefined ? { aggregateVersion: input.aggregateVersion.toString() } : {}),
    ...(input.lotSequence !== undefined ? { lotSequence: input.lotSequence.toString() } : {}),
    correlationId: input.correlationId,
    ...(input.causationId ? { causationId: input.causationId } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
    ...(input.actorId ? { actorId: input.actorId } : {}),
    payload: input.payload,
  };

  await client.outboxEvent.create({ data: {
    eventId,
    eventType: input.eventType,
    schemaVersion: 1,
    routingKey: input.routingKey,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    auctionId: input.auctionId,
    lotId: input.lotId,
    aggregateVersion: input.aggregateVersion,
    lotSequence: input.lotSequence,
    correlationId: input.correlationId,
    causationId: input.causationId,
    traceId: input.traceId,
    actorId: input.actorId,
    payload: envelope as unknown as Prisma.InputJsonValue,
    occurredAt: new Date(occurredAt),
  } });

  if (input.writeEventLog !== false) {
    await client.auctionEventLog.create({ data: {
      eventId,
      auctionId: input.auctionId,
      lotId: input.lotId,
      lotSequence: input.lotSequence,
      eventType: input.eventType,
      schemaVersion: 1,
      payload: envelope as unknown as Prisma.InputJsonValue,
      occurredAt: new Date(occurredAt),
    } });
  }
  return envelope;
}
