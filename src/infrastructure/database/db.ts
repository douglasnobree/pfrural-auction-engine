import { Prisma, PrismaClient } from '@prisma/client';
import { config } from '../../config.js';

export type PrismaTransaction = Prisma.TransactionClient;

export class Database {
  readonly prisma = new PrismaClient({ datasources: { db: { url: config.DATABASE_URL } } });

  async transaction<T>(work: (client: PrismaTransaction) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  async connect(): Promise<void> {
    await this.prisma.$connect();
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
