import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(20),
  RABBITMQ_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  AUTH_MODE: z.enum(['mock', 'internal']).default('mock'),
  INTERNAL_SERVICE_TOKEN: z.string().min(8).default('local-development-token'),
  WS_TICKET_TTL_SECONDS: z.coerce.number().int().min(10).max(300).default(60),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(8),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(30),
  SANDBOX_ENABLED: z.preprocess((value) => value === undefined ? true : value === true || value === 'true', z.boolean()),
});

const parsed = schema.parse({
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://auction_engine:auction_engine@localhost:5433/auction_engine',
  RABBITMQ_URL: process.env.RABBITMQ_URL ?? 'amqp://auction_engine:auction_engine@localhost:5672',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
});

if (parsed.NODE_ENV === 'production' && parsed.AUTH_MODE === 'mock') {
  throw new Error('AUTH_MODE=mock is not allowed in production');
}

export const config = parsed;
export type Config = typeof config;
