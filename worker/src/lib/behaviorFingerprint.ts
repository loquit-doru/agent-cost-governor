/**
 * Behavioral Fingerprint — Privacy-safe agent behavior profiling
 *
 * Computes a compact behavioral fingerprint per agent from:
 * - Tool/action sequence hash (last 10 actions → SHA-256)
 * - Retry interval distribution (4-bucket histogram)
 * - Average call depth
 * - Burst index (max requests in 10s / average)
 * - Shannon entropy over action types
 * - Fan-out ratio (unique actions / total)
 *
 * Architecture: pure functions (no class), consistent with adaptiveBaseline.ts.
 * All actions are hashed before storage — zero raw data / PII.
 * Fingerprint hash is SHA-256 truncated to 32 hex chars (128-bit).
 *
 * Streaming: O(1) per update via circular buffer + running counters.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/** Circular buffer size for action sequence */
const ACTION_WINDOW_SIZE = 10;

/** Window for burst detection (ms) */
const BURST_WINDOW_MS = 10_000;

/** Max timestamps kept for burst calculation */
const MAX_RECENT_TS = 200;

/** Interval histogram bucket boundaries (ms) */
const BUCKET_BOUNDS = [100, 500, 2000] as const;

/** Comparison weights (sum = 1.0) */
const WEIGHTS = {
  sequence: 0.25,
  histogram: 0.20,
  depth: 0.15,
  burst: 0.15,
  entropy: 0.15,
  fanout: 0.10,
} as const;

// ─── Types ───────────────────────────────────────────────────────────────────

/** Mutable state for streaming fingerprint updates */
export interface FingerprintState {
  /** Circular buffer of hashed action strings (SHA-256 hex, 16 chars each) */
  actionWindow: string[];
  /** Write index into circular buffer */
  seqIndex: number;
  /** Action frequency map: hashedAction → count (for entropy + fanout) */
  actionCounts: Record<string, number>;
  /** Total actions observed */
  totalActions: number;
  /** Interval histogram: [<100ms, 100-500ms, 500-2000ms, >2000ms] */
  intervalHistogram: [number, number, number, number];
  /** Sum of all depths (for running average) */
  depthSum: number;
  /** Recent timestamps for burst detection (capped at MAX_RECENT_TS) */
  recentTimestamps: number[];
  /** Max requests seen in any BURST_WINDOW_MS window */
  maxBurstCount: number;
}

