import IORedis from 'ioredis';
import { config } from '@/config';

const globalForRedis = globalThis as unknown as { redis?: IORedis };

export const redis =
  globalForRedis.redis ??
  new IORedis(config.redis.url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    // Avoid noisy connection attempts at module-load time (e.g. during `next build`).
    // Connections are established on first command.
    lazyConnect: true,
  });

// Suppress unhandled-error spam when Redis is unreachable; callers handle errors
// via try/catch around individual commands.
redis.on('error', () => {
  /* errors surface via the promise of the failing command */
});

if (config.env !== 'production') {
  globalForRedis.redis = redis;
}
