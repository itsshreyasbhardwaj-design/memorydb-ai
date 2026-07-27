/**
 * Sliding-window rate limiting.
 *
 * A fixed window lets a caller send 2x the limit across a boundary (all of
 * window N at its end, all of window N+1 at its start). This uses a sliding
 * window with a weighted carry-over from the previous bucket, which smooths
 * that spike while keeping memory at O(1) per key — the same approach
 * Cloudflare uses.
 *
 * Backed by an in-process map. Correct for a single instance; behind multiple
 * replicas each enforces its own share, so set limits accordingly or plug in
 * Redis via `RateLimitStore`.
 */
import { env } from './env';

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix ms at which the current window resets. */
  resetAt: number;
  retryAfterSeconds: number;
}

interface Bucket {
  windowStart: number;
  count: number;
  previousCount: number;
}

export interface RateLimitStore {
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = Date.now();

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    this.maybeSweep(now, windowMs);

    const windowStart = Math.floor(now / windowMs) * windowMs;
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { windowStart, count: 0, previousCount: 0 };
      this.buckets.set(key, bucket);
    } else if (bucket.windowStart !== windowStart) {
      // Roll forward. A gap of more than one window means no recent history.
      bucket.previousCount = bucket.windowStart === windowStart - windowMs ? bucket.count : 0;
      bucket.windowStart = windowStart;
      bucket.count = 0;
    }

    // Weight the previous window by how much of it still falls inside the
    // trailing window: at 25% into the current window, 75% of the previous
    // one still counts.
    const elapsedFraction = (now - windowStart) / windowMs;
    const weighted = bucket.previousCount * (1 - elapsedFraction) + bucket.count;

    const resetAt = windowStart + windowMs;

    if (weighted >= limit) {
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
      };
    }

    bucket.count++;
    return {
      allowed: true,
      limit,
      remaining: Math.max(0, Math.floor(limit - weighted - 1)),
      resetAt,
      retryAfterSeconds: 0,
    };
  }

  /** Drop buckets that can no longer influence a decision. */
  private maybeSweep(now: number, windowMs: number): void {
    if (now - this.lastSweep < windowMs) return;
    this.lastSweep = now;
    const cutoff = now - windowMs * 2;
    for (const [key, bucket] of this.buckets) {
      if (bucket.windowStart < cutoff) this.buckets.delete(key);
    }
  }

  clear(): void {
    this.buckets.clear();
  }
}

const globalStore = globalThis as unknown as { __memorydbRateLimit?: MemoryRateLimitStore };
globalStore.__memorydbRateLimit ??= new MemoryRateLimitStore();

export const rateLimitStore: RateLimitStore = globalStore.__memorydbRateLimit;

/**
 * Derive the rate-limit key.
 *
 * Prefer the API key (a stable caller identity) and fall back to client IP.
 * Only the digest-like prefix is used so the full secret never lands in a map
 * key that might be logged.
 */
export function rateLimitKey(request: Request, identifier: string | undefined, bucket: string): string {
  if (identifier) return `${bucket}:key:${identifier}`;

  // Trust the leftmost XFF entry only behind a proxy that sets it; Vercel does.
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() ?? request.headers.get('x-real-ip') ?? 'unknown';
  return `${bucket}:ip:${ip}`;
}

export async function checkRateLimit(
  request: Request,
  options: { identifier?: string | undefined; write?: boolean } = {},
): Promise<RateLimitResult> {
  const limit = options.write ? env.RATE_LIMIT_WRITE_MAX : env.RATE_LIMIT_MAX_REQUESTS;
  const windowMs = env.RATE_LIMIT_WINDOW_SECONDS * 1000;

  if (!env.RATE_LIMIT_ENABLED) {
    return { allowed: true, limit, remaining: limit, resetAt: Date.now() + windowMs, retryAfterSeconds: 0 };
  }

  const key = rateLimitKey(request, options.identifier, options.write ? 'w' : 'r');
  return rateLimitStore.consume(key, limit, windowMs);
}

/** Standard `RateLimit-*` headers, plus `Retry-After` when rejected. */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    'RateLimit-Limit': String(result.limit),
    'RateLimit-Remaining': String(result.remaining),
    'RateLimit-Reset': String(Math.ceil((result.resetAt - Date.now()) / 1000)),
  };
  if (!result.allowed) headers['Retry-After'] = String(result.retryAfterSeconds);
  return headers;
}
