import { describe, expect, it, vi } from 'vitest';
import { config } from '../config.js';
import { createApp, type AppContext } from './app.js';

describe('internal execution deletion endpoint', () => {
  it('requires the internal token even in mock auth mode and accepts retries', async () => {
    const purge = vi.fn().mockResolvedValue({ eventIds: [] });
    const { app, context } = await createApp({
      rabbit: { consume: vi.fn().mockResolvedValue(undefined) },
      executions: { purge },
      redis: { consumeRateLimit: vi.fn().mockResolvedValue(true) },
      hub: { closeAll: vi.fn() },
    } as unknown as AppContext);
    try {
      const url = '/v1/internal/auctions/by-external/external-auction';
      const denied = await app.inject({ method: 'DELETE', url });
      expect(denied.statusCode).toBe(401);
      expect(purge).not.toHaveBeenCalled();
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await app.inject({ method: 'DELETE', url, headers: { 'x-internal-token': config.INTERNAL_SERVICE_TOKEN } });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ eventIds: [] });
      }
      expect(purge).toHaveBeenCalledWith('external-auction');
    } finally {
      context.realtime.close();
      await app.close();
    }
  });
});
