/**
 * Cross-Workspace Intelligence — Privacy-safe aggregate analytics
 *
 * Collects anonymized behavioral data from all workspaces into D1,
 * enabling global anomaly detection without storing PII.
 *
 * Privacy guarantees:
 * - k-anonymity (k≥5): rows with count < 5 are never exported
 * - Differential privacy: Laplace noise (ε=1.0) added to all counters
 * - Workspace IDs are SHA-256 hashed before export
 * - Zero raw prompts, zero PII
 *
 * Architecture: pure functions (no class), consistent with other lib modules.
 * D1Database interface defined locally for self-containment.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/** Laplace privacy budget */
const EPSILON = 1.0;

/** k-anonymity threshold: minimum entries per aggregation row */
const K_ANONYMITY = 5;

/** Global anomaly: ≥N distinct workspaces on the same cluster in the window */
const ANOMALY_WORKSPACE_THRESHOLD = 5;

/** Anomaly detection lookback window (hours) */
const ANOMALY_WINDOW_HOURS = 3;

// ─── D1 Interface (self-contained) ──────────────────────────────────────────

/** Minimal D1Database interface — matches Cloudflare Workers D1 binding. */
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  exec(query: string): Promise<D1ExecResult>;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run(): Promise<D1Result>;
  all<T = unknown>(): Promise<D1Result<T>>;
}

interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta?: Record<string, unknown>;
}

interface D1ExecResult {
  count: number;
  duration: number;
}

// ─── Types ───────────────────────────────────────────────────────────────────

/** Aggregated decision data from a local DO — input for export. */
export interface LocalDecisionAggregate {
  /** UTC hour timestamp (truncated to hour) */
  hourTimestamp: number;
  /** Zone classification */
  zone: 'safe' | 'gray' | 'storm';
  /** Fingerprint cluster hash (from behaviorFingerprint.ts) */
  fingerprintCluster: string;
  /** Number of decisions in this bucket */
  count: number;
  /** Average burst index across decisions */
  avgBurstIndex: number;
  /** Average Shannon entropy */
  avgEntropy: number;
  /** Total USD cost saved in this bucket */
  costSavedUsd: number;
}

/** Global anomaly detection result. */
export interface GlobalAnomalyResult {
  /** Whether an anomaly was detected */
  anomalyDetected: boolean;
  /** Number of distinct workspaces affected (0 if no anomaly) */
  affectedWorkspaces: number;
  /** The fingerprint cluster hash that triggered the anomaly */
  clusterHash: string;
  /** When the anomaly was detected (ISO string) */
  detectedAt: string;
}

// ─── D1 Schema ───────────────────────────────────────────────────────────────

/**
 * Migration SQL for D1. Run once via `d1.exec(GLOBAL_PATTERNS_SCHEMA)`.
 */
export const GLOBAL_PATTERNS_SCHEMA = `
CREATE TABLE IF NOT EXISTS global_patterns (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  hour INTEGER NOT NULL CHECK (hour >= 0 AND hour <= 23),
  workspace_hash TEXT NOT NULL,
  fingerprint_cluster TEXT NOT NULL,
  zone TEXT NOT NULL,
  count_noisy INTEGER NOT NULL,
  avg_burst_index REAL NOT NULL,
  avg_entropy REAL NOT NULL,
  cost_saved_usd REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gp_date_hour ON global_patterns(date, hour);
CREATE INDEX IF NOT EXISTS idx_gp_cluster ON global_patterns(fingerprint_cluster);
CREATE INDEX IF NOT EXISTS idx_gp_workspace ON global_patterns(workspace_hash);
`;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Export daily aggregates from a workspace's decision data into D1.
 *
 * - Anonymizes workspace_id via SHA-256
 * - Adds Laplace noise to counters (differential privacy)
 * - Skips rows that fail k-anonymity check (count < K_ANONYMITY)
 * - Uses deterministic IDs for idempotent INSERT OR REPLACE
 *
 * Call this from the DO alarm handler (daily cleanup).
 *
 * @param d1 - D1 database binding
 * @param workspaceId - Raw workspace ID (will be hashed)
 * @param decisions - Aggregated decision buckets from local DO storage
 */
