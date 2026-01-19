import { describe, it, expect } from 'vitest';
import {
  computeRetryFrictionPrice,
  computeLowConfidencePrice,
} from '../src/lib/pricing.js';
import type { Env } from '../src/types.js';

// Mock env with default pricing config
const mockEnv = {} as Env;

describe('computeRetryFrictionPrice', () => {
  describe('with default config (freeAttempts=3, base=0.001, growth=1.8, max=0.02)', () => {
    it('should return no friction for attempt 1', () => {
      const result = computeRetryFrictionPrice(mockEnv, 1);
      expect(result.required).toBe(false);
      expect(result.price).toBe('0 USDC');
      expect(result.explain).toContain('attempt 1');
      expect(result.explain).toContain('free<=3');
    });

    it('should return no friction for attempt 2', () => {
      const result = computeRetryFrictionPrice(mockEnv, 2);
      expect(result.required).toBe(false);
      expect(result.price).toBe('0 USDC');
    });

    it('should return no friction for attempt 3 (last free)', () => {
      const result = computeRetryFrictionPrice(mockEnv, 3);
      expect(result.required).toBe(false);
      expect(result.price).toBe('0 USDC');
    });

    it('should require friction for attempt 4', () => {
      const result = computeRetryFrictionPrice(mockEnv, 4);
      expect(result.required).toBe(true);
      // base * growth^1 = 0.001 * 1.8 = 0.0018
      expect(result.price).toMatch(/^0\.00\d+ USDC$/);
    });

    it('should increase price exponentially', () => {
      const r4 = computeRetryFrictionPrice(mockEnv, 4);
      const r5 = computeRetryFrictionPrice(mockEnv, 5);
      const r6 = computeRetryFrictionPrice(mockEnv, 6);

      // Extract numeric values
      const p4 = parseFloat(r4.price);
      const p5 = parseFloat(r5.price);
      const p6 = parseFloat(r6.price);

      expect(p5).toBeGreaterThan(p4);
      expect(p6).toBeGreaterThan(p5);
    });

    it('should cap at maxPrice', () => {
      const result = computeRetryFrictionPrice(mockEnv, 100);
      expect(result.required).toBe(true);
      expect(result.price).toBe('0.02 USDC');
    });

    it('should include explanation with curve parameters', () => {
      const result = computeRetryFrictionPrice(mockEnv, 5);
      expect(result.explain).toContain('base=');
      expect(result.explain).toContain('growth=');
      expect(result.explain).toContain('max=');
    });
  });

  describe('with custom config', () => {
    it('should respect custom freeAttempts', () => {
      const envWithCustom = { PRICING_FREE_ATTEMPTS: '5' } as Env;
      
      const r5 = computeRetryFrictionPrice(envWithCustom, 5);
      expect(r5.required).toBe(false);
      
      const r6 = computeRetryFrictionPrice(envWithCustom, 6);
      expect(r6.required).toBe(true);
    });

    it('should respect custom base price', () => {
      const envWithCustom = { PRICING_BASE: '0.01' } as Env;
      const result = computeRetryFrictionPrice(envWithCustom, 4);
      expect(result.required).toBe(true);
      // Should be higher than default (0.001)
      const price = parseFloat(result.price);
      expect(price).toBeGreaterThan(0.01);
    });

    it('should respect custom maxPrice', () => {
      const envWithCustom = { PRICING_MAX: '0.1' } as Env;
      const result = computeRetryFrictionPrice(envWithCustom, 100);
      expect(result.price).toBe('0.1 USDC');
    });
  });
});

