import { Redis } from 'ioredis';
import { config } from '../../config.js';

export class RedisService {
  private readonly redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  private readonly fallback = new Map<string, { count: number; expiresAt: number }>();

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
    await this.redis.quit().catch(() => undefined);
  }
}