/** Computed fingerprint — immutable snapshot */
export interface BehaviorFingerprint {
  /** SHA-256 hash of the last N action hashes (sequence signature) */
  toolSequenceHash: string;
  /** Normalized interval distribution [0-1, 0-1, 0-1, 0-1] */
  retryDistribution: [number, number, number, number];
  /** Average call depth */
  avgDepth: number;
  /** Burst index: maxBurst / avgRate (>1 = bursty) */
  burstIndex: number;
  /** Shannon entropy over action types (bits) */
  entropyProfile: number;
  /** Unique actions / total actions */
  fanoutRatio: number;
  /** Compact hash of all above — 32 hex chars (128-bit) */
  fingerprintHash: string;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Create a fresh fingerprint state. */
export function createFingerprintState(): FingerprintState {
  return {
    actionWindow: new Array(ACTION_WINDOW_SIZE).fill(''),
    seqIndex: 0,
    actionCounts: {},
    totalActions: 0,
    intervalHistogram: [0, 0, 0, 0],
    depthSum: 0,
    recentTimestamps: [],
    maxBurstCount: 0,
  };
}

/**
 * Feed a new observation and recompute the fingerprint.
 *
 * Mutates `state` in-place (circular buffer, counters).
 * Returns a fresh BehaviorFingerprint snapshot.
 *
 * @param state - Mutable fingerprint state
 * @param params.action - Action string (will be hashed)
 * @param params.intervalMs - Interval since last request (ms), 0 for first
 * @param params.depth - Call depth (e.g., tool chain length)
 * @param params.timestamp - Current timestamp (ms)
 */
export async function updateFingerprint(
  state: FingerprintState,
  params: {
    action: string;
    intervalMs: number;
    depth: number;
    timestamp: number;
  },
): Promise<BehaviorFingerprint> {
  // ── Hash action (privacy-safe) ──────────────────────────────────
  const actionHash = await sha256Short(params.action);

  // ── Evict old action from circular buffer + decrement its count ──
  const oldAction = state.actionWindow[state.seqIndex];
  if (oldAction && state.actionCounts[oldAction] !== undefined) {
    state.actionCounts[oldAction]--;
    if (state.actionCounts[oldAction] <= 0) {
      delete state.actionCounts[oldAction];
    }
  }

  // ── Insert new action ───────────────────────────────────────────
  state.actionWindow[state.seqIndex] = actionHash;
  state.seqIndex = (state.seqIndex + 1) % ACTION_WINDOW_SIZE;
  state.actionCounts[actionHash] = (state.actionCounts[actionHash] ?? 0) + 1;
  state.totalActions++;

  // ── Interval histogram ──────────────────────────────────────────
  if (params.intervalMs > 0) {
    if (params.intervalMs < BUCKET_BOUNDS[0]) {
      state.intervalHistogram[0]++;
    } else if (params.intervalMs < BUCKET_BOUNDS[1]) {
      state.intervalHistogram[1]++;
    } else if (params.intervalMs < BUCKET_BOUNDS[2]) {
      state.intervalHistogram[2]++;
    } else {
      state.intervalHistogram[3]++;
    }
  }

  // ── Depth accumulator ──────────────────────────────────────────
  state.depthSum += params.depth;

  // ── Burst tracking ─────────────────────────────────────────────
  // Add timestamp, cap array length
  state.recentTimestamps.push(params.timestamp);
  if (state.recentTimestamps.length > MAX_RECENT_TS) {
    // Remove oldest entries in bulk (keep last MAX_RECENT_TS)
    state.recentTimestamps = state.recentTimestamps.slice(-MAX_RECENT_TS);
  }

  // Count requests in the most recent BURST_WINDOW_MS
  const windowStart = params.timestamp - BURST_WINDOW_MS;
  let burstCount = 0;
  for (let i = state.recentTimestamps.length - 1; i >= 0; i--) {
    if (state.recentTimestamps[i] >= windowStart) burstCount++;
    else break; // timestamps are ordered, so we can stop early
  }
  if (burstCount > state.maxBurstCount) {
    state.maxBurstCount = burstCount;
  }

  // ── Compute fingerprint ────────────────────────────────────────
  return computeFingerprint(state);
}

/**
 * Compare two fingerprints. Returns similarity score 0-1.
 * Uses weighted combination of per-feature similarities.
 */
export function compareFingerprints(
  a: BehaviorFingerprint,
  b: BehaviorFingerprint,
): number {
  // Sequence similarity: compare hashes (binary — same or different)
  const seqSim = a.toolSequenceHash === b.toolSequenceHash ? 1.0 : 0.0;

  // Histogram similarity: cosine similarity of distributions
  const histSim = cosineSimilarity(a.retryDistribution, b.retryDistribution);

  // Numeric similarities: 1 / (1 + |a - b|)
  const depthSim = numericSimilarity(a.avgDepth, b.avgDepth);
  const burstSim = numericSimilarity(a.burstIndex, b.burstIndex);
  const entropySim = numericSimilarity(a.entropyProfile, b.entropyProfile);
  const fanoutSim = numericSimilarity(a.fanoutRatio, b.fanoutRatio);

  return (
    WEIGHTS.sequence * seqSim +
    WEIGHTS.histogram * histSim +
    WEIGHTS.depth * depthSim +
    WEIGHTS.burst * burstSim +
    WEIGHTS.entropy * entropySim +
    WEIGHTS.fanout * fanoutSim
  );
}

// ─── Serialization ───────────────────────────────────────────────────────────

/** Serialize fingerprint state to JSON string for DO storage. */
export function serializeFingerprintState(state: FingerprintState): string {
  return JSON.stringify({
    aw: state.actionWindow,
    si: state.seqIndex,
    ac: state.actionCounts,
    ta: state.totalActions,
    ih: state.intervalHistogram,
    ds: state.depthSum,
    rt: state.recentTimestamps,
    mb: state.maxBurstCount,
  });
}

/** Deserialize fingerprint state from JSON string. Never throws. */
export function deserializeFingerprintState(raw: string): FingerprintState {
  try {
    const p = JSON.parse(raw);
    return {
      actionWindow: Array.isArray(p.aw) ? p.aw : new Array(ACTION_WINDOW_SIZE).fill(''),
      seqIndex: typeof p.si === 'number' ? p.si : 0,
      actionCounts: typeof p.ac === 'object' && p.ac !== null ? p.ac : {},
      totalActions: typeof p.ta === 'number' ? p.ta : 0,
      intervalHistogram: Array.isArray(p.ih) && p.ih.length === 4
        ? p.ih as [number, number, number, number]
        : [0, 0, 0, 0],
      depthSum: typeof p.ds === 'number' ? p.ds : 0,
      recentTimestamps: Array.isArray(p.rt) ? p.rt : [],
      maxBurstCount: typeof p.mb === 'number' ? p.mb : 0,
    };
  } catch {
    return createFingerprintState();
  }
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/** SHA-256 of input, truncated to 16 hex chars (64-bit). */
async function sha256Short(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

/** SHA-256 of input, truncated to 32 hex chars (128-bit). */
async function sha256Medium(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

/** Compute a full fingerprint snapshot from current state. */
async function computeFingerprint(state: FingerprintState): Promise<BehaviorFingerprint> {
  // Tool sequence hash: concatenate circular buffer in order and hash
  const ordered: string[] = [];
  for (let i = 0; i < ACTION_WINDOW_SIZE; i++) {
    const idx = (state.seqIndex + i) % ACTION_WINDOW_SIZE;
    if (state.actionWindow[idx]) ordered.push(state.actionWindow[idx]);
  }
  const toolSequenceHash = ordered.length > 0
    ? await sha256Medium(ordered.join(':'))
    : '0'.repeat(32);

  // Retry distribution: normalized histogram
  const histTotal = state.intervalHistogram[0] + state.intervalHistogram[1] +
                    state.intervalHistogram[2] + state.intervalHistogram[3];
  const retryDistribution: [number, number, number, number] = histTotal > 0
    ? [
        state.intervalHistogram[0] / histTotal,
        state.intervalHistogram[1] / histTotal,
        state.intervalHistogram[2] / histTotal,
        state.intervalHistogram[3] / histTotal,
      ]
    : [0, 0, 0, 0];

  // Average depth
  const avgDepth = state.totalActions > 0 ? state.depthSum / state.totalActions : 0;

  // Burst index: maxBurst / avgRate (where avgRate = total / elapsed time)
  let burstIndex = 1.0;
  if (state.recentTimestamps.length >= 2) {
    const elapsed = state.recentTimestamps[state.recentTimestamps.length - 1] -
                    state.recentTimestamps[0];
    if (elapsed > 0) {
      const avgRatePerWindow = (state.totalActions / elapsed) * BURST_WINDOW_MS;
      burstIndex = avgRatePerWindow > 0 ? state.maxBurstCount / avgRatePerWindow : 1.0;
    }
  }

  // Shannon entropy
  const uniqueActions = Object.keys(state.actionCounts).length;
  const sampleSize = Math.min(state.totalActions, ACTION_WINDOW_SIZE);
  const entropyProfile = shannonEntropy(state.actionCounts, sampleSize);

  // Fan-out ratio
  const fanoutRatio = state.totalActions > 0 ? uniqueActions / Math.min(state.totalActions, ACTION_WINDOW_SIZE) : 0;

  // Compact fingerprint hash: hash of all features combined
  const featureString = [
    toolSequenceHash,
    retryDistribution.map(v => v.toFixed(4)).join(','),
    avgDepth.toFixed(4),
    burstIndex.toFixed(4),
    entropyProfile.toFixed(4),
    fanoutRatio.toFixed(4),
  ].join('|');
  const fingerprintHash = await sha256Medium(featureString);

  return {
    toolSequenceHash,
    retryDistribution,
    avgDepth: Math.round(avgDepth * 1000) / 1000,
    burstIndex: Math.round(burstIndex * 1000) / 1000,
    entropyProfile: Math.round(entropyProfile * 1000) / 1000,
    fanoutRatio: Math.round(fanoutRatio * 1000) / 1000,
    fingerprintHash,
  };
}

/**
 * Shannon entropy in bits from a frequency map.
 * H = -Σ p(x) * log2(p(x))
 */
function shannonEntropy(counts: Record<string, number>, total: number): number {
  if (total <= 0) return 0;
  let entropy = 0;
  for (const key in counts) {
    const c = counts[key];
    if (c > 0) {
      const p = c / total;
      entropy -= p * Math.log2(p);
    }
  }
  return entropy;
}

/** Numeric similarity: 1 / (1 + |a - b|). Bounded [0, 1]. */
function numericSimilarity(a: number, b: number): number {
  return 1 / (1 + Math.abs(a - b));
}

/** Cosine similarity between two numeric vectors. Returns 0-1. */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom > 0 ? dot / denom : 0;
}

// ─── SQL Schema ──────────────────────────────────────────────────────────────

/**
 * Extended decision log schema for D1.
 * Call with d1.exec(DECISIONS_SCHEMA) during migration.
 */
export const DECISIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  workspace_id TEXT,
  agent_id TEXT,
  request_hash TEXT,
  features TEXT,
  zone TEXT,
  decision TEXT,
  heuristic_score REAL,
  llm_score REAL,
  confidence REAL,
  reason TEXT,
  fingerprint_hash TEXT,
  cost_usd REAL,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(ts);
CREATE INDEX IF NOT EXISTS idx_decisions_zone ON decisions(zone);
CREATE INDEX IF NOT EXISTS idx_decisions_agent ON decisions(agent_id);
CREATE INDEX IF NOT EXISTS idx_decisions_fingerprint ON decisions(fingerprint_hash);
`;
