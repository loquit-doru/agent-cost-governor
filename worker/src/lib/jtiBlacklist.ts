/**
 * JTI Blacklist — Single-use token enforcement
 *
 * Tracks used JWT IDs (jti) to prevent proceed_token replay attacks.
 * Designed for per-DO (Durable Object) instances.
 *
 * Characteristics:
 * - `isBlacklisted()` is SYNCHRONOUS (in-memory Map lookup)
 * - `markAsUsed()` is synchronous add + schedules async persist
 * - Auto-cleanup of expired entries based on token expiry time
 * - Persist to DO storage debounced (not per-request)
 * - Restore from storage on DO init via `load()`
 *
 * Max 500 entries. Expired entries are cleaned up lazily.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_ENTRIES = 500;
const PERSIST_DEBOUNCE_MS = 30_000; // 30 seconds
const STORAGE_KEY = 'jti_blacklist';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Minimal DO state interface (works with real DurableObjectState or test mock) */
export interface BlacklistStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

// ─── Class ───────────────────────────────────────────────────────────────────

export class JtiBlacklist {
  /** Map of jti → expiry timestamp in milliseconds */
  private entries: Map<string, number>;
  private dirty = false;
  private persistScheduled = false;
  private storage: BlacklistStorage;
  private nowFn: () => number;

  constructor(storage: BlacklistStorage, nowFn?: () => number) {
    this.storage = storage;
    this.nowFn = nowFn ?? (() => Date.now());
    this.entries = new Map();
  }

  /**
   * Check if a JTI has been used (blacklisted).
   * SYNCHRONOUS — O(1) Map lookup, safe for hot path.
   */
  isBlacklisted(jti: string): boolean {
    const expiryMs = this.entries.get(jti);
    if (expiryMs === undefined) return false;

    // If the blacklist entry itself has expired, remove it
    if (this.nowFn() > expiryMs) {
      this.entries.delete(jti);
      this.dirty = true;
      return false;
    }

    return true;
  }

  /**
   * Mark a JTI as used. Synchronous in-memory add.
   *
   * @param jti - JWT ID (typically the decision_id)
   * @param tokenExpirySec - Token expiry as Unix timestamp in SECONDS (from JWT `exp` claim)
   */
  markAsUsed(jti: string, tokenExpirySec: number): void {
    // Evict expired entries first if at capacity
    if (this.entries.size >= MAX_ENTRIES) {
      this.cleanupExpired();
    }

    // If still at capacity after cleanup, remove the oldest entry (FIFO via Map insertion order)
    if (this.entries.size >= MAX_ENTRIES) {
      const firstKey = this.entries.keys().next().value;
      if (firstKey !== undefined) this.entries.delete(firstKey);
    }

    // Store with expiry in milliseconds
    this.entries.set(jti, tokenExpirySec * 1000);
    this.dirty = true;
  }

  /** Remove all expired entries from the in-memory Map. */
  cleanupExpired(): void {
    const now = this.nowFn();
    for (const [jti, expiryMs] of this.entries) {
      if (now > expiryMs) {
        this.entries.delete(jti);
        this.dirty = true;
      }
    }
  }

  /**
   * Persist the blacklist to DO storage.
   * Only writes if dirty (entries changed since last persist).
   */
  async persist(): Promise<void> {
    if (!this.dirty) return;
    const data: [string, number][] = [...this.entries.entries()];
    await this.storage.put(STORAGE_KEY, data);
    this.dirty = false;
    this.persistScheduled = false;
  }

  /**
   * Load blacklist from DO storage (call during DO init / blockConcurrencyWhile).
   * Automatically cleans up expired entries on load.
   */
  async load(): Promise<void> {
    try {
      const data = await this.storage.get<[string, number][]>(STORAGE_KEY);
      if (data && Array.isArray(data)) {
        this.entries = new Map(data);
        this.cleanupExpired();
      }
    } catch {
      // Corrupted storage — start fresh
      this.entries = new Map();
    }
  }

  /**
   * Schedule a debounced persist. Call after markAsUsed().
   * Uses setTimeout — safe in DurableObject context.
   * Returns a Promise that resolves when persist completes (or immediately if already scheduled).
   */
  schedulePersist(): void {
    if (this.persistScheduled) return;
    this.persistScheduled = true;
    setTimeout(() => {
      this.persist().catch(() => {});
    }, PERSIST_DEBOUNCE_MS);
  }

  /** Number of entries currently tracked. */
  get size(): number {
    return this.entries.size;
  }
}

// ─── Proof Binding ───────────────────────────────────────────────────────────

/**
 * Build a request proof hash for JWT binding.
 * Uses SHA-256 (crypto.subtle) — security-grade hash.
 *
 * The proof binds a proceed_token to the specific governance context
 * it was issued for, preventing token rebinding attacks.
 *
 * @param action - The governed action (e.g., 'tool_call')
 * @param taskHash - Task context hash
 * @param stepHash - Step context hash
 * @param contextHash - Full context hash
 * @returns Hex-encoded SHA-256 hash (64 chars)
 */
export async function buildProof(
  action: string,
  taskHash: string,
  stepHash: string,
  contextHash: string,
): Promise<string> {
  const input = `${action}:${taskHash}:${stepHash}:${contextHash}`;
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
