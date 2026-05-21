import { redis } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { config } from '@/config';

async function main() {
  await redis.ping();
  logger.info({ env: config.env }, 'Worker ready (no queues registered yet)');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Worker shutting down');
    await redis.quit();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Keep the process alive; future stories register BullMQ workers here.
  setInterval(() => {
    /* idle heartbeat */
  }, 1 << 30);
}

main().catch((err) => {
  logger.fatal({ err }, 'Worker boot failed');
  process.exit(1);
});
