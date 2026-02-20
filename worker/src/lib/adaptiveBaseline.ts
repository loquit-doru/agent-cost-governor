/**
 * Adaptive Baseline — EWMA + z-score + CUSUM
 *
 * Replaces fixed thresholds (safe ≤5, gray 6-10, storm >10) with
 * per-agent adaptive baselines that learn normal behavior over time.
 *
 * Architecture: pure functions (no class) for composability and testability.
 * State is a plain serializable object stored in DO storage.
 *
 * Classification pipeline:
 * 1. Hard ceiling check (HARD_CEILING → storm, no bypass)
 * 2. Cold start (<20 samples → safe)
 * 3. Cold buffer percentiles (20–500 samples, p95/p99 + z-score hybrid)
 * 4. Full EWMA: z ≥ 3.5σ OR cusum > 5σ OR rate > 8×mean → storm
 *
 * EWMA variance uses Welford-style update: (1-α)(V + α·δ²)
 * CUSUM uses standard k = 0.5·σ for drift detection.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type Zone = 'safe' | 'gray' | 'storm';

/** Input metrics for a single observation. Only `rpm` is required. */
export interface CurrentMetrics {
  /** Requests per minute — primary metric */
  rpm: number;
  /** Tokens per minute (optional future use) */
  tokensPerMin?: number;
  /** Fan-out ratio: unique actions / total requests (optional) */
  fanoutRatio?: number;
  /** Shannon entropy over action types (optional) */
  entropy?: number;
}

/** EWMA state for a single metric (mean + exponentially-weighted variance). */
export interface EwmaState {
  mean: number;
  variance: number;
}

