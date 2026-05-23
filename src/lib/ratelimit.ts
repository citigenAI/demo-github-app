import { redis } from '@/lib/redis';
import { config } from '@/config';
import { logger } from '@/lib/logger';

export async function checkContributorRateLimit(ip: string): Promise<{ allowed: boolean }> {
  const max = config.contributor.rateLimitMax;
  const windowSec = config.contributor.rateLimitWindowSec;
  const key = `contrib_rl:${ip}`;

  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, windowSec);
    }
    if (count > max) {
      logger.warn({ key, count }, 'Contributor rate limit exceeded');
      return { allowed: false };
    }
    return { allowed: true };
  } catch {
    logger.warn({ key }, 'Rate limiter store unavailable — failing open');
    return { allowed: true };
  }
}
