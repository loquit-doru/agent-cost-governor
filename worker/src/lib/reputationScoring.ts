/**
 * Agent Reputation Scoring — trust score per workspace/agent
 *
 * Trust Score Components (0-100):
 *   - compliance_rate:  % of requests that were NOT blocked (weight: 40%)
 *   - budget_adherence: How well agent stays within budget limits (weight: 20%)
 *   - pattern_regularity: Low storm frequency → higher score (weight: 15%)
 *   - time_since_incident: Days since last block event (weight: 15%)
 *   - backoff_cooperation: Whether agent backs off when warned (weight: 10%)
 *
 * Behavior per trust tier:
 *   80-100 (trusted):   Relaxed thresholds → gray zone starts later
 *   50-79  (normal):    Standard thresholds
 *    0-49  (untrusted): Strict mode → gray zone starts earlier
 *   New agents:         Start at 50, earn trust over time
 *
 * Trust decays slowly on bad behavior, rebuilds through consistent good behavior.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ReputationScore {
  /** Overall trust score 0-100 */
  score: number;
  /** Trust tier based on score */
  tier: 'trusted' | 'normal' | 'untrusted';
  /** Individual component scores (0-100 each) */
  components: {
    compliance_rate: number;
    budget_adherence: number;
    pattern_regularity: number;
    time_since_incident: number;
    backoff_cooperation: number;
  };
  /** Loop detection threshold modulation */
  thresholds: {
    /** Multiplier for max_count in loop detection (e.g., 1.5 = 50% more lenient) */
    loop_max_count_multiplier: number;
    /** Gray zone entry point shift (negative = earlier) */
    gray_zone_offset: number;
  };
  /** When this score was last computed */
  computed_at_ms: number;
}