/** Full agent baseline state — serializable to DO storage. */
export interface AgentBaseline {
  ewma: {
    rpm: EwmaState;
  };
  /** CUSUM accumulator for upward drift detection */
  cusum: number;
  /** Total samples observed */
  sampleCount: number;
  /** Last update timestamp (ms) */
  lastUpdatedMs: number;
  /**
   * Cold buffer: stores raw RPM values during warm-up for percentile calculation.
   * Max COLD_BUFFER_SIZE entries. Serialized as number[] (JSON-compatible).
   */
  coldBuffer: number[];
  /** Write index into cold buffer */
  coldBufferIdx: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Absolute rate ceiling — instant storm, no adaptive logic */
const HARD_CEILING = 50;

/** EWMA smoothing factor during warm-up (fast adaptation) */
const WARMUP_ALPHA = 0.15;
/** EWMA smoothing factor after stabilization (slow, stable) */
const STABLE_ALPHA = 0.05;

/** Sample count threshold: below this, use WARMUP_ALPHA */
const WARMUP_SAMPLES = 200;
/** Sample count threshold: below this, use hybrid percentile+EWMA */
const FULL_EWMA_SAMPLES = 500;

/** Max entries in the cold buffer (percentile calculation) */
const COLD_BUFFER_SIZE = 256;

/** z-score boundary: below this → safe */
const Z_SAFE = 1.5;
/** z-score boundary: at or above this → storm */
const Z_STORM = 3.5;

/** CUSUM decision interval multiplier: cusum > H·σ → storm */
const CUSUM_H = 5;

/** Epsilon to prevent division by zero in sqrt(variance) */
const EPS = 1e-9;

/** Rate multiplier: rate > RATE_STORM_MULT × mean → storm */
const RATE_STORM_MULT = 8;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a fresh baseline state for a new agent/pattern.
 */
export function createBaseline(nowMs: number): AgentBaseline {
  return {
    ewma: {
      rpm: { mean: 0, variance: 0 },
    },
    cusum: 0,
    sampleCount: 0,
    lastUpdatedMs: nowMs,
    coldBuffer: [],
    coldBufferIdx: 0,
  };
}

/**
 * Feed a new observation and classify the zone.
 *
 * Mutates `state` in-place (EWMA, CUSUM, cold buffer, counters).
 * Returns the classified zone: 'safe' | 'gray' | 'storm'.
 *
 * Hot path: zero allocations after cold buffer is full (except during
 * percentile sort, which copies the buffer once per call during warm-up).
 */
export function updateAndClassify(
  state: AgentBaseline,
  metrics: CurrentMetrics,
  nowMs: number,
): Zone {
  const rate = metrics.rpm;

  // ── Hard ceiling — bypass all adaptive logic ──────────────────────
  if (rate >= HARD_CEILING) return 'storm';

  state.lastUpdatedMs = nowMs;
  state.sampleCount++;

  // ── Fill cold buffer during warm-up ───────────────────────────────
  if (state.coldBufferIdx < COLD_BUFFER_SIZE) {
    if (state.coldBufferIdx >= state.coldBuffer.length) {
      state.coldBuffer.push(rate);
    } else {
      state.coldBuffer[state.coldBufferIdx] = rate;
    }
    state.coldBufferIdx++;
  }

  // ── Cold start: not enough data ───────────────────────────────────
  if (state.sampleCount < 20) {
    // Seed EWMA with early observations so it doesn't start from 0
    if (state.sampleCount === 1) {
      state.ewma.rpm.mean = rate;
      state.ewma.rpm.variance = 0;
    } else {
      // Simple running mean during cold start
      const n = state.sampleCount;
      state.ewma.rpm.mean += (rate - state.ewma.rpm.mean) / n;
    }
    return 'safe';
  }

  // ── Compute α based on sample maturity ────────────────────────────
  const alpha = state.sampleCount < WARMUP_SAMPLES ? WARMUP_ALPHA : STABLE_ALPHA;

  // ── Update EWMA (Welford-style variance) ──────────────────────────
  const oldMean = state.ewma.rpm.mean;
  const delta = rate - oldMean;
  const newMean = oldMean + alpha * delta;
  // Variance: (1-α)(V + α·δ²) — proper exponential moving variance
  const newVariance = (1 - alpha) * (state.ewma.rpm.variance + alpha * delta * delta);

  state.ewma.rpm.mean = newMean;
  state.ewma.rpm.variance = newVariance;

  const std = Math.sqrt(newVariance + EPS);

  // ── z-score ───────────────────────────────────────────────────────
  const z = std > EPS ? Math.abs(rate - newMean) / std : 0;

  // ── CUSUM update (one-sided, upward drift only) ───────────────────
  // k = 0.5·σ — standard from CUSUM literature
  const cusumK = 0.5 * std;
  state.cusum = Math.max(0, state.cusum + (rate - newMean) - cusumK);

  // ── Hybrid zone: percentile + z-score (warm-up phase) ────────────
  if (state.sampleCount < FULL_EWMA_SAMPLES && state.coldBufferIdx > 20) {
    // Sort a copy of the cold buffer for percentile computation
    const used = state.coldBuffer.slice(0, state.coldBufferIdx);
    used.sort((a, b) => a - b);

    const p95Idx = Math.min(Math.floor(used.length * 0.95), used.length - 1);
    const p99Idx = Math.min(Math.floor(used.length * 0.99), used.length - 1);
    const p95 = used[p95Idx];
    const p99 = used[p99Idx];

    // Percentile-based thresholds override z-score during warm-up
    if (rate >= p99) return 'storm';
    if (rate >= p95) return 'gray';

    // Fall through to z-score check even in warm-up
    if (z >= Z_STORM || state.cusum > CUSUM_H * std || rate > RATE_STORM_MULT * newMean) {
      return 'storm';
    }
    if (z >= Z_SAFE) return 'gray';
    return 'safe';
  }

  // ── Full EWMA classification ──────────────────────────────────────
  // Storm: z ≥ 3.5σ  OR  cusum > 5σ  OR  rate > 8× mean
  if (z >= Z_STORM || state.cusum > CUSUM_H * std || rate > RATE_STORM_MULT * newMean) {
    return 'storm';
  }

  // Gray: 1.5σ ≤ z < 3.5σ
  if (z >= Z_SAFE) {
    return 'gray';
  }

  // Safe
  return 'safe';
}

// ─── Serialization ───────────────────────────────────────────────────────────

/** Serialize baseline state to JSON string for DO storage. */
export function serializeState(state: AgentBaseline): string {
  return JSON.stringify({
    ewma: state.ewma,
    cusum: state.cusum,
    sampleCount: state.sampleCount,
    lastUpdatedMs: state.lastUpdatedMs,
    coldBuffer: state.coldBuffer,
    coldBufferIdx: state.coldBufferIdx,
  });
}

/**
 * Deserialize baseline state from JSON string.
 * Falls back to a fresh baseline on corrupted/invalid data (never throws).
 */
export function deserializeState(raw: string): AgentBaseline {
  try {
    const p = JSON.parse(raw);
    return {
      ewma: p.ewma && typeof p.ewma.rpm?.mean === 'number'
        ? { rpm: { mean: p.ewma.rpm.mean, variance: p.ewma.rpm.variance ?? 0 } }
        : { rpm: { mean: 0, variance: 0 } },
      cusum: typeof p.cusum === 'number' ? p.cusum : 0,
      sampleCount: typeof p.sampleCount === 'number' ? p.sampleCount : 0,
      lastUpdatedMs: typeof p.lastUpdatedMs === 'number' ? p.lastUpdatedMs : 0,
      coldBuffer: Array.isArray(p.coldBuffer) ? p.coldBuffer : [],
      coldBufferIdx: typeof p.coldBufferIdx === 'number' ? p.coldBufferIdx : 0,
    };
  } catch {
    return createBaseline(Date.now());
  }
}

/**
 * Get a loggable snapshot of the baseline state (excludes cold buffer).
 * Useful for debugging without flooding logs with 256 values.
 */
export function getStateSnapshot(state: AgentBaseline): {
  ewmaMean: number;
  ewmaVariance: number;
  ewmaStd: number;
  cusum: number;
  sampleCount: number;
  lastUpdatedMs: number;
  coldBufferFill: number;
} {
  return {
    ewmaMean: Math.round(state.ewma.rpm.mean * 1000) / 1000,
    ewmaVariance: Math.round(state.ewma.rpm.variance * 1000) / 1000,
    ewmaStd: Math.round(Math.sqrt(state.ewma.rpm.variance + EPS) * 1000) / 1000,
    cusum: Math.round(state.cusum * 1000) / 1000,
    sampleCount: state.sampleCount,
    lastUpdatedMs: state.lastUpdatedMs,
    coldBufferFill: state.coldBufferIdx,
  };
}
