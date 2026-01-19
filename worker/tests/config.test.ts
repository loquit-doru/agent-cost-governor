import { describe, it, expect, beforeEach } from 'vitest';
import {
  isOriginAllowed,
  getAllowedOrigins,
  getRetryPricingConfig,
  getConfidencePricingConfig,
  getTtlSeconds,
  getBillingMode,
  getApiAuthMode,
  getRateLimitCheckPerMinute,
} from '../src/lib/config.js';
import type { Env } from '../src/types.js';

describe('CORS configuration', () => {
  describe('getAllowedOrigins', () => {
    it('should return default origins when no custom config', () => {
      const env = {} as Env;
      const origins = getAllowedOrigins(env);

      expect(origins.has('https://proceedgate.dev')).toBe(true);
      expect(origins.has('https://www.proceedgate.dev')).toBe(true);
      expect(origins.has('http://localhost:8787')).toBe(true);
    });

    it('should include custom origins when configured', () => {
      const env = {
        CORS_ALLOWED_ORIGINS: 'https://example.com,https://app.example.com',
      } as Env;
      const origins = getAllowedOrigins(env);

      expect(origins.has('https://example.com')).toBe(true);
      expect(origins.has('https://app.example.com')).toBe(true);
      // Should still have defaults
      expect(origins.has('https://proceedgate.dev')).toBe(true);
    });

    it('should handle empty custom origins', () => {
      const env = { CORS_ALLOWED_ORIGINS: '' } as Env;
      const origins = getAllowedOrigins(env);

      expect(origins.size).toBeGreaterThan(0);
      expect(origins.has('https://proceedgate.dev')).toBe(true);
    });

    it('should trim whitespace from origins', () => {
      const env = {
        CORS_ALLOWED_ORIGINS: '  https://example.com  ,  https://test.com  ',
      } as Env;
      const origins = getAllowedOrigins(env);

      expect(origins.has('https://example.com')).toBe(true);
      expect(origins.has('https://test.com')).toBe(true);
    });
  });

  describe('isOriginAllowed', () => {
    it('should allow empty origin (same-origin)', () => {
      const env = {} as Env;
      expect(isOriginAllowed(env, '')).toBe(true);
    });

    it('should allow default origins', () => {
      const env = {} as Env;
      expect(isOriginAllowed(env, 'https://proceedgate.dev')).toBe(true);
      expect(isOriginAllowed(env, 'http://localhost:8787')).toBe(true);
    });

    it('should reject unknown origins', () => {
      const env = {} as Env;
      expect(isOriginAllowed(env, 'https://evil.com')).toBe(false);
      expect(isOriginAllowed(env, 'https://fake-proceedgate.dev')).toBe(false);
    });

    it('should NOT allow wildcard subdomains (security)', () => {
      const env = {} as Env;
      // This is the key security test - we don't want subdomain wildcards
      expect(isOriginAllowed(env, 'https://attacker.proceedgate.dev')).toBe(false);
    });

    it('should allow custom origins when configured', () => {
      const env = { CORS_ALLOWED_ORIGINS: 'https://myapp.com' } as Env;
      expect(isOriginAllowed(env, 'https://myapp.com')).toBe(true);
    });
  });
});