describe('computeLowConfidencePrice', () => {
  describe('with default config (threshold=0.45, base=0.002, max=0.05, mult=2.0)', () => {
    it('should return no friction when confidence is undefined', () => {
      const result = computeLowConfidencePrice(mockEnv, {
        confidence: undefined,
        attemptInWindow: 1,
      });
      expect(result.required).toBe(false);
      expect(result.price).toBe('0 USDC');
      expect(result.explain).toContain('confidence missing');
    });

    it('should return no friction when confidence >= threshold', () => {
      const result = computeLowConfidencePrice(mockEnv, {
        confidence: 0.5,
        attemptInWindow: 1,
      });
      expect(result.required).toBe(false);
      expect(result.price).toBe('0 USDC');
      expect(result.explain).toContain('>=');
    });

    it('should return no friction at exactly threshold', () => {
      const result = computeLowConfidencePrice(mockEnv, {
        confidence: 0.45,
        attemptInWindow: 1,
      });
      expect(result.required).toBe(false);
    });

    it('should require friction when confidence < threshold', () => {
      const result = computeLowConfidencePrice(mockEnv, {
        confidence: 0.3,
        attemptInWindow: 1,
      });
      expect(result.required).toBe(true);
      expect(result.price).toMatch(/USDC$/);
    });

    it('should increase price with lower confidence', () => {
      const r1 = computeLowConfidencePrice(mockEnv, { confidence: 0.4, attemptInWindow: 1 });
      const r2 = computeLowConfidencePrice(mockEnv, { confidence: 0.2, attemptInWindow: 1 });
      const r3 = computeLowConfidencePrice(mockEnv, { confidence: 0.1, attemptInWindow: 1 });

      const p1 = parseFloat(r1.price);
      const p2 = parseFloat(r2.price);
      const p3 = parseFloat(r3.price);

      expect(p2).toBeGreaterThan(p1);
      expect(p3).toBeGreaterThan(p2);
    });

    it('should increase price with more attempts', () => {
      const r1 = computeLowConfidencePrice(mockEnv, { confidence: 0.3, attemptInWindow: 1 });
      const r2 = computeLowConfidencePrice(mockEnv, { confidence: 0.3, attemptInWindow: 3 });
      const r3 = computeLowConfidencePrice(mockEnv, { confidence: 0.3, attemptInWindow: 5 });

      const p1 = parseFloat(r1.price);
      const p2 = parseFloat(r2.price);
      const p3 = parseFloat(r3.price);

      expect(p2).toBeGreaterThan(p1);
      expect(p3).toBeGreaterThan(p2);
    });

    it('should cap at maxPrice', () => {
      const result = computeLowConfidencePrice(mockEnv, {
        confidence: 0.01,
        attemptInWindow: 100,
      });
      expect(result.required).toBe(true);
      expect(result.price).toBe('0.05 USDC');
    });

    it('should include severity in explanation', () => {
      const result = computeLowConfidencePrice(mockEnv, {
        confidence: 0.3,
        attemptInWindow: 2,
      });
      expect(result.explain).toContain('severity=');
      expect(result.explain).toContain('attemptsFactor=');
    });
  });

  describe('with custom config', () => {
    it('should respect custom threshold', () => {
      const envWithCustom = { PRICING_CONFIDENCE_THRESHOLD: '0.6' } as Env;

      const r1 = computeLowConfidencePrice(envWithCustom, { confidence: 0.55, attemptInWindow: 1 });
      expect(r1.required).toBe(true);

      const r2 = computeLowConfidencePrice(envWithCustom, { confidence: 0.65, attemptInWindow: 1 });
      expect(r2.required).toBe(false);
    });

    it('should respect custom base price', () => {
      const envWithCustom = { PRICING_CONFIDENCE_BASE: '0.01' } as Env;
      const result = computeLowConfidencePrice(envWithCustom, {
        confidence: 0.3,
        attemptInWindow: 1,
      });
      const price = parseFloat(result.price);
      expect(price).toBeGreaterThan(0.01);
    });

    it('should respect custom maxPrice', () => {
      const envWithCustom = { PRICING_CONFIDENCE_MAX: '0.2' } as Env;
      const result = computeLowConfidencePrice(envWithCustom, {
        confidence: 0.01,
        attemptInWindow: 100,
      });
      expect(result.price).toBe('0.2 USDC');
    });
  });
});

describe('pricing edge cases', () => {
  it('should handle zero confidence', () => {
    const result = computeLowConfidencePrice(mockEnv, {
      confidence: 0,
      attemptInWindow: 1,
    });
    expect(result.required).toBe(true);
  });

  it('should handle confidence of 1.0', () => {
    const result = computeLowConfidencePrice(mockEnv, {
      confidence: 1.0,
      attemptInWindow: 1,
    });
    expect(result.required).toBe(false);
  });

  it('should handle very high attempt numbers', () => {
    const result = computeRetryFrictionPrice(mockEnv, 1000000);
    expect(result.required).toBe(true);
    // Should be capped at max
    expect(result.price).toBe('0.02 USDC');
  });

  it('should format prices without trailing zeros', () => {
    // At high attempts, price should be at max (0.02)
    const result = computeRetryFrictionPrice(mockEnv, 50);
    expect(result.price).not.toMatch(/\.0+\s/);
    expect(result.price).not.toMatch(/0{3,}/);
  });
});
