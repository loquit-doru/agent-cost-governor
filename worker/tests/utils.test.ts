import { describe, it, expect, beforeEach } from 'vitest';
import {
  sha256Hex,
  randomApiKey,
  makeDecisionId,
  makeQuoteId,
  formatUsdcUnits,
  quotePriceFromCredits,
} from '../src/lib/utils.js';

describe('sha256Hex', () => {
  it('should hash a simple string', async () => {
    const hash = await sha256Hex('hello');
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('should produce consistent hashes', async () => {
    const h1 = await sha256Hex('test');
    const h2 = await sha256Hex('test');
    expect(h1).toBe(h2);
  });

  it('should produce different hashes for different inputs', async () => {
    const h1 = await sha256Hex('test1');
    const h2 = await sha256Hex('test2');
    expect(h1).not.toBe(h2);
  });

  it('should return 64-character hex string', async () => {
    const hash = await sha256Hex('anything');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('should handle empty string', async () => {
    const hash = await sha256Hex('');
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('should handle unicode', async () => {
    const hash = await sha256Hex('こんにちは');
    expect(hash).toHaveLength(64);
  });
});

describe('randomApiKey', () => {
  it('should generate different keys each time', () => {
    const k1 = randomApiKey();
    const k2 = randomApiKey();
    expect(k1).not.toBe(k2);
  });

  it('should generate base64url-safe characters only', () => {
    for (let i = 0; i < 10; i++) {
      const key = randomApiKey();
      expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('should not have padding', () => {
    for (let i = 0; i < 10; i++) {
      const key = randomApiKey();
      expect(key).not.toContain('=');
    }
  });

  it('should respect byte size parameter', () => {
    const k16 = randomApiKey(16);
    const k32 = randomApiKey(32);
    const k64 = randomApiKey(64);

    // Base64 encoding produces ~4/3 chars per byte
    expect(k16.length).toBeLessThan(k32.length);
    expect(k32.length).toBeLessThan(k64.length);
  });
});

describe('makeDecisionId', () => {
  it('should start with dec_ prefix', () => {
    const id = makeDecisionId();
    expect(id).toMatch(/^dec_/);
  });

  it('should be 30 characters total (dec_ + 26 char ULID)', () => {
    const id = makeDecisionId();
    expect(id).toHaveLength(30);
  });

  it('should generate unique IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(makeDecisionId());
    }
    expect(ids.size).toBe(100);
  });

  it('should use Crockford base32 characters', () => {
    const id = makeDecisionId();
    const ulidPart = id.slice(4);
    // Crockford base32 excludes I, L, O, U
    expect(ulidPart).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
  });

  it('should be time-sortable (roughly)', () => {
    const id1 = makeDecisionId();
    // Small delay to ensure different timestamp
    const start = Date.now();
    while (Date.now() - start < 2) {
      // busy wait
    }
    const id2 = makeDecisionId();
    expect(id1 < id2).toBe(true);
  });
});

describe('makeQuoteId', () => {
  it('should start with q_ prefix', () => {
    const id = makeQuoteId();
    expect(id).toMatch(/^q_/);
  });

  it('should be 28 characters total (q_ + 26 char ULID)', () => {
    const id = makeQuoteId();
    expect(id).toHaveLength(28);
  });
});

describe('formatUsdcUnits', () => {
  it('should format zero', () => {
    expect(formatUsdcUnits(0n)).toBe('0 USDC');
  });

  it('should format whole numbers', () => {
    expect(formatUsdcUnits(1_000_000n)).toBe('1 USDC');
    expect(formatUsdcUnits(10_000_000n)).toBe('10 USDC');
    expect(formatUsdcUnits(100_000_000n)).toBe('100 USDC');
  });

  it('should format decimals', () => {
    expect(formatUsdcUnits(500_000n)).toBe('0.5 USDC');
    expect(formatUsdcUnits(1_500_000n)).toBe('1.5 USDC');
  });

  it('should strip trailing zeros', () => {
    expect(formatUsdcUnits(100_000n)).toBe('0.1 USDC');
    expect(formatUsdcUnits(1_000n)).toBe('0.001 USDC');
  });

  it('should handle small amounts', () => {
    expect(formatUsdcUnits(1n)).toBe('0.000001 USDC');
    expect(formatUsdcUnits(10n)).toBe('0.00001 USDC');
  });

  it('should handle negative amounts', () => {
    expect(formatUsdcUnits(-1_000_000n)).toBe('-1 USDC');
    expect(formatUsdcUnits(-500_000n)).toBe('-0.5 USDC');
  });

  it('should handle large amounts', () => {
    expect(formatUsdcUnits(1_000_000_000_000n)).toBe('1000000 USDC');
  });
});

describe('quotePriceFromCredits', () => {
  it('should calculate price correctly', () => {
    // 100 credits at 10 microUSDC each = 1000 microUSDC = 0.001 USDC
    const result = quotePriceFromCredits(100, 10);
    expect(result.units).toBe(1000n);
    expect(result.price).toBe('0.001 USDC');
  });

  it('should handle single credit', () => {
    const result = quotePriceFromCredits(1, 10);
    expect(result.units).toBe(10n);
    expect(result.price).toBe('0.00001 USDC');
  });

  it('should handle large credit amounts', () => {
    // 1M credits at 10 microUSDC = 10 USDC
    const result = quotePriceFromCredits(1_000_000, 10);
    expect(result.units).toBe(10_000_000n);
    expect(result.price).toBe('10 USDC');
  });

  it('should handle different microUSDC rates', () => {
    const r1 = quotePriceFromCredits(100, 1);
    const r2 = quotePriceFromCredits(100, 100);

    expect(r1.units).toBe(100n);
    expect(r2.units).toBe(10000n);
    expect(parseFloat(r2.price)).toBeGreaterThan(parseFloat(r1.price));
  });
});
