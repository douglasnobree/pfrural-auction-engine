import { Prisma } from '@prisma/client';
import { Database, type PrismaTransaction } from '../database/db.js';
import type { EventEnvelope } from '../events/envelope.js';

export class ConsumerInbox {
  constructor(private readonly database: Database) {}

  async once<T>(consumerName: string, envelope: EventEnvelope, handler: (client: PrismaTransaction) => Promise<T>): Promise<T | null> {
    return this.database.transaction(async (client) => {
      try {
        await client.consumerInbox.create({ data: { messageId: envelope.eventId, consumerName } });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null;
        throw error;
      }
      return handler(client);
    });
  }
}
