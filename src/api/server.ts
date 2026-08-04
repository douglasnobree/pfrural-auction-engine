import { config } from '../config.js';
import { createApp } from './app.js';

const { app, context } = await createApp();
await app.listen({ port: config.PORT, host: config.HOST });
console.log(`auction-engine-api listening on ${config.HOST}:${config.PORT}`);

const shutdown = async (): Promise<void> => {
  await app.close();
  context.realtime.close();
  await context.rabbit.close();
  await context.database.close();
  await context.redis.close();
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
