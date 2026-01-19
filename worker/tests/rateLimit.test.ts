import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRateLimiter, clearRateLimitStore } from '../src/middleware/rateLimit.js';
import type { Env, Vars } from '../src/types.js';

// Mock context
function createMockContext(options: {
  ip?: string;
  workspaceId?: string;
} = {}): {
  req: { header: (name: string) => string | undefined };
  var: { workspaceId?: string };
  header: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  env: Env;
} {
  return {
    req: {
      header: (name: string) => {
        if (name === 'cf-connecting-ip') return options.ip;
        return undefined;
      },
    },
    var: { workspaceId: options.workspaceId },
    header: vi.fn(),
    json: vi.fn().mockReturnValue({ status: 429 } as any),
    set: vi.fn(),
    env: {} as Env,
  };
}

describe('Rate Limiter', () => {
  beforeEach(() => {
    clearRateLimitStore();
  });

  describe('createRateLimiter', () => {
    it('should allow requests under the limit', async () => {
      const limiter = createRateLimiter({
        limit: 5,
        windowMs: 60_000,
        keyPrefix: 'test',
      });

      const ctx = createMockContext({ ip: '1.2.3.4' });
      let nextCalled = false;
      const next = vi.fn().mockImplementation(async () => { nextCalled = true; });

      await limiter(ctx as any, next);

      expect(nextCalled).toBe(true);
      expect(ctx.header).toHaveBeenCalledWith('X-RateLimit-Limit', '5');
      expect(ctx.header).toHaveBeenCalledWith('X-RateLimit-Remaining', '4');
    });

    it('should decrement remaining count', async () => {
      const limiter = createRateLimiter({
        limit: 5,
        windowMs: 60_000,
        keyPrefix: 'test',
      });

      const ip = '1.2.3.4';

      for (let i = 0; i < 3; i++) {
        const ctx = createMockContext({ ip });
        const next = vi.fn();
        await limiter(ctx as any, next);
      }

      const ctx = createMockContext({ ip });
      const next = vi.fn();
      await limiter(ctx as any, next);

      expect(ctx.header).toHaveBeenCalledWith('X-RateLimit-Remaining', '1');
    });

    it('should block requests over the limit', async () => {
      const limiter = createRateLimiter({
        limit: 2,
        windowMs: 60_000,
        keyPrefix: 'test',
      });

      const ip = '1.2.3.4';

      // First 2 requests should pass
      for (let i = 0; i < 2; i++) {
        const ctx = createMockContext({ ip });
        const next = vi.fn();
        await limiter(ctx as any, next);
        expect(next).toHaveBeenCalled();
      }

      // Third request should be blocked
      const ctx = createMockContext({ ip });
      const next = vi.fn();
      const result = await limiter(ctx as any, next);

      expect(next).not.toHaveBeenCalled();
      expect(ctx.json).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: false,
          error: 'rate_limit_exceeded',
        }),
        429
      );
    });

    it('should track different IPs separately', async () => {
      const limiter = createRateLimiter({
        limit: 2,
        windowMs: 60_000,
        keyPrefix: 'test',
      });

      // Exhaust limit for IP 1
      for (let i = 0; i < 3; i++) {
        const ctx = createMockContext({ ip: '1.1.1.1' });
        await limiter(ctx as any, vi.fn());
      }

      // IP 2 should still work
      const ctx = createMockContext({ ip: '2.2.2.2' });
      const next = vi.fn();
      await limiter(ctx as any, next);

      expect(next).toHaveBeenCalled();
      expect(ctx.header).toHaveBeenCalledWith('X-RateLimit-Remaining', '1');
    });

    it('should use workspace ID when configured', async () => {
      const limiter = createRateLimiter({
        limit: 2,
        windowMs: 60_000,
        keyPrefix: 'test',
        useWorkspaceId: true,
      });

      // Same workspace ID from different IPs should share limit
      for (let i = 0; i < 2; i++) {
        const ctx = createMockContext({ ip: `1.1.1.${i}`, workspaceId: 'ws_shared' });
        const next = vi.fn();
        await limiter(ctx as any, next);
        expect(next).toHaveBeenCalled();
      }

      // Third request from different IP but same workspace should be blocked
      const ctx = createMockContext({ ip: '9.9.9.9', workspaceId: 'ws_shared' });
      const next = vi.fn();
      await limiter(ctx as any, next);

      expect(next).not.toHaveBeenCalled();
    });

    it('should set Retry-After header when rate limited', async () => {
      const limiter = createRateLimiter({
        limit: 1,
        windowMs: 60_000,
        keyPrefix: 'test',
      });

      const ip = '1.2.3.4';

      // First request
      await limiter(createMockContext({ ip }) as any, vi.fn());

      // Second request (blocked)
      const ctx = createMockContext({ ip });
      await limiter(ctx as any, vi.fn());

      expect(ctx.header).toHaveBeenCalledWith('Retry-After', expect.any(String));
    });

    it('should set rate limit context variable', async () => {
      const limiter = createRateLimiter({
        limit: 10,
        windowMs: 60_000,
        keyPrefix: 'test',
      });

      const ctx = createMockContext({ ip: '1.2.3.4' });
      await limiter(ctx as any, vi.fn());

      expect(ctx.set).toHaveBeenCalledWith('rateLimit', expect.objectContaining({
        remaining: expect.any(Number),
        reset: expect.any(Number),
      }));
    });
  });
});
