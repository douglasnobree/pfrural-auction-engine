import { Redis } from 'ioredis';
import { config } from '../../config.js';
import { logEvent } from '../logging/logger.js';

export class RedisService {
  private readonly redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  private readonly fallback = new Map<string, { count: number; expiresAt: number }>();
  private unavailable = false;
  private closing = false;

  constructor() {
    this.redis.on('ready', () => {
      logEvent('info', 'redis', this.unavailable ? 'connection.restored' : 'connection.ready');
      this.unavailable = false;
    });
    this.redis.on('error', (error: Error) => {
      if (this.unavailable) return;
      this.unavailable = true;
      logEvent('error', 'redis', 'connection.failed', { error });
    });
    this.redis.on('close', () => {
      if (this.closing || this.unavailable) return;
      this.unavailable = true;
      logEvent('warn', 'redis', 'connection.lost');
    });
  }

  async connect(): Promise<void> {
    try { await this.redis.connect(); } catch { /* Redis is auxiliary and may be unavailable. */ }
  }

  async consumeRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    try {
      if (this.redis.status === 'wait') await this.redis.connect();
      const bucket = `rate:${key}`;
      const count = await this.redis.incr(bucket);
      if (count === 1) await this.redis.expire(bucket, windowSeconds);
      return count <= limit;
    } catch {
      const now = Date.now();
      const current = this.fallback.get(key);
      if (!current || current.expiresAt <= now) {
        this.fallback.set(key, { count: 1, expiresAt: now + windowSeconds * 1000 });
        return true;
      }
      current.count += 1;
      return current.count <= limit;
    }
  }

  async markPresence(auctionId: string, userId: string, ttlSeconds = 60): Promise<void> {
    try {
      if (this.redis.status === 'wait') await this.redis.connect();
      await this.redis.set(`presence:${auctionId}:${userId}`, '1', 'EX', ttlSeconds);
    } catch { /* Presence loss must not affect the financial ledger. */ }
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.redis.quit().catch((error: unknown) => {
      logEvent('warn', 'redis', 'connection.close_failed', { error });
    });
  }
}
