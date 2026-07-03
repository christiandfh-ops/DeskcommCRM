/**
 * Per-tenant rate limit for agent dispatch (S-13.07).
 *
 * Fixed-window counter on Upstash Redis: `ai-runs:<org>:<window-start>` with
 * INCR + EXPIRE. Sub-minute granularity is good enough for the 60/min default
 * and avoids pulling in `@upstash/ratelimit` (no new deps for this wave).
 *
 * In-memory fallback mirrors `lib/ai/rag/debounce.ts` — loud warn so operators
 * notice when Redis is misconfigured and the limit is effectively per-instance.
 */

import { Redis } from "@upstash/redis";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

let _redis: Redis | null = null;
let _fallbackWarned = false;

function getRedis(): Redis | null {
  if (_redis) return _redis;
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    if (!_fallbackWarned) {
      logger.warn("[ai-dispatcher.rate-limit] Redis missing — using in-memory fallback (not safe for multi-instance)");
      _fallbackWarned = true;
    }
    return null;
  }
  _redis = new Redis({ url, token });
  return _redis;
}

interface MemBucket {
  count: number;
  expiresAt: number;
}
const _memBuckets = new Map<string, MemBucket>();

function memIncrement(key: string, windowSec: number): number {
  const now = Date.now();
  const existing = _memBuckets.get(key);
  if (!existing || existing.expiresAt <= now) {
    _memBuckets.set(key, { count: 1, expiresAt: now + windowSec * 1000 });
    return 1;
  }
  existing.count += 1;
  return existing.count;
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  window_sec: number;
}

/**
 * Increments the per-tenant counter for the current window and returns whether
 * the call is below the limit. Counter expires automatically — no cleanup
 * needed beyond Redis TTL.
 */
export async function checkRateLimit(
  bucket: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitResult> {
  const windowStart = Math.floor(Date.now() / (windowSec * 1000));
  const key = `${bucket}:${windowStart}`;

  const redis = getRedis();
  let count: number;
  if (!redis) {
    count = memIncrement(key, windowSec);
  } else {
    try {
      count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, windowSec);
      }
    } catch (err) {
      logger.warn("[ai-dispatcher.rate-limit] redis incr failed; falling back to in-memory", {
        error: err instanceof Error ? err.message : String(err),
        bucket,
      });
      count = memIncrement(key, windowSec);
    }
  }

  return {
    allowed: count <= limit,
    count,
    limit,
    window_sec: windowSec,
  };
}
