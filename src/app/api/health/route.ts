import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

const HEALTH_CHECK_TIMEOUT_MS = 2000;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms),
    ),
  ]);
}

export async function GET() {
  const [dbCheck, redisCheck] = await Promise.allSettled([
    withTimeout(db.$queryRaw`SELECT 1`, HEALTH_CHECK_TIMEOUT_MS),
    withTimeout(redis.ping(), HEALTH_CHECK_TIMEOUT_MS),
  ]);

  const dbStatus = dbCheck.status === 'fulfilled' ? 'connected' : 'down';
  const redisStatus = redisCheck.status === 'fulfilled' ? 'connected' : 'down';
  const allHealthy = dbStatus === 'connected' && redisStatus === 'connected';

  return NextResponse.json(
    {
      status: allHealthy ? 'ok' : 'degraded',
      db: dbStatus,
      redis: redisStatus,
    },
    { status: allHealthy ? 200 : 503 },
  );
}
