import { config } from '../config.js';
import { createApp } from './app.js';
import { logEvent } from '../infrastructure/logging/logger.js';

const { app, context } = await createApp();
await app.listen({ port: config.PORT, host: config.HOST });
logEvent('info', 'api', 'service.ready', { host: config.HOST, port: config.PORT, environment: config.NODE_ENV });

const shutdown = async (): Promise<void> => {
  logEvent('info', 'api', 'service.stopping');
  await app.close();
  context.realtime.close();
  await context.rabbit.close();
  await context.database.close();
  await context.redis.close();
  logEvent('info', 'api', 'service.stopped');
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
