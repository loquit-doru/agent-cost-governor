import type { MiddlewareHandler } from 'hono';
import type { Env, Vars } from '../types.js';
import { getRateLimitCheckPerMinute, getRateLimitBillingPerMinute } from '../lib/config.js';
import { getBillingStub, doUrl } from '../lib/do.js';

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

const localRateLimitStore = new Map<string, RateLimitBucket>();

function getLocalRateLimitBucket(key: string, windowMs: number): RateLimitBucket {
  const now = Date.now();
  const existing = localRateLimitStore.get(key);

  if (!existing || now >= existing.resetAt) {
    const next: RateLimitBucket = {
      count: 1,
      resetAt: now + windowMs,
    };
    localRateLimitStore.set(key, next);
    return next;
  }

  const updated: RateLimitBucket = {
    count: existing.count + 1,
    resetAt: existing.resetAt,
  };
  localRateLimitStore.set(key, updated);
  return updated;
}

async function getDistributedRateLimitBucket(
  env: Env,
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitBucket | null> {
  try {
    const stub = getBillingStub(env);
    const res = await stub.fetch(doUrl('/rate-limit/check'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, limit, window_ms: windowMs }),
    }).catch(() => null);

    if (!res) return null;

    const body = (await res.json().catch(() => null)) as { ok?: boolean; count?: number; reset_at_ms?: number } | null;
    if (!body || body.ok !== true || typeof body.count !== 'number' || typeof body.reset_at_ms !== 'number') return null;
    return { count: body.count, resetAt: body.reset_at_ms };
  } catch {
    return null;
  }
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
    const bucket =
      (await getDistributedRateLimitBucket(c.env, key, config.limit, config.windowMs)) ??
      getLocalRateLimitBucket(key, config.windowMs);

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
  localRateLimitStore.clear();
}
