/**
 * Decision Cache — FNV-1a hash + LRU in-memory cache
 *
 * Caches gray zone AI decisions by behavioral feature hash.
 * When the same behavioral pattern is seen again within TTL,
 * returns the cached decision instantly (skip LLM call).
 *
 * Key design decisions:
 * - FNV-1a 32-bit hash (no BigInt): ~10-100× faster than SHA-256,
 *   collision risk negligible at ≤100 entries
 * - No actor_id in hash: cache is per-behavior, not per-agent
 *   (same pattern from different agents → same decision)
 * - Bucketization: rounds continuous metrics so near-identical
 *   patterns share a cache entry
 * - nowFn injectable for deterministic testing
 * - LRU via Map insertion order (delete + re-set on access)
 */

import type { GrayZoneInput, GrayZoneDecision } from './aiReasoning.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_ENTRIES = 100;
const TTL_MS = 5 * 60 * 1000; // 5 minutes

// FNV-1a 32-bit constants
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

// ─── Types ───────────────────────────────────────────────────────────────────

interface CachedEntry {
  decision: 'allow' | 'block';
  reasoning: string;
  confidence: number;
  cachedAtMs: number;
}

// ─── FNV-1a Hash ─────────────────────────────────────────────────────────────

/**
 * FNV-1a 32-bit hash. Pure number arithmetic (no BigInt).
 * Fast enough for cache key derivation at ≤100 entries.
 */
function fnv1a32(input: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Multiply by FNV prime, keep 32-bit via >>> 0
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// ─── Feature Hashing ─────────────────────────────────────────────────────────

/**
 * Hash a GrayZoneInput into a deterministic cache key.
 * Uses string concatenation with bucketized continuous metrics.
 *
 * Bucketization:
 * - action: lowercased
 * - count: exact (integer)
 * - interval_cv: 2 decimal places
 * - requests_per_sec: 1 decimal place
 * - cost_window_usd: 2 decimal places (if present)
 * - backoff_detected: boolean (if present)
 *
 * Intentionally EXCLUDES: actor_id (cache per-behavior, not per-agent),
 * task_hash, step_hash (too specific — prevent cache reuse).
 */
export function hashGrayZoneInput(input: GrayZoneInput): string {
  const parts = [
    input.action.toLowerCase(),
    String(input.count),
    input.interval_cv.toFixed(2),
    input.requests_per_sec.toFixed(1),
  ];

  if (input.cost_window_usd !== undefined) {
    parts.push(input.cost_window_usd.toFixed(2));
  }
  if (input.backoff_detected !== undefined) {
    parts.push(String(input.backoff_detected));
  }

  return fnv1a32(parts.join('|'));
}

// ─── Decision Cache ──────────────────────────────────────────────────────────

export class DecisionCache {
  private cache: Map<string, CachedEntry>;
  private nowFn: () => number;

  constructor(nowFn?: () => number) {
    this.cache = new Map();
    this.nowFn = nowFn ?? (() => Date.now());
  }

  /**
   * Get a cached decision if it exists and is not expired.
   * Refreshes LRU position on hit (delete + re-set).
   */
  get(key: string): CachedEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // Expired
    if (this.nowFn() - entry.cachedAtMs > TTL_MS) {
      this.cache.delete(key);
      return null;
    }

    // LRU refresh: delete + re-insert to move to end of Map iteration order
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry;
  }

  /**
   * Store a decision in the cache. Evicts oldest entry if at capacity.
   */
  set(key: string, decision: 'allow' | 'block', reasoning: string, confidence: number): void {
    // Evict expired entries first
    if (this.cache.size >= MAX_ENTRIES) {
      this.cleanupExpired();
    }

    // If still at capacity, evict oldest (first entry in Map)
    if (this.cache.size >= MAX_ENTRIES) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }

    this.cache.set(key, {
      decision,
      reasoning,
      confidence,
      cachedAtMs: this.nowFn(),
    });
  }

  /** Remove all expired entries. */
  cleanupExpired(): void {
    const now = this.nowFn();
    for (const [key, entry] of this.cache) {
      if (now - entry.cachedAtMs > TTL_MS) {
        this.cache.delete(key);
      }
    }
  }

  /** Number of entries currently cached. */
  get size(): number {
    return this.cache.size;
  }
}

// ─── Cached AI Decision Wrapper ──────────────────────────────────────────────

/**
 * Wraps an AI gray zone decision call with caching.
 * On cache hit: returns instantly with model='cached-llama-3.1-8b'.
 * On miss: calls the provided aiCall function, caches result, returns.
 *
 * @param cache - DecisionCache instance
 * @param input - GrayZoneInput features
 * @param aiCall - The actual AI decision function to call on cache miss
 * @returns GrayZoneDecision (with `cacheHit` signal via model name)
 */
export async function cachedAiDecideGrayZone(
  cache: DecisionCache,
  input: GrayZoneInput,
  aiCall: (input: GrayZoneInput) => Promise<GrayZoneDecision>,
): Promise<{ decision: GrayZoneDecision; cacheHit: boolean }> {
  const key = hashGrayZoneInput(input);
  const cached = cache.get(key);

  if (cached) {
    return {
      decision: {
        decision: cached.decision,
        reasoning: cached.reasoning,
        ai_decided: true,
        confidence: cached.confidence,
        model: 'cached-llama-3.1-8b',
      },
      cacheHit: true,
    };
  }

  // Cache miss — call AI
  const result = await aiCall(input);

  // Only cache AI decisions (not heuristic fallbacks) — heuristic is already instant
  if (result.ai_decided) {
    cache.set(key, result.decision, result.reasoning, result.confidence);
  }

  return { decision: result, cacheHit: false };
}