export interface ReputationState {
  /** Total requests observed */
  total_requests: number;
  /** Total requests blocked (storm + gray + policy) */
  total_blocked: number;
  /** Total storms detected */
  storm_count: number;
  /** Times agent cooperated with backoff signals */
  backoff_cooperations: number;
  /** Times agent ignored backoff signals */
  backoff_violations: number;
  /** Last incident (block) timestamp ms */
  last_incident_ms: number;
  /** Rolling 7-day compliance windows: [day_offset] → { requests, blocked } */
  daily_windows: Array<{ date: string; requests: number; blocked: number }>;
  /** Budget overshoot count (tried to use more than daily/weekly limit) */
  budget_overshoots: number;
  /** Budget check count */
  budget_checks: number;
  /** Created timestamp */
  created_at_ms: number;
  /** Last updated */
  updated_at_ms: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const WEIGHTS = {
  compliance_rate: 0.40,
  budget_adherence: 0.20,
  pattern_regularity: 0.15,
  time_since_incident: 0.15,
  backoff_cooperation: 0.10,
} as const;

/** How many daily windows to keep for rolling calculation */
const MAX_DAILY_WINDOWS = 30;

/** New agents start here */
const DEFAULT_SCORE = 50;

// ─── Core Functions ──────────────────────────────────────────────────────────

/** Create initial reputation state for a new agent/workspace */
export function createReputationState(nowMs?: number): ReputationState {
  const now = nowMs ?? Date.now();
  return {
    total_requests: 0,
    total_blocked: 0,
    storm_count: 0,
    backoff_cooperations: 0,
    backoff_violations: 0,
    last_incident_ms: 0,
    daily_windows: [],
    budget_overshoots: 0,
    budget_checks: 0,
    created_at_ms: now,
    updated_at_ms: now,
  };
}

/**
 * Record a request outcome into the reputation state.
 * Call this after each /v1/governor/check decision.
 */
export function recordOutcome(
  state: ReputationState,
  outcome: {
    blocked: boolean;
    reason?: 'storm' | 'gray_blocked' | 'policy' | 'credits';
    backoff_detected?: boolean;
    zone?: 'safe' | 'gray' | 'storm';
  },
  nowMs?: number,
): void {
  const now = nowMs ?? Date.now();
  state.total_requests += 1;
  state.updated_at_ms = now;

  // Track daily window
  const dateStr = new Date(now).toISOString().split('T')[0]!;
  let todayWindow = state.daily_windows.find(w => w.date === dateStr);
  if (!todayWindow) {
    todayWindow = { date: dateStr, requests: 0, blocked: 0 };
    state.daily_windows.push(todayWindow);
    // Trim old windows
    if (state.daily_windows.length > MAX_DAILY_WINDOWS) {
      state.daily_windows = state.daily_windows.slice(-MAX_DAILY_WINDOWS);
    }
  }
  todayWindow.requests += 1;

  if (outcome.blocked) {
    state.total_blocked += 1;
    todayWindow.blocked += 1;
    state.last_incident_ms = now;

    if (outcome.reason === 'storm') {
      state.storm_count += 1;
    }
  }

  // Track backoff cooperation
  if (outcome.zone === 'gray') {
    if (outcome.backoff_detected) {
      state.backoff_cooperations += 1;
    } else if (outcome.blocked) {
      state.backoff_violations += 1;
    }
  }
}

/** Record a budget event (overshoot or regular check) */
export function recordBudgetEvent(
  state: ReputationState,
  overshoot: boolean,
): void {
  state.budget_checks += 1;
  if (overshoot) {
    state.budget_overshoots += 1;
  }
}

/**
 * Compute the reputation score from current state.
 * This is a pure function — does not modify state.
 */
export function computeScore(state: ReputationState, nowMs?: number): ReputationScore {
  const now = nowMs ?? Date.now();

  // ── Component 1: Compliance rate (40%) ──────────────────────────────
  // Use recent 7 days if available, else all-time
  const recentDays = state.daily_windows.slice(-7);
  let recentRequests = 0;
  let recentBlocked = 0;
  for (const w of recentDays) {
    recentRequests += w.requests;
    recentBlocked += w.blocked;
  }
  // Fallback to all-time if no recent data
  const totalReq = recentRequests > 0 ? recentRequests : state.total_requests;
  const totalBlk = recentRequests > 0 ? recentBlocked : state.total_blocked;
  const complianceRate = totalReq > 0
    ? Math.min(100, Math.round(((totalReq - totalBlk) / totalReq) * 100))
    : DEFAULT_SCORE; // No data → neutral

  // ── Component 2: Budget adherence (20%) ─────────────────────────────
  const budgetAdherence = state.budget_checks > 0
    ? Math.min(100, Math.round(((state.budget_checks - state.budget_overshoots) / state.budget_checks) * 100))
    : DEFAULT_SCORE; // No budget data → neutral

  // ── Component 3: Pattern regularity (15%) ───────────────────────────
  // Fewer storms relative to total requests = better
  const stormRatio = state.total_requests > 0
    ? state.storm_count / state.total_requests
    : 0;
  // stormRatio 0 → 100, stormRatio >= 0.1 → 0
  const patternRegularity = Math.min(100, Math.max(0, Math.round((1 - stormRatio * 10) * 100)));

  // ── Component 4: Time since incident (15%) ──────────────────────────
  // More days since last incident → higher score
  // 0 days → 20, 1 day → 40, 3 days → 60, 7 days → 80, 14+ days → 100
  let timeSinceIncident: number;
  if (state.last_incident_ms === 0) {
    timeSinceIncident = 100; // Never had an incident
  } else {
    const daysSince = (now - state.last_incident_ms) / (24 * 60 * 60 * 1000);
    // Logarithmic curve: score = min(100, 20 + 80 * log2(daysSince + 1) / log2(15))
    timeSinceIncident = Math.min(100, Math.max(0,
      Math.round(20 + 80 * Math.log2(daysSince + 1) / Math.log2(15))
    ));
  }

  // ── Component 5: Backoff cooperation (10%) ──────────────────────────
  const totalBackoffEvents = state.backoff_cooperations + state.backoff_violations;
  const backoffCooperation = totalBackoffEvents > 0
    ? Math.min(100, Math.round((state.backoff_cooperations / totalBackoffEvents) * 100))
    : DEFAULT_SCORE; // No data → neutral

  // ── Weighted sum ────────────────────────────────────────────────────
  const score = Math.round(
    complianceRate * WEIGHTS.compliance_rate +
    budgetAdherence * WEIGHTS.budget_adherence +
    patternRegularity * WEIGHTS.pattern_regularity +
    timeSinceIncident * WEIGHTS.time_since_incident +
    backoffCooperation * WEIGHTS.backoff_cooperation
  );

  // ── Tier classification ─────────────────────────────────────────────
  const tier: ReputationScore['tier'] =
    score >= 80 ? 'trusted' :
    score >= 50 ? 'normal' :
    'untrusted';

  // ── Threshold modulation ────────────────────────────────────────────
  // Trusted agents: 50% more lenient loop detection, gray zone starts 2 counts later
  // Untrusted agents: 30% stricter, gray zone starts 2 counts earlier
  const thresholds = {
    loop_max_count_multiplier:
      tier === 'trusted' ? 1.5 :
      tier === 'untrusted' ? 0.7 :
      1.0,
    gray_zone_offset:
      tier === 'trusted' ? 2 :
      tier === 'untrusted' ? -2 :
      0,
  };

  return {
    score,
    tier,
    components: {
      compliance_rate: complianceRate,
      budget_adherence: budgetAdherence,
      pattern_regularity: patternRegularity,
      time_since_incident: timeSinceIncident,
      backoff_cooperation: backoffCooperation,
    },
    thresholds,
    computed_at_ms: now,
  };
}

// ─── Serialization ───────────────────────────────────────────────────────────

export function serializeReputationState(state: ReputationState): string {
  return JSON.stringify(state);
}

export function deserializeReputationState(raw: string): ReputationState {
  return JSON.parse(raw) as ReputationState;
}
