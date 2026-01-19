import type { MiddlewareHandler } from 'hono';
import type { Env, Vars } from '../types.js';
import { getRateLimitCheckPerMinute, getRateLimitBillingPerMinute } from '../lib/config.js';

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

// In-memory rate limit store (per isolate)
// In production, consider using Durable Objects or external store for distributed rate limiting
const rateLimitStore = new Map<string, RateLimitBucket>();

// Cleanup old entries periodically
let lastCleanup = Date.now();
const CLEANUP_INTERVAL_MS = 60_000;

function cleanupExpired(): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;

  for (const [key, bucket] of rateLimitStore) {
    if (bucket.resetAt <= now) {
      rateLimitStore.delete(key);
    }
  }
}

function getRateLimitBucket(key: string, windowMs: number): RateLimitBucket {
  cleanupExpired();

  const now = Date.now();
  const existing = rateLimitStore.get(key);

  if (existing && existing.resetAt > now) {
    return existing;
  }

  const bucket: RateLimitBucket = {
    count: 0,
    resetAt: now + windowMs,
  };
  rateLimitStore.set(key, bucket);
  return bucket;
}

function getClientIdentifier(c: { req: { header: (name: string) => string | undefined } }): string {
  // Try CF-Connecting-IP first (Cloudflare)
  const cfIp = c.req.header('cf-connecting-ip');
  if (cfIp) return cfIp;

  // Fallback to X-Forwarded-For
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0]?.trim() || 'unknown';

  // Last resort
  return 'unknown';
}

export type RateLimitConfig = {
  /** Requests allowed per window */
  limit: number;
  /** Window duration in milliseconds */
  windowMs: number;
  /** Key prefix for the rate limit bucket */
  keyPrefix: string;
  /** Optional: use workspace ID instead of IP */
  useWorkspaceId?: boolean;
};

/**
 * Create a rate limiting middleware.
 */
export function createRateLimiter(config: RateLimitConfig): MiddlewareHandler<{ Bindings: Env; Variables: Vars }> {
  return async (c, next) => {
    let identifier: string;

    if (config.useWorkspaceId && c.var.workspaceId) {
      identifier = `ws:${c.var.workspaceId}`;
    } else {
      identifier = `ip:${getClientIdentifier(c)}`;
    }

    const key = `${config.keyPrefix}:${identifier}`;
    const bucket = getRateLimitBucket(key, config.windowMs);

    bucket.count++;

    // Set rate limit headers
    const remaining = Math.max(0, config.limit - bucket.count);
    const resetSeconds = Math.ceil((bucket.resetAt - Date.now()) / 1000);

    c.header('X-RateLimit-Limit', String(config.limit));
    c.header('X-RateLimit-Remaining', String(remaining));
    c.header('X-RateLimit-Reset', String(resetSeconds));

    // Store in context for potential use
    c.set('rateLimit', { remaining, reset: bucket.resetAt });

    if (bucket.count > config.limit) {
      c.header('Retry-After', String(resetSeconds));
      return c.json(
        {
          ok: false,
          error: 'rate_limit_exceeded',
          retry_after_seconds: resetSeconds,
        },
        429,
      );
    }

    await next();
  };
}

/**
 * Rate limiter for /check endpoint (per IP).
 */
export function checkRateLimiter(env: Env): MiddlewareHandler<{ Bindings: Env; Variables: Vars }> {
  const limit = getRateLimitCheckPerMinute(env);
  return createRateLimiter({
    limit,
    windowMs: 60_000,
    keyPrefix: 'check',
    useWorkspaceId: false,
  });
}

/**
 * Rate limiter for billing endpoints (per workspace).
 */
export function billingRateLimiter(env: Env): MiddlewareHandler<{ Bindings: Env; Variables: Vars }> {
  const limit = getRateLimitBillingPerMinute(env);
  return createRateLimiter({
    limit,
    windowMs: 60_000,
    keyPrefix: 'billing',
    useWorkspaceId: true,
  });
}

/**
 * Clear rate limit store (useful for testing).
 */
export function clearRateLimitStore(): void {
  rateLimitStore.clear();
}