export async function exportDailyAggregate(
  d1: D1Database,
  workspaceId: string,
  decisions: LocalDecisionAggregate[],
): Promise<{ exported: number; skipped: number }> {
  const workspaceHash = await sha256Hex(workspaceId);
  let exported = 0;
  let skipped = 0;

  const statements: D1PreparedStatement[] = [];

  for (const dec of decisions) {
    // k-anonymity: skip if count is below threshold
    if (dec.count < K_ANONYMITY) {
      skipped++;
      continue;
    }

    const { date, hour } = toDateHour(dec.hourTimestamp);

    // Add Laplace noise to the count (differential privacy)
    const noisyCount = addLaplaceNoise(dec.count, EPSILON);

    // Deterministic ID for idempotent upserts
    const id = await sha256Hex(
      `${workspaceHash}:${date}:${hour}:${dec.zone}:${dec.fingerprintCluster}`,
    );

    statements.push(
      d1
        .prepare(
          `INSERT OR REPLACE INTO global_patterns
           (id, date, hour, workspace_hash, fingerprint_cluster, zone, count_noisy, avg_burst_index, avg_entropy, cost_saved_usd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id.slice(0, 32), // 128-bit ID
          date,
          hour,
          workspaceHash.slice(0, 16), // Truncate workspace hash for extra anonymity
          dec.fingerprintCluster,
          dec.zone,
          noisyCount,
          Math.round(dec.avgBurstIndex * 1000) / 1000,
          Math.round(dec.avgEntropy * 1000) / 1000,
          Math.round(dec.costSavedUsd * 100) / 100,
        ),
    );
    exported++;
  }

  // Batch execute (D1 batches are atomic)
  if (statements.length > 0) {
    await d1.batch(statements);
  }

  return { exported, skipped };
}

/**
 * Scan D1 for global anomalies: fingerprint clusters appearing across
 * multiple distinct workspaces within the lookback window.
 *
 * Returns the top anomaly (highest workspace count) or a safe result.
 *
 * @param d1 - D1 database binding
 */
export async function checkGlobalAnomalies(
  d1: D1Database,
): Promise<GlobalAnomalyResult> {
  const now = new Date();
  const lookbackMs = ANOMALY_WINDOW_HOURS * 60 * 60 * 1000;
  const since = new Date(now.getTime() - lookbackMs);

  const sinceDate = formatDate(since);
  const sinceHour = since.getUTCHours();
  const nowDate = formatDate(now);

  // Query: find fingerprint clusters with ≥ ANOMALY_WORKSPACE_THRESHOLD distinct workspaces
  // Handle date boundary correctly: (date > sinceDate) OR (date = sinceDate AND hour >= sinceHour)
  const result = await d1
    .prepare(
      `SELECT fingerprint_cluster, COUNT(DISTINCT workspace_hash) AS ws_count
       FROM global_patterns
       WHERE (date > ? OR (date = ? AND hour >= ?))
         AND date <= ?
       GROUP BY fingerprint_cluster
       HAVING ws_count >= ?
       ORDER BY ws_count DESC
       LIMIT 1`,
    )
    .bind(sinceDate, sinceDate, sinceHour, nowDate, ANOMALY_WORKSPACE_THRESHOLD)
    .first<{ fingerprint_cluster: string; ws_count: number }>();

  if (result) {
    return {
      anomalyDetected: true,
      affectedWorkspaces: result.ws_count,
      clusterHash: result.fingerprint_cluster,
      detectedAt: now.toISOString(),
    };
  }

  return {
    anomalyDetected: false,
    affectedWorkspaces: 0,
    clusterHash: '',
    detectedAt: now.toISOString(),
  };
}

/**
 * Clean up old data from D1 (run periodically from DO alarm).
 * Deletes rows older than `retentionDays`.
 */
export async function cleanupOldPatterns(
  d1: D1Database,
  retentionDays: number = 90,
): Promise<void> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  const cutoffDate = formatDate(cutoff);

  await d1.prepare('DELETE FROM global_patterns WHERE date < ?').bind(cutoffDate).run();
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * SHA-256 hex digest of input string.
 * Uses Web Crypto (available in Workers runtime).
 */
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Add Laplace noise for differential privacy.
 * scale = 1/ε, noise via inverse CDF transform.
 * Result is clamped to ≥ 0 and rounded.
 */
function addLaplaceNoise(count: number, epsilon: number): number {
  const scale = 1 / epsilon;
  const u = Math.random() - 0.5; // Uniform(-0.5, 0.5)
  const noise = -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
  return Math.max(0, Math.round(count + noise));
}

/**
 * Extract UTC date string and hour from a timestamp.
 */
function toDateHour(ts: number): { date: string; hour: number } {
  const d = new Date(ts);
  return {
    date: formatDate(d),
    hour: d.getUTCHours(),
  };
}

/** Format a Date to YYYY-MM-DD string (UTC). */
function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ─── DO Alarm Integration Helper ─────────────────────────────────────────────

/**
 * Helper to aggregate local decision logs into export-ready buckets.
 *
 * Call this in your DO alarm to transform raw decision entries
 * into `LocalDecisionAggregate[]` for `exportDailyAggregate()`.
 *
 * @param decisions - Raw decision log entries from DO storage
 * @returns Aggregated buckets grouped by (hourTimestamp, zone, fingerprintCluster)
 */
export function aggregateDecisions(
  decisions: ReadonlyArray<{
    timestamp: string | number;
    zone: string;
    fingerprint_hash?: string;
    cost_saved_usd?: number;
    burst_index?: number;
    entropy?: number;
  }>,
): LocalDecisionAggregate[] {
  const buckets = new Map<string, {
    hourTimestamp: number;
    zone: 'safe' | 'gray' | 'storm';
    fingerprintCluster: string;
    count: number;
    burstSum: number;
    entropySum: number;
    costSum: number;
  }>();

  for (const dec of decisions) {
    const ts = typeof dec.timestamp === 'string'
      ? new Date(dec.timestamp).getTime()
      : dec.timestamp;
    const zone = (dec.zone === 'safe' || dec.zone === 'gray' || dec.zone === 'storm')
      ? dec.zone
      : 'safe';
    const cluster = dec.fingerprint_hash ?? 'unknown';

    // Truncate to hour for bucketing
    const hourTs = ts - (ts % (60 * 60 * 1000));
    const key = `${hourTs}:${zone}:${cluster}`;

    const existing = buckets.get(key);
    if (existing) {
      existing.count++;
      existing.burstSum += dec.burst_index ?? 0;
      existing.entropySum += dec.entropy ?? 0;
      existing.costSum += dec.cost_saved_usd ?? 0;
    } else {
      buckets.set(key, {
        hourTimestamp: hourTs,
        zone,
        fingerprintCluster: cluster,
        count: 1,
        burstSum: dec.burst_index ?? 0,
        entropySum: dec.entropy ?? 0,
        costSum: dec.cost_saved_usd ?? 0,
      });
    }
  }

  const result: LocalDecisionAggregate[] = [];
  for (const b of buckets.values()) {
    result.push({
      hourTimestamp: b.hourTimestamp,
      zone: b.zone,
      fingerprintCluster: b.fingerprintCluster,
      count: b.count,
      avgBurstIndex: b.count > 0 ? b.burstSum / b.count : 0,
      avgEntropy: b.count > 0 ? b.entropySum / b.count : 0,
      costSavedUsd: b.costSum,
    });
  }

  return result;
}