describe('Pricing configuration', () => {
  describe('getRetryPricingConfig', () => {
    it('should return defaults when no config', () => {
      const env = {} as Env;
      const config = getRetryPricingConfig(env);

      expect(config.freeAttempts).toBe(3);
      expect(config.base).toBe(0.001);
      expect(config.growth).toBe(1.8);
      expect(config.maxPrice).toBe(0.02);
    });

    it('should use custom values when provided', () => {
      const env = {
        PRICING_FREE_ATTEMPTS: '5',
        PRICING_BASE: '0.005',
        PRICING_GROWTH: '2.0',
        PRICING_MAX: '0.1',
      } as Env;
      const config = getRetryPricingConfig(env);

      expect(config.freeAttempts).toBe(5);
      expect(config.base).toBe(0.005);
      expect(config.growth).toBe(2.0);
      expect(config.maxPrice).toBe(0.1);
    });

    it('should handle invalid values gracefully', () => {
      const env = {
        PRICING_FREE_ATTEMPTS: 'invalid',
        PRICING_BASE: 'not-a-number',
      } as Env;
      const config = getRetryPricingConfig(env);

      // Should fall back to defaults
      expect(config.freeAttempts).toBe(3);
      expect(config.base).toBe(0.001);
    });
  });

  describe('getConfidencePricingConfig', () => {
    it('should return defaults when no config', () => {
      const env = {} as Env;
      const config = getConfidencePricingConfig(env);

      expect(config.threshold).toBe(0.45);
      expect(config.base).toBe(0.002);
      expect(config.maxPrice).toBe(0.05);
      expect(config.mult).toBe(2.0);
    });

    it('should clamp threshold to [0, 1]', () => {
      const env1 = { PRICING_CONFIDENCE_THRESHOLD: '2.0' } as Env;
      const env2 = { PRICING_CONFIDENCE_THRESHOLD: '-0.5' } as Env;

      expect(getConfidencePricingConfig(env1).threshold).toBe(1);
      expect(getConfidencePricingConfig(env2).threshold).toBe(0);
    });
  });
});

describe('TTL configuration', () => {
  it('should return default TTL', () => {
    const env = {} as Env;
    expect(getTtlSeconds(env)).toBe(45);
  });

  it('should use custom TTL', () => {
    const env = { PROCEED_TOKEN_TTL_SECONDS: '120' } as Env;
    expect(getTtlSeconds(env)).toBe(120);
  });

  it('should clamp to minimum of 10', () => {
    const env = { PROCEED_TOKEN_TTL_SECONDS: '5' } as Env;
    expect(getTtlSeconds(env)).toBe(10);
  });

  it('should clamp to maximum of 300', () => {
    const env = { PROCEED_TOKEN_TTL_SECONDS: '600' } as Env;
    expect(getTtlSeconds(env)).toBe(300);
  });
});

describe('Billing mode configuration', () => {
  it('should default to off', () => {
    const env = {} as Env;
    expect(getBillingMode(env)).toBe('off');
  });

  it('should return credits when configured', () => {
    const env = { BILLING_MODE: 'credits' } as Env;
    expect(getBillingMode(env)).toBe('credits');
  });

  it('should handle case insensitivity', () => {
    const env = { BILLING_MODE: 'CREDITS' } as Env;
    expect(getBillingMode(env)).toBe('credits');
  });

  it('should default to off for unknown values', () => {
    const env = { BILLING_MODE: 'unknown' } as Env;
    expect(getBillingMode(env)).toBe('off');
  });
});

describe('Auth mode configuration', () => {
  it('should default to off', () => {
    const env = {} as Env;
    expect(getApiAuthMode(env)).toBe('off');
  });

  it('should return shared when configured', () => {
    const env = { API_AUTH_MODE: 'shared' } as Env;
    expect(getApiAuthMode(env)).toBe('shared');
  });

  it('should return workspace when configured', () => {
    const env = { API_AUTH_MODE: 'workspace' } as Env;
    expect(getApiAuthMode(env)).toBe('workspace');
  });
});

describe('Rate limit configuration', () => {
  it('should return default rate limits', () => {
    const env = {} as Env;
    expect(getRateLimitCheckPerMinute(env)).toBe(100);
  });

  it('should use custom rate limits', () => {
    const env = { RATE_LIMIT_CHECK_PER_MINUTE: '50' } as Env;
    expect(getRateLimitCheckPerMinute(env)).toBe(50);
  });

  it('should handle invalid values', () => {
    const env = { RATE_LIMIT_CHECK_PER_MINUTE: 'invalid' } as Env;
    expect(getRateLimitCheckPerMinute(env)).toBe(100);
  });
});
