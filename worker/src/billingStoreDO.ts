import {
  createBaseline,
  updateAndClassify,
  serializeState as serializeBaseline,
  deserializeState as deserializeBaseline,
} from './lib/adaptiveBaseline.js';
import type { AgentBaseline } from './lib/adaptiveBaseline.js';
import { JtiBlacklist } from './lib/jtiBlacklist.js';
import {
  createFingerprintState,
  updateFingerprint,
  serializeFingerprintState,
  deserializeFingerprintState,
} from './lib/behaviorFingerprint.js';
import type { BehaviorFingerprint } from './lib/behaviorFingerprint.js';
import {
  exportDailyAggregate,
  aggregateDecisions,
  cleanupOldPatterns,
} from './lib/crossIntelligence.js';
import type { D1Database } from './lib/crossIntelligence.js';
import { CREDITS } from './lib/constants.js';
import {
  applyFreeTopUp,
  freeGrantStorageKey,
  resolveEffectivePlanFromSub,
  type EffectivePlanSnapshot,
} from './lib/effectivePlan.js';

export type BillingQuoteRecord = {
  quoteId: string;
  workspaceId: string;
  credits: number;
  requiredPrice: string;
  chain: string;
  recipient: string;
  createdAtMs: number;
  expiresAtMs: number;
  redeemedAtMs?: number;
  txHash?: string;
};

// Payment audit record - permanent log of all confirmed payments
export type PaymentRecord = {
  id: string;               // payment_{timestamp}_{random}
  invoiceId: string;
  workspaceId: string;
  txHash: string;
  chain: string;
  chainId: number;
  amountUsdc: number;
  plan: string;
  months: number;
  email?: string;
  type: 'subscription' | 'renewal' | 'upgrade';
  confirmedAtMs: number;
  createdAtMs: number;
};

type WorkspaceBalance = {
  workspaceId: string;
  credits: number;
  updatedAtMs: number;
};

type AgentProfile = {
  agent_id: string;
  first_seen_ms: number;
  last_seen_ms: number;
  total_payments_usdc: number;
  payment_count: number;
  workspace_ids: string[];
  wallet_address?: string;
};

type WorkspaceAuth = {
  workspaceId: string;
  apiKeyHash: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type BudgetConfig = {
  workspaceId: string;
  dailyLimit?: number;
  weeklyLimit?: number;
  monthlyLimit?: number;
  alertThreshold?: number; // 0-100 percentage
  webhookUrl?: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type UsageRecord = {
  workspaceId: string;
  date: string; // YYYY-MM-DD
  credits: number;
  actions: Record<string, number>; // action type -> count
  tools: Record<string, number>; // tool name -> count
};

// Track blocked requests for "cost saved" metric
export type BlockedStats = {
  workspaceId: string;
  blockedRequests: number; // Total blocked requests
  estimatedCostSavedUsd: number; // Estimated USD saved
  blockedByReason: Record<string, number>; // reason -> count
  lastBlockedAtMs?: number;
  updatedAtMs: number;
};

// Governor session — cumulative budget tracking per agent session
export type GovernorSession = {
  sessionId: string;
  workspaceId: string;
  agentId: string;
  budgetLimitUsd: string;    // max spend for this session
  totalSpentUsd: string;     // cumulative running total
  requestCount: number;      // cumulative request count
  status: 'open' | 'closed' | 'exceeded';
  expiresAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
};

// Loop detection - track recent request patterns
export type LoopPattern = {
  hash: string; // Hash of action + task_hash
  count: number;
  firstSeenMs: number;
  lastSeenMs: number;
  /** Last N timestamps for interval analysis (max 20 kept) */
  timestamps: number[];
  /** Accumulated cost in this window (USD) */
  costUsd: number;
};

// Decision log entry — stored per demo/workspace for real dashboard data
export type DemoDecisionEntry = {
  id: string;
  timestamp: string;
  action: string;
  task_hash: string;
  step_hash: string;
  decision: 'allowed' | 'blocked_storm' | 'blocked_credits' | 'friction_required';
  latency_ms: number;
  pattern_count?: number;
  cost_saved_usd?: number;
  ai_reasoning?: string;
};

type PutQuoteBody = { record: BillingQuoteRecord };

type ConsumeBody = { n: number; action?: string; tool?: string };

type RedeemBody = { tx_hash: string };

type SetKeyBody = { api_key_hash: string };
type VerifyKeyBody = { api_key_hash: string };

type SetBudgetBody = {
  daily_limit?: number;
  weekly_limit?: number;
  monthly_limit?: number;
  alert_threshold?: number;
  webhook_url?: string;
};

function normalizeHex0x(input: string): string {
  const s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  return s.startsWith('0x') ? s : `0x${s}`;
}

function normalizeKeyHash(input: string): string {
  const s = String(input || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) return '';
  return s;
}

export class BillingStoreDO {
  private state: DurableObjectState;
  private jtiBlacklist: JtiBlacklist;
  private d1: D1Database | null;
  private env: Record<string, unknown>;

  constructor(state: DurableObjectState, env?: Record<string, unknown>) {
    this.state = state;
    this.env = env ?? {};
    this.d1 = (env && typeof env === 'object' && 'ANALYTICS_D1' in env)
      ? env.ANALYTICS_D1 as D1Database
      : null;
    this.jtiBlacklist = new JtiBlacklist(state.storage);
    // Load JTI blacklist + schedule alarms before first request.
    state.blockConcurrencyWhile(async () => {
      await this.jtiBlacklist.load();
      await this.ensureAlarmScheduled();
    });
  }

  private async ensureAlarmScheduled(): Promise<void> {
    const existingAlarm = await this.state.storage.getAlarm();
    if (!existingAlarm) {
      // Schedule alarm for next midnight UTC
      const now = new Date();
      const nextMidnight = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        0, 0, 0, 0
      ));
      await this.state.storage.setAlarm(nextMidnight.getTime());
    }
  }

  // Daily cleanup alarm handler
  async alarm(): Promise<void> {
    console.log('[BillingStoreDO] Running daily cleanup alarm');
    
    // Get all workspace subscriptions and clean up old usage logs
    const allKeys = await this.state.storage.list({ prefix: 'sub:' });
    const nowMs = Date.now();
    
    for (const [key] of allKeys) {
      const workspaceId = key.replace('sub:', '');
      const sub = await this.state.storage.get<{
        plan?: string;
        expiresAtMs?: number;
        features?: { logRetentionDays?: number };
      }>(key);
      const retentionDays = sub?.features?.logRetentionDays ?? 30;
      
      await this.cleanupOldUsageLogs(workspaceId, retentionDays);

      // ── Subscription expiry enforcement ───────────────────────
      if (sub?.expiresAtMs) {
        const daysLeft = Math.ceil((sub.expiresAtMs - nowMs) / (24 * 60 * 60 * 1000));
        const notifiedKey = `notified:sub_expiring:${workspaceId}`;
        const alreadyNotified = await this.state.storage.get<boolean>(notifiedKey);

        // Warn at 7, 3, 1 days before expiry
        if (daysLeft <= 7 && daysLeft > 0 && !alreadyNotified) {
          // Fire webhook if configured
          const webhookData = await this.state.storage.get<{
            webhookUrl?: string | null;
            webhookSecret?: string | null;
            events?: string[];
          }>(`webhook:${workspaceId}`);
          if (webhookData?.webhookUrl) {
            const { webhookSubscriptionExpiring } = await import('./services/webhook.js');
            webhookSubscriptionExpiring(this.env as unknown as import('./types.js').Env, {
              webhookUrl: webhookData.webhookUrl,
              webhookSecret: webhookData.webhookSecret ?? undefined,
              workspaceId,
              expiresAt: new Date(sub.expiresAtMs).toISOString(),
              daysRemaining: daysLeft,
            }).catch(err => console.error('Sub expiring webhook failed:', err));
          }

          // Send expiry warning email if configured (fire-and-forget)
          const subData = await this.state.storage.get<{
            email?: string | null;
            plan?: string;
          }>(`sub:${workspaceId}`);
          if (subData?.email) {
            const emailCooldownKey = `notified:expiry_email:${workspaceId}`;
            const lastEmailMs = await this.state.storage.get<number>(emailCooldownKey);
            const oneDayMs = 24 * 60 * 60 * 1000;
            if (!lastEmailMs || (Date.now() - lastEmailMs) > oneDayMs) {
              import('./services/email.js').then(({ sendExpiryWarning }) => {
                sendExpiryWarning(this.env as unknown as import('./types.js').Env, {
                  to: subData.email!,
                  workspaceId,
                  expiresAt: new Date(sub.expiresAtMs!).toISOString(),
                  plan: subData.plan ?? 'starter',
                  daysLeft,
                }).catch(err => console.error('Expiry email failed:', err));
              }).catch(() => {});
              await this.state.storage.put(emailCooldownKey, Date.now());
            }
          }

          await this.state.storage.put(notifiedKey, true);
          console.log(`[BillingStoreDO] Subscription expiry warning: ${workspaceId} expires in ${daysLeft} days`);
        }

        // Reset notification flag when renewed (expiry pushed out > 7 days)
        if (daysLeft > 7 && alreadyNotified) {
          await this.state.storage.delete(notifiedKey);
        }

        // Hard enforcement: block workspace if subscription expired
        if (daysLeft <= 0) {
          const bal = await this.readBalanceRecord(workspaceId);
          if (bal && bal.credits > 0) {
            console.log(`[BillingStoreDO] Subscription expired for ${workspaceId}, freezing ${bal.credits} credits`);
            // Store frozen credits for potential reactivation
            await this.state.storage.put(`frozen_credits:${workspaceId}`, bal.credits);
            bal.credits = 0;
            await this.putBalance(bal);
          }
        }
      }
    }

    // Cleanup expired JTI blacklist entries + persist
    this.jtiBlacklist.cleanupExpired();
    await this.jtiBlacklist.persist();

    // Cross-workspace intelligence: export daily aggregates to D1
    if (this.d1) {
      try {
        // Collect decision logs from all workspaces and export
        const decisionKeys = await this.state.storage.list({ prefix: 'decision_log:' });
        for (const [logKey] of decisionKeys) {
          const wsId = logKey.replace('decision_log:', '');
          const rawLogs = await this.state.storage.get<Array<{
            timestamp: string | number;
            zone: string;
            fingerprint_hash?: string;
            cost_saved_usd?: number;
            burst_index?: number;
            entropy?: number;
          }>>(logKey);
          if (rawLogs && rawLogs.length > 0) {
            const aggregates = aggregateDecisions(rawLogs);
            await exportDailyAggregate(this.d1, wsId, aggregates);
          }
        }
        // Cleanup old D1 data (90 day retention)
        await cleanupOldPatterns(this.d1, 90);
        console.log('[BillingStoreDO] Cross-intelligence export complete');
      } catch (err) {
        console.error('[BillingStoreDO] Cross-intelligence export failed:', err);
      }
    }
    
    // ── Weekly savings email (runs on Mondays UTC) ───────────────────
    const today = new Date();
    if (today.getUTCDay() === 1) { // Monday
      const allSubKeys = await this.state.storage.list({ prefix: 'sub:' });
      for (const [subKey] of allSubKeys) {
        const wsId = subKey.replace('sub:', '');
        const subData = await this.state.storage.get<{
          plan?: string;
          email?: string;
        }>(subKey);
        if (!subData?.email) continue; // No email configured, skip

        // Gather last 7 days of stats
        const blockedStats = await this.state.storage.get<BlockedStats>(`blocked:${wsId}`);
        let weeklyCreditsUsed = 0;
        const actionCounts: Record<string, number> = {};
        for (let i = 0; i < 7; i++) {
          const d = new Date(today);
          d.setDate(d.getDate() - i);
          const dateKey = d.toISOString().split('T')[0]!;
          const usage = await this.state.storage.get<UsageRecord>(`usage:${wsId}:${dateKey}`);
          if (usage) {
            weeklyCreditsUsed += usage.credits;
            for (const [act, cnt] of Object.entries(usage.actions)) {
              actionCounts[act] = (actionCounts[act] ?? 0) + cnt;
            }
          }
        }

        const costSaved = blockedStats?.estimatedCostSavedUsd ?? 0;
        if (costSaved <= 0 && weeklyCreditsUsed <= 0) continue; // No activity

        const weekEnd = today.toISOString().split('T')[0]!;
        const weekStartDate = new Date(today);
        weekStartDate.setDate(weekStartDate.getDate() - 7);
        const weekStart = weekStartDate.toISOString().split('T')[0]!;

        const topActions = Object.entries(actionCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([action, count]) => ({ action, count }));

        try {
          const { sendWeeklySavingsReport } = await import('./services/email.js');
          await sendWeeklySavingsReport(this.env as unknown as import('./types.js').Env, {
            to: subData.email,
            workspaceId: wsId,
            plan: subData.plan ?? 'free',
            costSavedUsd: costSaved,
            stormsBlocked: blockedStats?.blockedRequests ?? 0,
            totalChecks: weeklyCreditsUsed,
            topActions,
            weekStart,
            weekEnd,
          });
          console.log(`[BillingStoreDO] Weekly savings email sent to ${wsId}`);
        } catch (err) {
          console.error(`[BillingStoreDO] Weekly email failed for ${wsId}:`, err);
        }
      }
    }

    // Schedule next alarm for tomorrow
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    await this.state.storage.setAlarm(tomorrow.getTime());
    
    console.log('[BillingStoreDO] Daily cleanup complete, next alarm:', tomorrow.toISOString());
  }

  private async getQuote(quoteId: string): Promise<BillingQuoteRecord | null> {
    const record = (await this.state.storage.get<BillingQuoteRecord>(`quote:${quoteId}`)) ?? null;
    if (!record) return null;

    if (Date.now() >= record.expiresAtMs) {
      await this.state.storage.delete(`quote:${quoteId}`);
      return null;
    }

    return record;
  }

  private async readBalanceRecord(workspaceId: string): Promise<WorkspaceBalance | null> {
    return (await this.state.storage.get<WorkspaceBalance>(`ws:${workspaceId}`)) ?? null;
  }

  /** Resolve workspace balance without creating orphan zero-credit rows. */
  private async resolveBalance(workspaceId: string): Promise<
    | { ok: true; balance: WorkspaceBalance; reconstructed?: boolean }
    | { ok: false; error: 'workspace_not_initialized' | 'billing_not_initialized' }
  > {
    const existing = await this.readBalanceRecord(workspaceId);
    if (existing) return { ok: true, balance: existing };

    const auth = await this.getAuth(workspaceId);
    const sub = await this.state.storage.get<{
      plan?: string;
      credits?: number;
    }>(`sub:${workspaceId}`);

    if (!auth && !sub) {
      return { ok: false, error: 'billing_not_initialized' };
    }

    if (!sub) {
      return { ok: false, error: 'workspace_not_initialized' };
    }

    // Free tier: recover balance row from subscription metadata when auth exists.
    if (sub.plan === 'free' && auth) {
      const credits =
        typeof sub.credits === 'number' && sub.credits > 0 ? sub.credits : CREDITS.FREE_TIER;
      const fresh: WorkspaceBalance = {
        workspaceId,
        credits,
        updatedAtMs: Date.now(),
      };
      await this.putBalance(fresh);
      console.log(`[BillingStoreDO] Reconstructed free-tier balance for ${workspaceId}: ${credits} credits`);
      return { ok: true, balance: fresh, reconstructed: true };
    }

    // Paid workspace with auth but missing balance row — zero balance, no free grant.
    if (auth) {
      const fresh: WorkspaceBalance = {
        workspaceId,
        credits: 0,
        updatedAtMs: Date.now(),
      };
      await this.putBalance(fresh);
      return { ok: true, balance: fresh, reconstructed: true };
    }

    return { ok: false, error: 'workspace_not_initialized' };
  }

  private async getBalance(workspaceId: string): Promise<WorkspaceBalance> {
    const resolved = await this.resolveBalance(workspaceId);
    if (resolved.ok) return resolved.balance;
    return {
      workspaceId,
      credits: 0,
      updatedAtMs: Date.now(),
    };
  }

  private async putBalance(balance: WorkspaceBalance): Promise<void> {
    balance.updatedAtMs = Date.now();
    await this.state.storage.put(`ws:${balance.workspaceId}`, balance);
  }

  private async resolveEffectivePlan(
    workspaceId: string,
    nowMs: number,
  ): Promise<EffectivePlanSnapshot | null> {
    const sub = await this.state.storage.get<{
      plan?: string;
      expiresAtMs?: number;
    }>(`sub:${workspaceId}`);
    if (!sub) return null;

    const storedPlan = sub.plan || 'free';
    const expiresAtMs = sub.expiresAtMs ?? 0;
    const bal = await this.readBalanceRecord(workspaceId);
    const creditsRemaining = bal?.credits ?? 0;

    return resolveEffectivePlanFromSub({
      storedPlan,
      expiresAtMs,
      creditsRemaining,
      nowMs,
    });
  }

  /**
   * Policy B: once per calendar month (UTC), top free-tier balance up to 5000 if below cap.
   */
  private async reconcileFreeAllowance(
    workspaceId: string,
    effective: EffectivePlanSnapshot,
    nowMs: number,
  ): Promise<{ credits_remaining: number; free_grant_applied: boolean }> {
    if (effective.effective_plan !== 'free') {
      return { credits_remaining: effective.credits_remaining, free_grant_applied: false };
    }

    const grantKey = freeGrantStorageKey(workspaceId, effective.free_period_key);
    const alreadyGranted = await this.state.storage.get<boolean>(grantKey);
    if (alreadyGranted) {
      const bal = await this.readBalanceRecord(workspaceId);
      return { credits_remaining: bal?.credits ?? effective.credits_remaining, free_grant_applied: false };
    }

    const resolved = await this.resolveBalance(workspaceId);
    if (!resolved.ok) {
      return { credits_remaining: effective.credits_remaining, free_grant_applied: false };
    }

    const before = resolved.balance.credits;
    const after = applyFreeTopUp(before);
    if (after !== before) {
      resolved.balance.credits = after;
      await this.putBalance(resolved.balance);
    }
    await this.state.storage.put(grantKey, true);
    return { credits_remaining: after, free_grant_applied: after > before };
  }

  private async reconcileBilling(
    workspaceId: string,
    nowMs = Date.now(),
  ): Promise<
    | { ok: true; effective: EffectivePlanSnapshot; free_grant_applied: boolean }
    | { ok: false; error: 'subscription_not_found' | 'billing_not_initialized' | 'workspace_not_initialized' }
  > {
    const effective = await this.resolveEffectivePlan(workspaceId, nowMs);
    if (!effective) {
      const resolved = await this.resolveBalance(workspaceId);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      return { ok: false, error: 'subscription_not_found' };
    }

    const grant = await this.reconcileFreeAllowance(workspaceId, effective, nowMs);
    effective.credits_remaining = grant.credits_remaining;
    return { ok: true, effective, free_grant_applied: grant.free_grant_applied };
  }

  private async getAuth(workspaceId: string): Promise<WorkspaceAuth | null> {
    const auth = (await this.state.storage.get<WorkspaceAuth>(`auth:${workspaceId}`)) ?? null;
    return auth;
  }

  private async setAuth(workspaceId: string, apiKeyHash: string): Promise<void> {
    const nowMs = Date.now();
    const existing = await this.getAuth(workspaceId);
    const record: WorkspaceAuth = {
      workspaceId,
      apiKeyHash,
      createdAtMs: existing?.createdAtMs ?? nowMs,
      updatedAtMs: nowMs,
    };
    await this.state.storage.put(`auth:${workspaceId}`, record);
  }

  private async deleteAuth(workspaceId: string): Promise<void> {
    await this.state.storage.delete(`auth:${workspaceId}`);
  }

  // ── Smart Pattern Matching helpers ────────────────────────────────────────

  /**
   * Detect exponential backoff in request intervals.
   * Returns true if intervals are consistently increasing (agent is backing off).
   * Requires at least 3 intervals to be meaningful.
   */
  private detectBackoff(intervals: number[]): boolean {
    if (intervals.length < 3) return false;

    // Check last 5 intervals (most recent behavior matters most)
    const recent = intervals.slice(-5);
    let increasing = 0;
    for (let i = 1; i < recent.length; i++) {
      // Each interval should be at least 20% larger than the previous
      if (recent[i] > recent[i - 1] * 1.2) increasing++;
    }
    // If >60% of intervals are increasing → backoff pattern
    return increasing / (recent.length - 1) > 0.6;
  }

  /**
   * Track and count similar patterns using a shared prefix.
   * Groups actions like "scrape:page=1", "scrape:page=2" under the same prefix "scrape:pag".
   * Returns total unique patterns in the similarity group within the window.
   */
  private async trackSimilarityGroup(
    workspaceId: string,
    prefix: string,
    nowMs: number,
    windowMs: number,
  ): Promise<number> {
    const simKey = `sim:${workspaceId}:${prefix}`;
    const existing = await this.state.storage.get<{ hashes: string[]; lastMs: number }>(simKey);

    if (!existing || (nowMs - existing.lastMs) > windowMs) {
      // Expired or new — start fresh
      await this.state.storage.put(simKey, { hashes: [prefix], lastMs: nowMs });
      return 1;
    }

    // Add this prefix variant if not already tracked (max 50)
    if (!existing.hashes.includes(prefix) && existing.hashes.length < 50) {
      existing.hashes.push(prefix);
    }
    existing.lastMs = nowMs;
    await this.state.storage.put(simKey, existing);
    return existing.hashes.length;
  }

  // Budget management
  private async getBudget(workspaceId: string): Promise<BudgetConfig | null> {
    return (await this.state.storage.get<BudgetConfig>(`budget:${workspaceId}`)) ?? null;
  }

  private async setBudget(workspaceId: string, config: SetBudgetBody): Promise<BudgetConfig> {
    const existing = await this.getBudget(workspaceId);
    const nowMs = Date.now();
    
    const updated: BudgetConfig = {
      workspaceId,
      dailyLimit: config.daily_limit ?? existing?.dailyLimit,
      weeklyLimit: config.weekly_limit ?? existing?.weeklyLimit,
      monthlyLimit: config.monthly_limit ?? existing?.monthlyLimit,
      alertThreshold: config.alert_threshold ?? existing?.alertThreshold,
      webhookUrl: config.webhook_url ?? existing?.webhookUrl,
      createdAtMs: existing?.createdAtMs ?? nowMs,
      updatedAtMs: nowMs,
    };

    await this.state.storage.put(`budget:${workspaceId}`, updated);
    return updated;
  }

  // Usage tracking
  private getDateKey(): string {
    return new Date().toISOString().split('T')[0]!; // YYYY-MM-DD
  }

  private async getUsage(workspaceId: string, date: string): Promise<UsageRecord> {
    const key = `usage:${workspaceId}:${date}`;
    const existing = await this.state.storage.get<UsageRecord>(key);
    if (existing) return existing;

    return {
      workspaceId,
      date,
      credits: 0,
      actions: {},
      tools: {},
    };
  }

  private async recordUsage(workspaceId: string, n: number, action?: string, tool?: string): Promise<void> {
    const date = this.getDateKey();
    const usage = await this.getUsage(workspaceId, date);

    usage.credits += n;
    if (action) {
      usage.actions[action] = (usage.actions[action] ?? 0) + 1;
    }
    if (tool) {
      usage.tools[tool] = (usage.tools[tool] ?? 0) + 1;
    }

    await this.state.storage.put(`usage:${workspaceId}:${date}`, usage);
  }

  private async cleanupOldUsageLogs(workspaceId: string, retentionDays: number): Promise<void> {
    // Clean up usage logs older than retention period
    const today = new Date();
    const keysToDelete: string[] = [];
    
    // Check up to 90 days back for old data (max retention is 90 days)
    for (let i = retentionDays + 1; i <= 90; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateKey = date.toISOString().split('T')[0]!;
      keysToDelete.push(`usage:${workspaceId}:${dateKey}`);
    }
    
    if (keysToDelete.length > 0) {
      await this.state.storage.delete(keysToDelete);
    }
  }

  private async getUsageForPeriod(workspaceId: string, days: number): Promise<number> {
    let total = 0;
    const today = new Date();

    for (let i = 0; i < days; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateKey = date.toISOString().split('T')[0]!;
      const usage = await this.getUsage(workspaceId, dateKey);
      total += usage.credits;
    }

    return total;
  }

  private async checkBudgetLimits(workspaceId: string, toConsume: number): Promise<{ ok: boolean; error?: string; limit?: string; usage?: number }> {
    const budget = await this.getBudget(workspaceId);
    if (!budget) return { ok: true }; // No budget = no limits

    const today = this.getDateKey();
    const todayUsage = await this.getUsage(workspaceId, today);

    // Check daily limit
    if (budget.dailyLimit !== undefined) {
      if (todayUsage.credits + toConsume > budget.dailyLimit) {
        return { 
          ok: false, 
          error: 'daily_limit_exceeded',
          limit: 'daily',
          usage: todayUsage.credits,
        };
      }
    }

    // Check weekly limit
    if (budget.weeklyLimit !== undefined) {
      const weekUsage = await this.getUsageForPeriod(workspaceId, 7);
      if (weekUsage + toConsume > budget.weeklyLimit) {
        return { 
          ok: false, 
          error: 'weekly_limit_exceeded',
          limit: 'weekly',
          usage: weekUsage,
        };
      }
    }

    // Check monthly limit
    if (budget.monthlyLimit !== undefined) {
      const monthUsage = await this.getUsageForPeriod(workspaceId, 30);
      if (monthUsage + toConsume > budget.monthlyLimit) {
        return { 
          ok: false, 
          error: 'monthly_limit_exceeded',
          limit: 'monthly',
          usage: monthUsage,
        };
      }
    }

    return { ok: true };
  }

  // ========================================================================
  // Governor Sessions — cumulative budget tracking (MPP-inspired)
  // ========================================================================
  async handleSession(request: Request, url: URL, parts: string[]): Promise<Response> {
    // POST /sessions — create a new session
    if (request.method === 'POST' && parts.length === 1) {
      const body = await request.json().catch(() => null) as {
        session_id?: string;
        workspace_id?: string;
        agent_id?: string;
        budget_usd?: string;
        duration_hours?: number;
      } | null;
      if (!body?.session_id || !body?.workspace_id || !body?.agent_id || !body?.budget_usd) {
        return Response.json({ ok: false, error: 'missing_fields' }, { status: 400 });
      }

      const existing = await this.state.storage.get<GovernorSession>(`session:${body.session_id}`);
      if (existing) {
        return Response.json({ ok: false, error: 'session_exists' }, { status: 409 });
      }

      const durationMs = (body.duration_hours ?? 24) * 60 * 60 * 1000;
      const nowMs = Date.now();
      const session: GovernorSession = {
        sessionId: body.session_id,
        workspaceId: body.workspace_id,
        agentId: body.agent_id,
        budgetLimitUsd: body.budget_usd,
        totalSpentUsd: '0',
        requestCount: 0,
        status: 'open',
        expiresAtMs: nowMs + durationMs,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      };

      await this.state.storage.put(`session:${body.session_id}`, session);

      // Track active session IDs per workspace
      const activeIds = await this.state.storage.get<string[]>(`sessions:${body.workspace_id}`) || [];
      activeIds.push(body.session_id);
      await this.state.storage.put(`sessions:${body.workspace_id}`, activeIds);

      return Response.json({ ok: true, session }, { status: 201 });
    }

    // GET /sessions/:id — get session status
    if (request.method === 'GET' && parts.length === 2) {
      const sessionId = parts[1]!;
      const session = await this.state.storage.get<GovernorSession>(`session:${sessionId}`);
      if (!session) {
        return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
      }

      // Auto-expire
      if (session.status === 'open' && Date.now() > session.expiresAtMs) {
        session.status = 'closed';
        session.updatedAtMs = Date.now();
        await this.state.storage.put(`session:${sessionId}`, session);
      }

      const budgetLimit = parseFloat(session.budgetLimitUsd);
      const totalSpent = parseFloat(session.totalSpentUsd);

      return Response.json({
        ok: true,
        session: {
          ...session,
          remainingUsd: (budgetLimit - totalSpent).toFixed(6),
        },
      }, { status: 200 });
    }

    // POST /sessions/:id/record — record cumulative spend (voucher-style)
    if (request.method === 'POST' && parts.length === 3 && parts[2] === 'record') {
      const sessionId = parts[1]!;
      const session = await this.state.storage.get<GovernorSession>(`session:${sessionId}`);
      if (!session) {
        return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
      }

      // Auto-expire check
      if (session.status === 'open' && Date.now() > session.expiresAtMs) {
        session.status = 'closed';
        session.updatedAtMs = Date.now();
        await this.state.storage.put(`session:${sessionId}`, session);
        return Response.json({ ok: false, error: 'session_expired' }, { status: 410 });
      }

      if (session.status !== 'open') {
        return Response.json({ ok: false, error: `session_${session.status}` }, { status: 400 });
      }

      const body = await request.json().catch(() => null) as {
        cost_usd?: string;
        request_count?: number;
      } | null;
      if (!body?.cost_usd) {
        return Response.json({ ok: false, error: 'missing_cost_usd' }, { status: 400 });
      }

      const addedCost = parseFloat(body.cost_usd);
      const newTotal = parseFloat(session.totalSpentUsd) + addedCost;
      const budgetLimit = parseFloat(session.budgetLimitUsd);

      session.totalSpentUsd = newTotal.toFixed(6);
      session.requestCount = (body.request_count ?? session.requestCount + 1);
      session.updatedAtMs = Date.now();

      if (newTotal >= budgetLimit) {
        session.status = 'exceeded';
      }

      await this.state.storage.put(`session:${sessionId}`, session);

      return Response.json({
        ok: true,
        session_id: sessionId,
        total_spent_usd: session.totalSpentUsd,
        remaining_usd: Math.max(0, budgetLimit - newTotal).toFixed(6),
        request_count: session.requestCount,
        status: session.status,
        budget_exceeded: newTotal >= budgetLimit,
      }, { status: 200 });
    }

    // DELETE /sessions/:id — close session (settle)
    if (request.method === 'DELETE' && parts.length === 2) {
      const sessionId = parts[1]!;
      const session = await this.state.storage.get<GovernorSession>(`session:${sessionId}`);
      if (!session) {
        return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
      }

      session.status = 'closed';
      session.updatedAtMs = Date.now();
      await this.state.storage.put(`session:${sessionId}`, session);

      // Remove from active sessions list
      const activeIds = await this.state.storage.get<string[]>(`sessions:${session.workspaceId}`) || [];
      const filtered = activeIds.filter(id => id !== sessionId);
      await this.state.storage.put(`sessions:${session.workspaceId}`, filtered);

      return Response.json({
        ok: true,
        session_id: sessionId,
        final_spent_usd: session.totalSpentUsd,
        request_count: session.requestCount,
        status: 'closed',
      }, { status: 200 });
    }

    // GET /sessions — list active sessions for a workspace
    if (request.method === 'GET' && parts.length === 1) {
      const workspaceId = url.searchParams.get('workspace_id');
      if (!workspaceId) {
        return Response.json({ ok: false, error: 'missing_workspace_id' }, { status: 400 });
      }

      const activeIds = await this.state.storage.get<string[]>(`sessions:${workspaceId}`) || [];
      const sessions: GovernorSession[] = [];
      for (const id of activeIds) {
        const s = await this.state.storage.get<GovernorSession>(`session:${id}`);
        if (s) sessions.push(s);
      }

      return Response.json({ ok: true, sessions }, { status: 200 });
    }

    return new Response('method_not_allowed', { status: 405 });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    // Early session routing — handle before any other block
    if (parts[0] === 'sessions') {
      return this.handleSession(request, url, parts);
    }

    // Internal DO API:
    // - PUT  /quotes/:id { record }
    // - GET  /quotes/:id
    // - POST /quotes/:id/redeem { tx_hash }
    // - GET  /workspaces/:id
    // - POST /workspaces/:id/consume { n }
    // - PUT  /workspaces/:id/key { api_key_hash }
    // - DELETE /workspaces/:id/key
    // - POST /workspaces/:id/verify { api_key_hash }
    // - GET  /workspaces/:id/auth
    // - POST /jti/mark { jti, expires_at }
    // - POST /jti/check { jti }
    // - GET  /cross-intel/anomalies

    // ── Cross-Intelligence anomaly endpoint ───────────────────────────────
    if (parts[0] === 'cross-intel' && parts[1] === 'anomalies' && request.method === 'GET') {
      if (!this.d1) {
        return Response.json({ ok: false, error: 'D1 not configured' }, { status: 501 });
      }
      const { checkGlobalAnomalies } = await import('./lib/crossIntelligence.js');
      const result = await checkGlobalAnomalies(this.d1);
      return Response.json({ ok: true, ...result }, { status: 200 });
    }

    // ── JTI Blacklist endpoints ───────────────────────────────────────────
    if (parts[0] === 'jti' && parts.length === 2) {
      if (request.method === 'POST' && parts[1] === 'mark') {
        const body = (await request.json().catch(() => null)) as { jti?: string; expires_at?: number } | null;
        if (!body?.jti || !body?.expires_at) {
          return new Response('invalid_request', { status: 400 });
        }
        this.jtiBlacklist.markAsUsed(body.jti, body.expires_at);
        this.jtiBlacklist.schedulePersist();
        return Response.json({ ok: true }, { status: 200 });
      }

      if (request.method === 'POST' && parts[1] === 'check') {
        const body = (await request.json().catch(() => null)) as { jti?: string } | null;
        if (!body?.jti) {
          return new Response('invalid_request', { status: 400 });
        }
        const blacklisted = this.jtiBlacklist.isBlacklisted(body.jti);
        return Response.json({ ok: true, blacklisted }, { status: 200 });
      }
    }

    // POST /magic-tokens { token, workspace_id, expires_at_ms } - store magic link token
    if (parts[0] === 'magic-tokens' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as { token?: string; workspace_id?: string; expires_at_ms?: number } | null;
      if (!body?.token || !body?.workspace_id || !body?.expires_at_ms) {
        return new Response('invalid_request', { status: 400 });
      }
      await this.state.storage.put(`magic:${body.token}`, { workspace_id: body.workspace_id, expires_at_ms: body.expires_at_ms });
      return Response.json({ ok: true }, { status: 200 });
    }

    // GET /magic-tokens/:token - one-time use: read and delete
    if (parts[0] === 'magic-tokens' && parts.length === 2 && request.method === 'GET') {
      const token = parts[1]!;
      const data = await this.state.storage.get<{ workspace_id: string; expires_at_ms: number }>(`magic:${token}`);
      await this.state.storage.delete(`magic:${token}`); // always delete, even if expired
      if (!data || data.expires_at_ms < Date.now()) {
        return Response.json({ ok: false, error: 'invalid_or_expired' }, { status: 404 });
      }
      return Response.json({ ok: true, workspace_id: data.workspace_id }, { status: 200 });
    }

    // POST /rate-limit/check { key, limit, window_ms } - distributed-ish rate limiting (single DO instance)
    if (parts[0] === 'rate-limit' && parts[1] === 'check' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as { key?: string; limit?: number; window_ms?: number } | null;
      const key = String(body?.key ?? '').trim();
      const limit = Number(body?.limit ?? 0);
      const windowMs = Number(body?.window_ms ?? 0);

      if (!key || !Number.isFinite(limit) || limit <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
        return new Response('invalid_request', { status: 400 });
      }

      const now = Date.now();
      const windowStart = Math.floor(now / windowMs) * windowMs;
      const resetAtMs = windowStart + windowMs;
      const storageKey = `rl:${key}:${windowStart}`;

      const existing = (await this.state.storage.get<number>(storageKey)) ?? 0;
      const nextCount = existing + 1;

      // Durable Object storage put options vary by runtime; keep it simple and
      // rely on daily cleanup alarm to avoid unbounded growth.
      await this.state.storage.put(storageKey, nextCount);

      const allowed = nextCount <= limit;
      const remaining = Math.max(0, limit - nextCount);

      return Response.json(
        {
          ok: true,
          allowed,
          count: nextCount,
          limit,
          remaining,
          reset_at_ms: resetAtMs,
        },
        { status: allowed ? 200 : 429 },
      );
    }

    // POST /email-index { email, workspace_id } - manually register email index
    if (parts[0] === 'email-index' && parts.length === 1 && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as { email?: string; workspace_id?: string } | null;
      if (!body?.email || !body?.workspace_id) {
        return new Response('invalid_request', { status: 400 });
      }
      await this.state.storage.put(`emailidx:${body.email.toLowerCase()}`, body.workspace_id);
      return Response.json({ ok: true }, { status: 200 });
    }

    if (parts.length < 2 && parts[0] !== 'agents') return new Response('not_found', { status: 404 });

    // POST /keys/lookup { api_key_hash } - Find workspace by API key hash
    if (parts[0] === 'keys' && parts[1] === 'lookup' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as { api_key_hash?: string } | null;
      const h = normalizeKeyHash(body?.api_key_hash || '');
      if (!h) return new Response('invalid_request', { status: 400 });

      const workspaceId = await this.state.storage.get<string>(`keyidx:${h}`);
      if (!workspaceId) {
        return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
      }

      return Response.json({ ok: true, workspace_id: workspaceId }, { status: 200 });
    }

    // POST /keys/index { api_key_hash, workspace_id } — add/update keyidx entry
    if (parts[0] === 'keys' && parts[1] === 'index' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as { api_key_hash?: string; workspace_id?: string } | null;
      const h = normalizeKeyHash(body?.api_key_hash || '');
      if (!h || !body?.workspace_id) return new Response('invalid_request', { status: 400 });
      await this.state.storage.put(`keyidx:${h}`, body.workspace_id);
      return Response.json({ ok: true }, { status: 200 });
    }

    // POST /email-index/lookup { email } — look up workspace_id by email
    if (parts[0] === 'email-index' && parts[1] === 'lookup' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as { email?: string } | null;
      if (!body?.email) return new Response('invalid_request', { status: 400 });
      const workspaceId = await this.state.storage.get<string>(`emailidx:${body.email.toLowerCase()}`);
      if (!workspaceId) {
        return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
      }
      return Response.json({ ok: true, workspace_id: workspaceId }, { status: 200 });
    }

    if (parts[0] === 'quotes') {
      const quoteId = parts[1]!;

      if (request.method === 'PUT' && parts.length === 2) {
        const body = (await request.json().catch(() => null)) as PutQuoteBody | null;
        if (!body?.record || body.record.quoteId !== quoteId) {
          return new Response('invalid_request', { status: 400 });
        }

        await this.state.storage.put(`quote:${quoteId}`, body.record);
        return new Response('ok', { status: 200 });
      }

      if (request.method === 'GET' && parts.length === 2) {
        const record = await this.getQuote(quoteId);
        if (!record) return new Response('not_found', { status: 404 });
        return Response.json({ record }, { status: 200 });
      }

      if (request.method === 'POST' && parts.length === 3 && parts[2] === 'redeem') {
        const body = (await request.json().catch(() => null)) as RedeemBody | null;
        const txHash = normalizeHex0x(body?.tx_hash || '');
        if (!txHash) return new Response('invalid_request', { status: 400 });

        const record = await this.getQuote(quoteId);
        if (!record) return new Response('not_found', { status: 404 });
        if (record.redeemedAtMs) return new Response('already_redeemed', { status: 409 });

        const existingTx = (await this.state.storage.get<string>(`tx:${txHash}`)) ?? '';
        if (existingTx) return new Response('tx_already_used', { status: 409 });

        // Mark quote redeemed + credit workspace.
        record.redeemedAtMs = Date.now();
        record.txHash = txHash;
        await this.state.storage.put(`quote:${quoteId}`, record);
        await this.state.storage.put(`tx:${txHash}`, quoteId);

        const resolved = await this.resolveBalance(record.workspaceId);
        const bal: WorkspaceBalance = resolved.ok
          ? resolved.balance
          : {
              workspaceId: record.workspaceId,
              credits: 0,
              updatedAtMs: Date.now(),
            };
        bal.credits = Math.max(0, bal.credits) + record.credits;
        await this.putBalance(bal);

        return Response.json({ ok: true, workspace_id: record.workspaceId, credits: bal.credits }, { status: 200 });
      }

      return new Response('method_not_allowed', { status: 405 });
    }

    // POST /workspaces/create - Create new workspace (for subscription flow)
    if (parts[0] === 'workspaces' && parts[1] === 'create' && request.method === 'POST') {
      type PlanFeatures = {
        projects: number;
        logRetentionDays: number;
        customPolicies: number;
        webhooks: boolean;
        alerts: boolean;
        analytics: boolean;
        sso: boolean;
        auditLogs: boolean;
      };
      
      type CreateWorkspaceBody = {
        workspace_id: string;
        api_key_hash: string;
        plan: string;
        credits: number;
        expires_at_ms: number;
        features?: PlanFeatures;
        mode?: 'enforce' | 'log_only';
        email?: string;
      };
      
      const body = (await request.json().catch(() => null)) as CreateWorkspaceBody | null;
      if (
        !body?.workspace_id ||
        !body?.api_key_hash ||
        typeof body.credits !== 'number' ||
        body.credits < 0
      ) {
        return new Response('invalid_request', { status: 400 });
      }

      // Check if workspace already exists
      const existingAuth = await this.getAuth(body.workspace_id);
      if (existingAuth) {
        return Response.json({ ok: false, error: 'workspace_exists' }, { status: 409 });
      }

      // Check if email already has a free workspace (dedup)
      if (body.email) {
        const existingWsId = await this.state.storage.get<string>(`emailidx:${body.email.toLowerCase()}`);
        if (existingWsId) {
          return Response.json({ ok: false, error: 'email_exists' }, { status: 409 });
        }
      }

      // Create workspace with credits
      const bal: WorkspaceBalance = {
        workspaceId: body.workspace_id,
        credits: body.credits,
        updatedAtMs: Date.now(),
      };
      await this.putBalance(bal);

      // Set API key
      await this.setAuth(body.workspace_id, body.api_key_hash);

      // Store API key hash -> workspace ID index for lookups
      await this.state.storage.put(`keyidx:${body.api_key_hash}`, body.workspace_id);

      // Store email -> workspace ID index for dedup
      if (body.email) {
        await this.state.storage.put(`emailidx:${body.email.toLowerCase()}`, body.workspace_id);
      }

      // Store subscription metadata with features
      await this.state.storage.put(`sub:${body.workspace_id}`, {
        plan: body.plan,
        credits: body.credits,
        expiresAtMs: body.expires_at_ms,
        createdAtMs: Date.now(),
        features: body.features || null,
        mode: body.mode || 'enforce',
        email: body.email || null,
      });

      return Response.json({
        ok: true,
        workspace_id: body.workspace_id,
        credits: body.credits,
      }, { status: 200 });
    }

    if (parts[0] === 'workspaces') {
      const workspaceId = parts[1]!;

      if (request.method === 'GET' && parts.length === 2) {
        const reconciled = await this.reconcileBilling(workspaceId);
        if (!reconciled.ok) {
          const resolved = await this.resolveBalance(workspaceId);
          if (!resolved.ok) {
            return Response.json(
              { ok: false, error: resolved.error, workspace_id: workspaceId, credits: 0 },
              { status: 404 },
            );
          }
          return Response.json(
            { workspace_id: workspaceId, credits: resolved.balance.credits },
            { status: 200 },
          );
        }
        return Response.json(
          {
            workspace_id: workspaceId,
            credits: reconciled.effective.credits_remaining,
          },
          { status: 200 },
        );
      }

      if (request.method === 'GET' && parts.length === 3 && parts[2] === 'billing-effective') {
        const reconciled = await this.reconcileBilling(workspaceId);
        if (!reconciled.ok) {
          return Response.json(
            { ok: false, error: reconciled.error },
            { status: reconciled.error === 'billing_not_initialized' ? 404 : 404 },
          );
        }
        return Response.json(
          {
            ok: true,
            workspace_id: workspaceId,
            ...reconciled.effective,
            free_grant_applied: reconciled.free_grant_applied,
          },
          { status: 200 },
        );
      }

      if (request.method === 'GET' && parts.length === 3 && parts[2] === 'auth') {
        const auth = await this.getAuth(workspaceId);
        if (!auth) return new Response('not_found', { status: 404 });
        return Response.json(
          {
            workspace_id: workspaceId,
            has_key: true,
            created_at: new Date(auth.createdAtMs).toISOString(),
            updated_at: new Date(auth.updatedAtMs).toISOString(),
          },
          { status: 200 },
        );
      }

      if (request.method === 'POST' && parts.length === 3 && parts[2] === 'consume') {
        const body = (await request.json().catch(() => null)) as ConsumeBody | null;
        const n = Number(body?.n);
        if (!Number.isFinite(n) || n <= 0) return new Response('invalid_request', { status: 400 });

        // Check budget limits first
        const budgetCheck = await this.checkBudgetLimits(workspaceId, n);
        if (!budgetCheck.ok) {
          return Response.json({
            ok: false,
            error: budgetCheck.error,
            limit_type: budgetCheck.limit,
            current_usage: budgetCheck.usage,
          }, { status: 402 });
        }

        const reconciled = await this.reconcileBilling(workspaceId);
        const resolved = await this.resolveBalance(workspaceId);
        if (!resolved.ok) {
          return Response.json(
            { ok: false, error: resolved.error, credits: 0 },
            { status: resolved.error === 'billing_not_initialized' ? 404 : 402 },
          );
        }
        const bal = resolved.balance;
        if (bal.credits < n) {
          return Response.json({ ok: false, error: 'insufficient_credits', credits: bal.credits }, { status: 402 });
        }

        bal.credits -= n;
        await this.putBalance(bal);
        
        // Record usage
        await this.recordUsage(workspaceId, n, body?.action, body?.tool);

        // Check if credits are low (below 20% of max) — use effective plan allowance
        const maxCredits =
          reconciled.ok && reconciled.effective.included_checks > 0
            ? reconciled.effective.included_checks
            : (await this.state.storage.get<{ credits?: number }>(`sub:${workspaceId}`))?.credits ?? 25000;
        const sub = await this.state.storage.get<{ features?: { logRetentionDays?: number } }>(
          `sub:${workspaceId}`,
        );
        const creditsLowThreshold = 0.2; // 20%
        const isCreditsLow = bal.credits < (maxCredits * creditsLowThreshold);

        // Check if we should send credits_low webhook (only first time crossing threshold)
        let shouldNotifyCreditsLow = false;
        if (isCreditsLow) {
          const notifiedKey = `credits_low_notified:${workspaceId}`;
          const alreadyNotified = await this.state.storage.get<boolean>(notifiedKey);
          if (!alreadyNotified) {
            await this.state.storage.put(notifiedKey, true);
            shouldNotifyCreditsLow = true;
          }
        } else {
          // Reset notification flag when credits go above threshold (after renewal)
          await this.state.storage.delete(`credits_low_notified:${workspaceId}`);
        }

        // Probabilistic log cleanup (1% chance per consume call)
        if (Math.random() < 0.01) {
          const retentionDays = sub?.features?.logRetentionDays ?? 30;
          this.cleanupOldUsageLogs(workspaceId, retentionDays).catch(() => {}); // fire-and-forget
        }

        return Response.json({ 
          ok: true, 
          credits: bal.credits,
          credits_low: isCreditsLow,
          credits_low_notify: shouldNotifyCreditsLow, // true = first time, should send webhook
          credits_low_threshold: isCreditsLow ? creditsLowThreshold : undefined,
          max_credits: isCreditsLow ? maxCredits : undefined,
        }, { status: 200 });
      }

      if (request.method === 'PUT' && parts.length === 3 && parts[2] === 'key') {
        const body = (await request.json().catch(() => null)) as SetKeyBody | null;
        const h = normalizeKeyHash(body?.api_key_hash || '');
        if (!h) return new Response('invalid_request', { status: 400 });

        // Remove old keyidx entry before updating auth
        const oldAuth = await this.getAuth(workspaceId);
        if (oldAuth?.apiKeyHash && oldAuth.apiKeyHash !== h) {
          await this.state.storage.delete(`keyidx:${oldAuth.apiKeyHash}`);
        }

        await this.setAuth(workspaceId, h);
        return new Response('ok', { status: 200 });
      }

      if (request.method === 'DELETE' && parts.length === 3 && parts[2] === 'key') {
        await this.deleteAuth(workspaceId);
        return new Response('ok', { status: 200 });
      }

      if (request.method === 'POST' && parts.length === 3 && parts[2] === 'verify') {
        const body = (await request.json().catch(() => null)) as VerifyKeyBody | null;
        const h = normalizeKeyHash(body?.api_key_hash || '');
        if (!h) return new Response('invalid_request', { status: 400 });

        const auth = await this.getAuth(workspaceId);
        if (!auth) return new Response('not_found', { status: 404 });

        if (auth.apiKeyHash !== h) {
          return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
        }

        return Response.json({ ok: true }, { status: 200 });
      }

      // Budget management
      if (request.method === 'GET' && parts.length === 3 && parts[2] === 'budget') {
        const budget = await this.getBudget(workspaceId);
        if (!budget) {
          return Response.json({ 
            workspace_id: workspaceId, 
            has_budget: false,
            message: 'No budget configured'
          }, { status: 200 });
        }
        return Response.json({
          workspace_id: workspaceId,
          has_budget: true,
          daily_limit: budget.dailyLimit,
          weekly_limit: budget.weeklyLimit,
          monthly_limit: budget.monthlyLimit,
          alert_threshold: budget.alertThreshold,
          webhook_url: budget.webhookUrl ? '***configured***' : undefined,
          created_at: new Date(budget.createdAtMs).toISOString(),
          updated_at: new Date(budget.updatedAtMs).toISOString(),
        }, { status: 200 });
      }

      if (request.method === 'PUT' && parts.length === 3 && parts[2] === 'budget') {
        const body = (await request.json().catch(() => null)) as SetBudgetBody | null;
        if (!body) return new Response('invalid_request', { status: 400 });

        const budget = await this.setBudget(workspaceId, body);
        return Response.json({
          workspace_id: workspaceId,
          daily_limit: budget.dailyLimit,
          weekly_limit: budget.weeklyLimit,
          monthly_limit: budget.monthlyLimit,
          alert_threshold: budget.alertThreshold,
          updated_at: new Date(budget.updatedAtMs).toISOString(),
        }, { status: 200 });
      }

      if (request.method === 'DELETE' && parts.length === 3 && parts[2] === 'budget') {
        await this.state.storage.delete(`budget:${workspaceId}`);
        return Response.json({ ok: true }, { status: 200 });
      }

      // Usage reporting
      if (request.method === 'GET' && parts.length === 3 && parts[2] === 'usage') {
        const period = new URL(request.url).searchParams.get('period') || 'today';
        
        let days: number;
        switch (period) {
          case 'today': days = 1; break;
          case 'week': days = 7; break;
          case 'month': days = 30; break;
          case 'all': days = 365; break;
          default: days = 1;
        }

        const today = new Date();
        const usageByDay: Array<{ date: string; credits: number; actions: Record<string, number>; tools: Record<string, number> }> = [];
        let totalCredits = 0;
        const totalActions: Record<string, number> = {};
        const totalTools: Record<string, number> = {};

        for (let i = 0; i < days; i++) {
          const date = new Date(today);
          date.setDate(date.getDate() - i);
          const dateKey = date.toISOString().split('T')[0]!;
          const usage = await this.getUsage(workspaceId, dateKey);
          
          usageByDay.push({
            date: dateKey,
            credits: usage.credits,
            actions: usage.actions,
            tools: usage.tools,
          });

          totalCredits += usage.credits;
          for (const [action, count] of Object.entries(usage.actions)) {
            totalActions[action] = (totalActions[action] ?? 0) + count;
          }
          for (const [tool, count] of Object.entries(usage.tools)) {
            totalTools[tool] = (totalTools[tool] ?? 0) + count;
          }
        }

        return Response.json({
          workspace_id: workspaceId,
          period,
          start_date: usageByDay[usageByDay.length - 1]?.date,
          end_date: usageByDay[0]?.date,
          total_credits_used: totalCredits,
          total_cost_usd: totalCredits * 0.00001, // 1 credit = $0.00001
          breakdown: {
            by_action: totalActions,
            by_tool: totalTools,
            by_day: usageByDay.reverse(),
          },
        }, { status: 200 });
      }

      // Governance mode — GET/PUT /workspaces/:id/mode
      if (parts.length === 3 && parts[2] === 'mode') {
        if (request.method === 'GET') {
          const sub = await this.state.storage.get<{ mode?: string }>(`sub:${workspaceId}`);
          return Response.json({
            ok: true,
            workspace_id: workspaceId,
            mode: (sub?.mode === 'log_only') ? 'log_only' : 'enforce',
          }, { status: 200 });
        }
        if (request.method === 'PUT') {
          const body = (await request.json().catch(() => null)) as { mode?: string } | null;
          if (!body?.mode || !['enforce', 'log_only'].includes(body.mode)) {
            return new Response('invalid_mode', { status: 400 });
          }
          const sub = await this.state.storage.get<Record<string, unknown>>(`sub:${workspaceId}`);
          if (!sub) return new Response('not_found', { status: 404 });
          sub.mode = body.mode;
          await this.state.storage.put(`sub:${workspaceId}`, sub);
          return Response.json({ ok: true, mode: body.mode }, { status: 200 });
        }
        return new Response('method_not_allowed', { status: 405 });
      }

      // Workspace email — GET/PUT /workspaces/:id/email
      if (parts.length === 3 && parts[2] === 'email') {
        if (request.method === 'GET') {
          const sub = await this.state.storage.get<{ email?: string | null }>(`sub:${workspaceId}`);
          return Response.json({
            ok: true,
            workspace_id: workspaceId,
            email: sub?.email || null,
          }, { status: 200 });
        }
        if (request.method === 'PUT') {
          const body = (await request.json().catch(() => null)) as { email?: string } | null;
          if (!body?.email) return new Response('invalid_request', { status: 400 });
          const sub = await this.state.storage.get<Record<string, unknown>>(`sub:${workspaceId}`);
          if (!sub) return new Response('not_found', { status: 404 });
          sub.email = body.email;
          await this.state.storage.put(`sub:${workspaceId}`, sub);
          return Response.json({ ok: true }, { status: 200 });
        }
        return new Response('method_not_allowed', { status: 405 });
      }

      // Badge data — GET /workspaces/:id/badge-data (lightweight, for SVG badge)
      if (request.method === 'GET' && parts.length === 3 && parts[2] === 'badge-data') {
        const blockedStats = await this.state.storage.get<BlockedStats>(`blocked:${workspaceId}`);
        const sub = await this.state.storage.get<{ plan?: string }>(`sub:${workspaceId}`);
        return Response.json({
          ok: true,
          cost_saved_usd: blockedStats?.estimatedCostSavedUsd ?? 0,
          storms_blocked: blockedStats?.blockedRequests ?? 0,
          active: !!sub,
        }, { status: 200 });
      }

      // Subscription metadata
      if (request.method === 'GET' && parts.length === 3 && parts[2] === 'subscription') {
        const sub = await this.state.storage.get<{
          plan: string;
          credits: number;
          expiresAtMs: number;
          createdAtMs: number;
        }>(`sub:${workspaceId}`);
        
        if (!sub) {
          return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
        }

        return Response.json({
          ok: true,
          workspace_id: workspaceId,
          plan: sub.plan,
          credits: sub.credits,
          expiresAtMs: sub.expiresAtMs,
          createdAtMs: sub.createdAtMs,
          expires_at: new Date(sub.expiresAtMs).toISOString(),
          created_at: new Date(sub.createdAtMs).toISOString(),
        }, { status: 200 });
      }

      // Add credits (for renewals)
      if (request.method === 'POST' && parts.length === 3 && parts[2] === 'add-credits') {
        const body = (await request.json().catch(() => null)) as {
          credits?: number;
          plan?: string;
          months?: number;
        } | null;

        if (!body?.credits || body.credits <= 0) {
          return new Response('invalid_request', { status: 400 });
        }

        // Add credits to balance
        const bal = await this.getBalance(workspaceId);
        bal.credits += body.credits;
        await this.putBalance(bal);

        // Update subscription metadata
        const existingSub = await this.state.storage.get<{
          plan: string;
          credits: number;
          expiresAtMs: number;
          createdAtMs: number;
        }>(`sub:${workspaceId}`);

        const nowMs = Date.now();
        const monthsMs = (body.months || 1) * 30 * 24 * 60 * 60 * 1000;
        
        // Extend from current expiry or from now if expired
        const baseExpiryMs = (existingSub?.expiresAtMs && existingSub.expiresAtMs > nowMs) 
          ? existingSub.expiresAtMs 
          : nowMs;
        const newExpiryMs = baseExpiryMs + monthsMs;

        await this.state.storage.put(`sub:${workspaceId}`, {
          plan: body.plan || existingSub?.plan || 'starter',
          credits: bal.credits,
          expiresAtMs: newExpiryMs,
          createdAtMs: existingSub?.createdAtMs || nowMs,
        });

        return Response.json({
          ok: true,
          workspace_id: workspaceId,
          credits: bal.credits,
          expires_at: new Date(newExpiryMs).toISOString(),
        }, { status: 200 });
      }

      // Webhook configuration
      if (request.method === 'PUT' && parts.length === 3 && parts[2] === 'webhook') {
        const body = (await request.json().catch(() => null)) as {
          webhook_url?: string;
          webhook_secret?: string;
          events?: string[];
        } | null;

        const nowMs = Date.now();
        await this.state.storage.put(`webhook:${workspaceId}`, {
          webhookUrl: body?.webhook_url || null,
          webhookSecret: body?.webhook_secret || null,
          events: body?.events || [],
          updatedAtMs: nowMs,
        });

        return Response.json({ ok: true }, { status: 200 });
      }

      if (request.method === 'GET' && parts.length === 3 && parts[2] === 'webhook') {
        // First check dedicated webhook config
        const config = await this.state.storage.get<{
          webhookUrl?: string;
          webhookSecret?: string;
          events?: string[];
        }>(`webhook:${workspaceId}`);

        if (config?.webhookUrl) {
          return Response.json({
            ok: true,
            webhook_url: config.webhookUrl,
            webhook_secret: config.webhookSecret,
            events: config.events || [],
          }, { status: 200 });
        }

        // Fallback to budget config for webhook_url
        const budget = await this.getBudget(workspaceId);
        if (budget?.webhookUrl) {
          return Response.json({
            ok: true,
            webhook_url: budget.webhookUrl,
            events: [],
          }, { status: 200 });
        }

        return Response.json({ ok: false, error: 'not_configured' }, { status: 404 });
      }

      // ======================================================================
      // Stats - Including cost saved metric
      // ======================================================================
      if (request.method === 'GET' && parts.length === 3 && parts[2] === 'stats') {
        const stats = await this.state.storage.get<BlockedStats>(`blocked:${workspaceId}`);
        const resolved = await this.resolveBalance(workspaceId);
        const balCredits = resolved.ok ? resolved.balance.credits : 0;
        const sub = await this.state.storage.get<{ credits?: number }>(`sub:${workspaceId}`);
        const maxCredits = sub?.credits ?? 25000;
        
        // Get usage for current month
        const monthUsage = await this.getUsageForPeriod(workspaceId, 30);
        
        return Response.json({
          ok: true,
          workspace_id: workspaceId,
          credits_remaining: balCredits,
          credits_used_this_month: monthUsage,
          max_credits: maxCredits,
          blocked_requests: stats?.blockedRequests ?? 0,
          cost_saved_usd: stats?.estimatedCostSavedUsd ?? 0,
          blocked_by_reason: stats?.blockedByReason ?? {},
          last_blocked_at: stats?.lastBlockedAtMs ? new Date(stats.lastBlockedAtMs).toISOString() : null,
        }, { status: 200 });
      }

      // Record a blocked request (for cost_saved tracking)
      // ======================================================================
      if (request.method === 'POST' && parts.length === 3 && parts[2] === 'block') {
        const body = await request.json().catch(() => null) as { 
          reason?: string; 
          estimated_cost_usd?: number;
          action?: string;
        } | null;
        
        const reason = body?.reason || 'unknown';
        const estimatedCost = body?.estimated_cost_usd ?? 0.01; // Default $0.01 per blocked request
        
        const existing = await this.state.storage.get<BlockedStats>(`blocked:${workspaceId}`) || {
          workspaceId,
          blockedRequests: 0,
          estimatedCostSavedUsd: 0,
          blockedByReason: {},
          updatedAtMs: Date.now(),
        };
        
        existing.blockedRequests += 1;
        existing.estimatedCostSavedUsd += estimatedCost;
        existing.blockedByReason[reason] = (existing.blockedByReason[reason] ?? 0) + 1;
        existing.lastBlockedAtMs = Date.now();
        existing.updatedAtMs = Date.now();
        
        await this.state.storage.put(`blocked:${workspaceId}`, existing);
        
        return Response.json({ 
          ok: true, 
          blocked_requests: existing.blockedRequests,
          cost_saved_usd: existing.estimatedCostSavedUsd,
        }, { status: 200 });
      }

      // Loop detection - check if action pattern is repeating too fast
      // ======================================================================
      // Enhanced with: similarity grouping, cost accumulation, backoff detection
      if (request.method === 'POST' && parts.length === 3 && parts[2] === 'check-loop') {
        const body = await request.json().catch(() => null) as { 
          pattern_hash: string; // Hash of action + task context
          window_ms?: number; // Time window (default 60s)
          max_count?: number; // Max allowed in window (default 10)
          cost_usd?: number; // Cost of this request in USD (optional)
          similarity_prefix?: string; // First N chars of hash — groups similar requests
          action?: string; // Action name for behavioral fingerprinting
          depth?: number;  // Call depth for behavioral fingerprinting
        } | null;
        
        if (!body?.pattern_hash) {
          return new Response('invalid_request', { status: 400 });
        }
        
        const windowMs = body.window_ms ?? 60000; // 60 seconds default
        const maxCount = body.max_count ?? 10; // 10 requests per minute default
        const costUsd = body.cost_usd ?? 0;
        const nowMs = Date.now();
        
        // ── Exact pattern tracking ────────────────────────────────────────
        const key = `loop:${workspaceId}:${body.pattern_hash}`;
        const existing = await this.state.storage.get<LoopPattern>(key);
        
        // If pattern is old, reset it
        if (existing && (nowMs - existing.lastSeenMs > windowMs)) {
          await this.state.storage.delete(key);
          const fresh: LoopPattern = {
            hash: body.pattern_hash,
            count: 1,
            firstSeenMs: nowMs,
            lastSeenMs: nowMs,
            timestamps: [nowMs],
            costUsd,
          };
          await this.state.storage.put(key, fresh);

          // Track similarity group (fire and forget)
          const simCount = await this.trackSimilarityGroup(workspaceId, body.similarity_prefix || body.pattern_hash.slice(0, 8), nowMs, windowMs);

          return Response.json({ ok: true, loop_detected: false, count: 1, zone: 'safe', similar_pattern_count: simCount }, { status: 200 });
        }
        
        if (!existing) {
          const fresh: LoopPattern = {
            hash: body.pattern_hash,
            count: 1,
            firstSeenMs: nowMs,
            lastSeenMs: nowMs,
            timestamps: [nowMs],
            costUsd,
          };
          await this.state.storage.put(key, fresh);

          const simCount = await this.trackSimilarityGroup(workspaceId, body.similarity_prefix || body.pattern_hash.slice(0, 8), nowMs, windowMs);

          return Response.json({ ok: true, loop_detected: false, count: 1, zone: 'safe', similar_pattern_count: simCount }, { status: 200 });
        }
        
        // ── Increment count, track timestamp (keep last 20), accumulate cost ──
        existing.count += 1;
        existing.lastSeenMs = nowMs;
        existing.timestamps = [...(existing.timestamps || []), nowMs].slice(-20);
        existing.costUsd = (existing.costUsd || 0) + costUsd;
        await this.state.storage.put(key, existing);
        
        // ── Timing analysis ───────────────────────────────────────────────
        const intervals: number[] = [];
        const ts = existing.timestamps;
        for (let i = 1; i < ts.length; i++) intervals.push(ts[i] - ts[i - 1]);
        const avgIntervalMs = intervals.length > 0 ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;
        const intervalVariance = intervals.length > 1
          ? intervals.reduce((sum, v) => sum + Math.pow(v - avgIntervalMs, 2), 0) / intervals.length
          : 0;
        // Coefficient of variation: low = mechanical (bot), high = irregular (human-like)
        const intervalCv = avgIntervalMs > 0 ? Math.sqrt(intervalVariance) / avgIntervalMs : 0;
        // Requests per second in the window
        const windowSec = (existing.lastSeenMs - existing.firstSeenMs) / 1000 || 1;
        const requestsPerSec = existing.count / windowSec;

        // ── Backoff detection ─────────────────────────────────────────────
        // If intervals are increasing → agent is backing off (good behavior)
        // If intervals are constant/decreasing → storm pattern (bad behavior)
        const backoffDetected = this.detectBackoff(intervals);

        // ── Similarity group count ────────────────────────────────────────
        const simCount = await this.trackSimilarityGroup(workspaceId, body.similarity_prefix || body.pattern_hash.slice(0, 8), nowMs, windowMs);

        // ── Adaptive baseline (EWMA + z-score + CUSUM) ────────────────────
        // Load or create per-pattern baseline state
        const baselineKey = `baseline:${workspaceId}:${body.pattern_hash}`;
        const rawBaseline = await this.state.storage.get<string>(baselineKey);
        const baseline: AgentBaseline = rawBaseline
          ? deserializeBaseline(rawBaseline)
          : createBaseline(nowMs);

        // Compute current RPM from observed data
        const currentRpm = requestsPerSec * 60;

        // Feed observation and get adaptive zone classification
        const adaptiveZone = updateAndClassify(baseline, { rpm: currentRpm }, nowMs);

        // Persist updated baseline state (fire-and-forget for speed)
        this.state.storage.put(baselineKey, serializeBaseline(baseline)).catch(() => {});

        // ── Behavioral fingerprint (streaming update) ─────────────────────
        let fingerprint: BehaviorFingerprint | null = null;
        if (body.action) {
          const fpKey = `fp:${workspaceId}`;
          const rawFp = await this.state.storage.get<string>(fpKey);
          const fpState = rawFp ? deserializeFingerprintState(rawFp) : createFingerprintState();
          fingerprint = await updateFingerprint(fpState, {
            action: body.action,
            intervalMs: avgIntervalMs,
            depth: body.depth ?? 0,
            timestamp: nowMs,
          });
          // Persist fingerprint state (fire-and-forget)
          this.state.storage.put(fpKey, serializeFingerprintState(fpState)).catch(() => {});
        }

        // Use adaptive zone, but still respect backoff leniency:
        // If backoff detected AND adaptive says storm, downgrade to gray
        const zone = (backoffDetected && adaptiveZone === 'storm') ? 'gray' : adaptiveZone;
        
        // Storm zone = loop detected (hard block)
        const loopDetected = zone === 'storm';
        
        if (loopDetected) {
          // Track as blocked for cost_saved metric
          const blocked = await this.state.storage.get<BlockedStats>(`blocked:${workspaceId}`) || {
            workspaceId,
            blockedRequests: 0,
            estimatedCostSavedUsd: 0,
            blockedByReason: {},
            updatedAtMs: nowMs,
          };
          blocked.blockedRequests += 1;
          blocked.estimatedCostSavedUsd += Math.max(0.05, costUsd);
          blocked.blockedByReason['loop_detected'] = (blocked.blockedByReason['loop_detected'] ?? 0) + 1;
          blocked.lastBlockedAtMs = nowMs;
          blocked.updatedAtMs = nowMs;
          await this.state.storage.put(`blocked:${workspaceId}`, blocked);

          // Emit storm.detected webhook if configured
          const webhookData = await this.state.storage.get<{
            webhookUrl?: string | null;
            webhookSecret?: string | null;
          }>(`webhook:${workspaceId}`);
          if (webhookData?.webhookUrl) {
            const { webhookStormDetected } = await import('./services/webhook.js');
            webhookStormDetected(this.env as unknown as import('./types.js').Env, {
              webhookUrl: webhookData.webhookUrl,
              webhookSecret: webhookData.webhookSecret ?? undefined,
              workspaceId,
              requestHash: body.pattern_hash,
              blockCount: blocked.blockedRequests,
              totalBlockedMs: Math.round(existing.lastSeenMs - existing.firstSeenMs),
              estimatedCostSavedUsd: blocked.estimatedCostSavedUsd,
              fingerprint: fingerprint ? {
                burst_index: fingerprint.burstIndex,
                entropy: fingerprint.entropyProfile,
                fanout_ratio: fingerprint.fanoutRatio,
              } : undefined,
            }).catch(err => console.error('Storm webhook failed:', err));
          }
        }
        
        return Response.json({ 
          ok: true, 
          loop_detected: loopDetected,
          count: existing.count,
          zone,
          window_ms: windowMs,
          max_count: maxCount,
          timing: {
            avg_interval_ms: Math.round(avgIntervalMs),
            interval_cv: Math.round(intervalCv * 1000) / 1000, // 0 = perfectly regular (bot), >0.5 = irregular
            requests_per_sec: Math.round(requestsPerSec * 100) / 100,
            window_elapsed_ms: existing.lastSeenMs - existing.firstSeenMs,
          },
          // ── New smart signals ──────────────────────────────────────────
          cost_window_usd: Math.round(existing.costUsd * 100) / 100,
          backoff_detected: backoffDetected,
          similar_pattern_count: simCount,
          // ── Behavioral fingerprint ────────────────────────────────────
          ...(fingerprint ? {
            fingerprint_hash: fingerprint.fingerprintHash,
            fingerprint: {
              burst_index: fingerprint.burstIndex,
              entropy: fingerprint.entropyProfile,
              fanout_ratio: fingerprint.fanoutRatio,
              avg_depth: fingerprint.avgDepth,
              retry_distribution: fingerprint.retryDistribution,
            },
          } : {}),
        }, { status: loopDetected ? 429 : 200 });
      }

      // Analytics - Usage over time
      // ======================================================================
      if (request.method === 'GET' && parts.length === 3 && parts[2] === 'analytics') {
        const period = url.searchParams.get('period') || '30d';
        
        // Calculate date range
        const now = new Date();
        let days = 30;
        if (period === '7d') days = 7;
        else if (period === '14d') days = 14;
        else if (period === '90d') days = 90;

        const dailyData: { date: string; credits: number; actions: Record<string, number>; tools: Record<string, number> }[] = [];
        let totalCredits = 0;
        const allActions: Record<string, number> = {};
        const allTools: Record<string, number> = {};

        for (let i = 0; i < days; i++) {
          const date = new Date(now);
          date.setDate(date.getDate() - i);
          const dateKey = date.toISOString().split('T')[0]!;
          
          const usage = await this.state.storage.get<UsageRecord>(`usage:${workspaceId}:${dateKey}`);
          
          const dayData = {
            date: dateKey,
            credits: usage?.credits || 0,
            actions: usage?.actions || {},
            tools: usage?.tools || {},
          };
          
          dailyData.push(dayData);
          totalCredits += dayData.credits;
          
          // Aggregate actions and tools
          for (const [action, count] of Object.entries(dayData.actions)) {
            allActions[action] = (allActions[action] || 0) + count;
          }
          for (const [tool, count] of Object.entries(dayData.tools)) {
            allTools[tool] = (allTools[tool] || 0) + count;
          }
        }

        return Response.json({
          ok: true,
          daily: dailyData.reverse(), // oldest first
          summary: {
            total_credits_used: totalCredits,
            actions_by_type: allActions,
            tools_by_name: allTools,
            avg_daily_credits: Math.round(totalCredits / days),
          },
        }, { status: 200 });
      }

      // Decision logging — store each governance decision for real dashboard
      // ======================================================================
      if (request.method === 'POST' && parts.length === 3 && parts[2] === 'log-decision') {
        const body = await request.json().catch(() => null) as DemoDecisionEntry | null;
        if (!body?.id) return new Response('invalid_request', { status: 400 });

        const nowMs = Date.now();
        const key = `dlog:${workspaceId}:${String(nowMs).padStart(15, '0')}:${body.id.slice(0, 6)}`;
        await this.state.storage.put(key, body);

        // Also increment per-minute counter for storm chart
        const minuteKey = `dmin:${workspaceId}:${Math.floor(nowMs / 60000)}`;
        const minData = await this.state.storage.get<{ total: number; blocked: number }>(minuteKey) || { total: 0, blocked: 0 };
        minData.total += 1;
        if (body.decision === 'blocked_storm' || body.decision === 'blocked_credits') {
          minData.blocked += 1;
        }
        await this.state.storage.put(minuteKey, minData);

        // Also increment total decision counter
        const counterKey = `dcnt:${workspaceId}`;
        const counter = await this.state.storage.get<number>(counterKey) || 0;
        await this.state.storage.put(counterKey, counter + 1);

        // Prune: keep only last 200 decision log entries
        const allKeys = await this.state.storage.list({ prefix: `dlog:${workspaceId}:` });
        if (allKeys.size > 200) {
          const sorted = [...allKeys.keys()].sort();
          const deleteKeys = sorted.slice(0, sorted.length - 200);
          for (const dk of deleteKeys) {
            await this.state.storage.delete(dk);
          }
        }

        return Response.json({ ok: true });
      }

      // Decision log — return recent governance decisions
      // ======================================================================
      if (request.method === 'GET' && parts.length === 3 && parts[2] === 'decision-log') {
        const limit = Math.min(Number(url.searchParams.get('limit') || '50'), 200);
        const allEntries = await this.state.storage.list<DemoDecisionEntry>({ prefix: `dlog:${workspaceId}:`, reverse: true, limit });
        const decisions = [...allEntries.values()];
        const totalCount = await this.state.storage.get<number>(`dcnt:${workspaceId}`) || decisions.length;

        return Response.json({ ok: true, decisions, total_count: totalCount });
      }

      // Storm chart — per-minute request counts for last 60 minutes
      // ======================================================================
      if (request.method === 'GET' && parts.length === 3 && parts[2] === 'storm-chart') {
        const nowMinute = Math.floor(Date.now() / 60000);
        const buckets: { minutes_ago: number; total: number; blocked: number }[] = [];
        for (let i = 59; i >= 0; i--) {
          const minuteKey = `dmin:${workspaceId}:${nowMinute - i}`;
          const data = await this.state.storage.get<{ total: number; blocked: number }>(minuteKey) || { total: 0, blocked: 0 };
          buckets.push({ minutes_ago: i, total: data.total, blocked: data.blocked });
        }
        return Response.json({ ok: true, buckets });
      }

      return new Response('method_not_allowed', { status: 405 });
    }

    // ========================================================================
    // Projects CRUD
    // ========================================================================
    if (parts[0] === 'workspaces' && parts.length >= 3 && parts[2] === 'projects') {
      const workspaceId = parts[1]!;
      const projectId = parts[3];

      // GET /workspaces/:id/projects - List projects
      if (request.method === 'GET' && !projectId) {
        const projectIds = await this.state.storage.get<string[]>(`projects:${workspaceId}`) || [];
        const projects: { id: string; name: string; description?: string; createdAt: string }[] = [];
        
        for (const id of projectIds) {
          const project = await this.state.storage.get<{ id: string; name: string; description?: string; createdAtMs: number }>(`project:${workspaceId}:${id}`);
          if (project) {
            projects.push({
              id: project.id,
              name: project.name,
              description: project.description,
              createdAt: new Date(project.createdAtMs).toISOString(),
            });
          }
        }
        
        return Response.json({ ok: true, projects, count: projects.length }, { status: 200 });
      }

      // POST /workspaces/:id/projects - Create project
      if (request.method === 'POST' && !projectId) {
        const body = await request.json().catch(() => null) as { name?: string; description?: string } | null;
        if (!body?.name) {
          return Response.json({ ok: false, error: 'name_required' }, { status: 400 });
        }

        const id = `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        const project = {
          id,
          name: body.name,
          description: body.description,
          createdAtMs: Date.now(),
        };

        await this.state.storage.put(`project:${workspaceId}:${id}`, project);
        
        const projectIds = await this.state.storage.get<string[]>(`projects:${workspaceId}`) || [];
        projectIds.push(id);
        await this.state.storage.put(`projects:${workspaceId}`, projectIds);

        return Response.json({ 
          ok: true, 
          project: {
            id: project.id,
            name: project.name,
            description: project.description,
            createdAt: new Date(project.createdAtMs).toISOString(),
          },
        }, { status: 201 });
      }

      // DELETE /workspaces/:id/projects/:projectId - Delete project
      if (request.method === 'DELETE' && projectId) {
        const exists = await this.state.storage.get(`project:${workspaceId}:${projectId}`);
        if (!exists) {
          return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
        }

        await this.state.storage.delete(`project:${workspaceId}:${projectId}`);
        
        const projectIds = await this.state.storage.get<string[]>(`projects:${workspaceId}`) || [];
        const filtered = projectIds.filter(id => id !== projectId);
        await this.state.storage.put(`projects:${workspaceId}`, filtered);

        return Response.json({ ok: true }, { status: 200 });
      }

      return new Response('method_not_allowed', { status: 405 });
    }

    // ========================================================================
    // Custom Policies CRUD
    // ========================================================================
    if (parts[0] === 'workspaces' && parts.length >= 3 && parts[2] === 'policies') {
      const workspaceId = parts[1]!;
      const policyId = parts[3];

      // GET /workspaces/:id/policies - List policies
      if (request.method === 'GET' && !policyId) {
        const policyIds = await this.state.storage.get<string[]>(`custpolicies:${workspaceId}`) || [];
        const policies: { 
          id: string; 
          name: string; 
          description?: string;
          rules: unknown;
          createdAt: string;
        }[] = [];
        
        for (const id of policyIds) {
          const policy = await this.state.storage.get<{ 
            id: string; 
            name: string; 
            description?: string;
            rules: unknown;
            createdAtMs: number;
          }>(`custpolicy:${workspaceId}:${id}`);
          if (policy) {
            policies.push({
              id: policy.id,
              name: policy.name,
              description: policy.description,
              rules: policy.rules,
              createdAt: new Date(policy.createdAtMs).toISOString(),
            });
          }
        }
        
        return Response.json({ ok: true, policies, count: policies.length }, { status: 200 });
      }

      // POST /workspaces/:id/policies - Create policy
      if (request.method === 'POST' && !policyId) {
        const body = await request.json().catch(() => null) as { 
          name?: string; 
          description?: string;
          rules?: unknown;
        } | null;
        
        if (!body?.name) {
          return Response.json({ ok: false, error: 'name_required' }, { status: 400 });
        }

        const id = `policy_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        const policy = {
          id,
          name: body.name,
          description: body.description,
          rules: body.rules || {},
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
        };

        await this.state.storage.put(`custpolicy:${workspaceId}:${id}`, policy);
        
        const policyIds = await this.state.storage.get<string[]>(`custpolicies:${workspaceId}`) || [];
        policyIds.push(id);
        await this.state.storage.put(`custpolicies:${workspaceId}`, policyIds);

        return Response.json({ 
          ok: true, 
          policy: {
            id: policy.id,
            name: policy.name,
            description: policy.description,
            rules: policy.rules,
            createdAt: new Date(policy.createdAtMs).toISOString(),
          },
        }, { status: 201 });
      }

      // PUT /workspaces/:id/policies/:policyId - Update policy
      if (request.method === 'PUT' && policyId) {
        const existing = await this.state.storage.get<{ 
          id: string; 
          name: string; 
          description?: string;
          rules: unknown;
          createdAtMs: number;
        }>(`custpolicy:${workspaceId}:${policyId}`);
        
        if (!existing) {
          return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
        }

        const body = await request.json().catch(() => null) as { 
          name?: string; 
          description?: string;
          rules?: unknown;
        } | null;

        const updated = {
          ...existing,
          name: body?.name ?? existing.name,
          description: body?.description ?? existing.description,
          rules: body?.rules ?? existing.rules,
          updatedAtMs: Date.now(),
        };

        await this.state.storage.put(`custpolicy:${workspaceId}:${policyId}`, updated);

        return Response.json({ 
          ok: true, 
          policy: {
            id: updated.id,
            name: updated.name,
            description: updated.description,
            rules: updated.rules,
            createdAt: new Date(updated.createdAtMs).toISOString(),
          },
        }, { status: 200 });
      }

      // DELETE /workspaces/:id/policies/:policyId - Delete policy
      if (request.method === 'DELETE' && policyId) {
        const exists = await this.state.storage.get(`custpolicy:${workspaceId}:${policyId}`);
        if (!exists) {
          return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
        }

        await this.state.storage.delete(`custpolicy:${workspaceId}:${policyId}`);
        
        const policyIds = await this.state.storage.get<string[]>(`custpolicies:${workspaceId}`) || [];
        const filtered = policyIds.filter(id => id !== policyId);
        await this.state.storage.put(`custpolicies:${workspaceId}`, filtered);

        return Response.json({ ok: true }, { status: 200 });
      }

      return new Response('method_not_allowed', { status: 405 });
    }

    // ========================================================================
    // Agent Reputation Scoring
    // ========================================================================
    if (parts[0] === 'workspaces' && parts.length === 3 && parts[2] === 'reputation') {
      const workspaceId = parts[1]!;

      // GET /workspaces/:id/reputation - Get current trust score
      if (request.method === 'GET') {
        const { createReputationState, deserializeReputationState, computeScore } = await import('./lib/reputationScoring.js');
        const raw = await this.state.storage.get<string>(`rep:${workspaceId}`);
        const state = raw ? deserializeReputationState(raw) : createReputationState();
        const score = computeScore(state);

        // Piggyback governance mode onto reputation response (avoids extra DO call)
        const sub = await this.state.storage.get<{ mode?: string }>(`sub:${workspaceId}`);
        const governanceMode = (sub?.mode === 'log_only') ? 'log_only' : 'enforce';

        return Response.json({ ok: true, reputation: score, governance_mode: governanceMode }, { status: 200 });
      }

      // POST /workspaces/:id/reputation - Record an outcome event
      if (request.method === 'POST') {
        const body = await request.json().catch(() => null) as {
          blocked?: boolean;
          reason?: 'storm' | 'gray_blocked' | 'policy' | 'credits';
          backoff_detected?: boolean;
          zone?: 'safe' | 'gray' | 'storm';
          budget_overshoot?: boolean;
        } | null;
        if (!body) return new Response('invalid_request', { status: 400 });

        const {
          createReputationState,
          deserializeReputationState,
          serializeReputationState,
          recordOutcome,
          recordBudgetEvent,
          computeScore,
        } = await import('./lib/reputationScoring.js');

        const raw = await this.state.storage.get<string>(`rep:${workspaceId}`);
        const state = raw ? deserializeReputationState(raw) : createReputationState();

        recordOutcome(state, {
          blocked: body.blocked ?? false,
          reason: body.reason,
          backoff_detected: body.backoff_detected,
          zone: body.zone,
        });

        if (body.budget_overshoot !== undefined) {
          recordBudgetEvent(state, body.budget_overshoot);
        }

        await this.state.storage.put(`rep:${workspaceId}`, serializeReputationState(state));
        const score = computeScore(state);
        return Response.json({ ok: true, reputation: score }, { status: 200 });
      }

      return new Response('method_not_allowed', { status: 405 });
    }

    // ========================================================================
    // Agent Identity & Per-Agent Reputation
    // ========================================================================
    if (parts[0] === 'agents') {
      // GET /agents - List agents sorted by last_seen (paginated, 20/page)
      if (parts.length === 1 && request.method === 'GET') {
        const url = new URL(request.url);
        const cursor = url.searchParams.get('cursor') ?? '';

        const allEntries = await this.state.storage.list<AgentProfile>({ prefix: 'agent:' });
        const profiles: AgentProfile[] = [];
        for (const [k, v] of allEntries) {
          if (k.endsWith(':profile')) profiles.push(v);
        }
        profiles.sort((a, b) => b.last_seen_ms - a.last_seen_ms);

        const PAGE_SIZE = 20;
        const startIdx = cursor ? profiles.findIndex(p => p.agent_id === cursor) + 1 : 0;
        const page = profiles.slice(startIdx, startIdx + PAGE_SIZE);

        const {
          createReputationState,
          deserializeReputationState,
          computeScore,
        } = await import('./lib/reputationScoring.js');

        const agents = await Promise.all(page.map(async (profile) => {
          const raw = await this.state.storage.get<string>(`agent:${profile.agent_id}:rep`);
          const state = raw ? deserializeReputationState(raw) : createReputationState();
          const score = computeScore(state);
          return {
            agent_id: profile.agent_id,
            tier: score.tier,
            score: score.score,
            last_seen_ms: profile.last_seen_ms,
            workspace_count: profile.workspace_ids.length,
          };
        }));

        return Response.json({
          ok: true,
          agents,
          total: profiles.length,
          has_more: startIdx + PAGE_SIZE < profiles.length,
          next_cursor: page.length === PAGE_SIZE ? page[page.length - 1]!.agent_id : null,
        }, { status: 200 });
      }

      if (parts.length === 3 && parts[2] === 'profile') {
        const agentId = parts[1]!;

        // GET /agents/:id/profile
        if (request.method === 'GET') {
          const profile = await this.state.storage.get<AgentProfile>(`agent:${agentId}:profile`);
          if (!profile) return Response.json({ ok: false, error: 'agent_not_found' }, { status: 404 });
          return Response.json({ ok: true, profile }, { status: 200 });
        }

        // POST /agents/:id/profile - upsert (called fire-and-forget from check.ts)
        if (request.method === 'POST') {
          const body = await request.json().catch(() => null) as {
            last_seen_ms?: number;
            workspace_id?: string;
            wallet_address?: string;
          } | null;
          if (!body) return new Response('invalid_request', { status: 400 });

          const existing = await this.state.storage.get<AgentProfile>(`agent:${agentId}:profile`);
          const now = body.last_seen_ms ?? Date.now();

          let workspace_ids: string[] = existing?.workspace_ids ?? [];
          if (body.workspace_id && !workspace_ids.includes(body.workspace_id)) {
            workspace_ids = [body.workspace_id, ...workspace_ids].slice(0, 50);
          }

          const updated: AgentProfile = {
            agent_id: agentId,
            first_seen_ms: existing?.first_seen_ms ?? now,
            last_seen_ms: now,
            total_payments_usdc: existing?.total_payments_usdc ?? 0,
            payment_count: existing?.payment_count ?? 0,
            workspace_ids,
            wallet_address: body.wallet_address ?? existing?.wallet_address,
          };

          await this.state.storage.put(`agent:${agentId}:profile`, updated);
          return Response.json({ ok: true }, { status: 200 });
        }

        return new Response('method_not_allowed', { status: 405 });
      }

      if (parts.length === 3 && parts[2] === 'reputation') {
        const agentId = parts[1]!;

        const {
          createReputationState,
          deserializeReputationState,
          serializeReputationState,
          recordOutcome,
          recordBudgetEvent,
          computeScore,
        } = await import('./lib/reputationScoring.js');

        // GET /agents/:id/reputation
        if (request.method === 'GET') {
          const raw = await this.state.storage.get<string>(`agent:${agentId}:rep`);
          const state = raw ? deserializeReputationState(raw) : createReputationState();
          const score = computeScore(state);
          return Response.json({ ok: true, reputation: score }, { status: 200 });
        }

        // POST /agents/:id/reputation - record outcome
        if (request.method === 'POST') {
          const body = await request.json().catch(() => null) as {
            blocked?: boolean;
            reason?: 'storm' | 'gray_blocked' | 'policy' | 'credits';
            backoff_detected?: boolean;
            zone?: 'safe' | 'gray' | 'storm';
            budget_overshoot?: boolean;
          } | null;
          if (!body) return new Response('invalid_request', { status: 400 });

          const raw = await this.state.storage.get<string>(`agent:${agentId}:rep`);
          const state = raw ? deserializeReputationState(raw) : createReputationState();

          recordOutcome(state, {
            blocked: body.blocked ?? false,
            reason: body.reason,
            backoff_detected: body.backoff_detected,
            zone: body.zone,
          });

          if (body.budget_overshoot !== undefined) {
            recordBudgetEvent(state, body.budget_overshoot);
          }

          await this.state.storage.put(`agent:${agentId}:rep`, serializeReputationState(state));
          const score = computeScore(state);
          return Response.json({ ok: true, reputation: score }, { status: 200 });
        }

        return new Response('method_not_allowed', { status: 405 });
      }

      return new Response('not_found', { status: 404 });
    }

    // ========================================================================
    // Invoice storage for subscription flow
    // ========================================================================
    if (parts[0] === 'invoices') {
      // PUT /invoices/:id - Store an invoice
      if (request.method === 'PUT' && parts.length === 2) {
        const invoiceId = parts[1]!;
        const body = await request.json().catch(() => null);
        if (!body) return new Response('invalid_request', { status: 400 });

        await this.state.storage.put(`invoice:${invoiceId}`, body);
        return Response.json({ ok: true }, { status: 200 });
      }

      // GET /invoices/:id - Retrieve an invoice
      if (request.method === 'GET' && parts.length === 2) {
        const invoiceId = parts[1]!;
        const invoice = await this.state.storage.get(`invoice:${invoiceId}`);

        if (!invoice) {
          return Response.json({ ok: false, error: 'invoice_not_found' }, { status: 404 });
        }

        return Response.json({ ok: true, invoice }, { status: 200 });
      }

      // DELETE /invoices/:id - Delete an invoice (cleanup after confirmation)
      if (request.method === 'DELETE' && parts.length === 2) {
        const invoiceId = parts[1]!;
        await this.state.storage.delete(`invoice:${invoiceId}`);
        return Response.json({ ok: true }, { status: 200 });
      }

      return new Response('method_not_allowed', { status: 405 });
    }

    // ========================================================================
    // Payment audit log - permanent record of all confirmed payments
    // ========================================================================
    if (parts[0] === 'payments') {
      // POST /payments - Record a new payment
      if (request.method === 'POST' && parts.length === 1) {
        const body = await request.json().catch(() => null) as PaymentRecord | null;
        if (!body || !body.txHash || !body.workspaceId) {
          return new Response('invalid_request', { status: 400 });
        }

        const paymentId = `payment_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const record: PaymentRecord = {
          ...body,
          id: paymentId,
          createdAtMs: Date.now(),
        };

        // Store payment with multiple indexes for querying
        await this.state.storage.put(`payment:${paymentId}`, record);
        
        // Index by tx hash (for dedup/lookup)
        await this.state.storage.put(`paytx:${body.txHash.toLowerCase()}`, paymentId);
        
        // Index by workspace (for listing workspace payments)
        const wsPayments = await this.state.storage.get<string[]>(`wspay:${body.workspaceId}`) || [];
        wsPayments.push(paymentId);
        await this.state.storage.put(`wspay:${body.workspaceId}`, wsPayments);

        // Global payment list (last 1000 for admin)
        const allPayments = await this.state.storage.get<string[]>('payments:all') || [];
        allPayments.unshift(paymentId); // newest first
        if (allPayments.length > 1000) allPayments.pop();
        await this.state.storage.put('payments:all', allPayments);

        return Response.json({ ok: true, payment_id: paymentId }, { status: 201 });
      }

      // GET /payments - List all payments (admin, requires secret)
      if (request.method === 'GET' && parts.length === 1) {
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
        const allPaymentIds = await this.state.storage.get<string[]>('payments:all') || [];
        
        const payments: PaymentRecord[] = [];
        for (const id of allPaymentIds.slice(0, limit)) {
          const payment = await this.state.storage.get<PaymentRecord>(`payment:${id}`);
          if (payment) payments.push(payment);
        }

        return Response.json({ 
          ok: true, 
          payments,
          total: allPaymentIds.length,
        }, { status: 200 });
      }

      // GET /payments/by-tx/:txHash - Get payment by transaction hash
      if (request.method === 'GET' && parts.length === 3 && parts[1] === 'by-tx') {
        const txHash = parts[2]!.toLowerCase();
        const paymentId = await this.state.storage.get<string>(`paytx:${txHash}`);
        
        if (!paymentId) {
          return Response.json({ ok: false, error: 'payment_not_found' }, { status: 404 });
        }

        const payment = await this.state.storage.get<PaymentRecord>(`payment:${paymentId}`);
        return Response.json({ ok: true, payment }, { status: 200 });
      }

      // GET /payments/by-workspace/:workspaceId - Get workspace payments
      if (request.method === 'GET' && parts.length === 3 && parts[1] === 'by-workspace') {
        const workspaceId = parts[2]!;
        const paymentIds = await this.state.storage.get<string[]>(`wspay:${workspaceId}`) || [];
        
        const payments: PaymentRecord[] = [];
        for (const id of paymentIds) {
          const payment = await this.state.storage.get<PaymentRecord>(`payment:${id}`);
          if (payment) payments.push(payment);
        }

        // Sort by date, newest first
        payments.sort((a, b) => b.confirmedAtMs - a.confirmedAtMs);

        return Response.json({ ok: true, payments }, { status: 200 });
      }

      // GET /payments/stats - Get payment statistics
      if (request.method === 'GET' && parts.length === 2 && parts[1] === 'stats') {
        const allPaymentIds = await this.state.storage.get<string[]>('payments:all') || [];
        
        let totalUsdc = 0;
        let subscriptions = 0;
        let renewals = 0;
        const byPlan: Record<string, number> = {};
        const byChain: Record<string, number> = {};

        for (const id of allPaymentIds) {
          const payment = await this.state.storage.get<PaymentRecord>(`payment:${id}`);
          if (payment) {
            totalUsdc += payment.amountUsdc;
            if (payment.type === 'subscription') subscriptions++;
            if (payment.type === 'renewal') renewals++;
            byPlan[payment.plan] = (byPlan[payment.plan] || 0) + payment.amountUsdc;
            byChain[payment.chain] = (byChain[payment.chain] || 0) + payment.amountUsdc;
          }
        }

        return Response.json({
          ok: true,
          stats: {
            total_payments: allPaymentIds.length,
            total_usdc: totalUsdc,
            subscriptions,
            renewals,
            by_plan: byPlan,
            by_chain: byChain,
          },
        }, { status: 200 });
      }

      return new Response('method_not_allowed', { status: 405 });
    }

    // GET /admin/workspaces - List all workspaces with subscription + balance
    if (parts[0] === 'admin' && parts[1] === 'workspaces' && request.method === 'GET') {
      const planFilter = url.searchParams.get('plan') || '';
      const allSubs = await this.state.storage.list({ prefix: 'sub:' });

      type SubRecord = {
        plan: string;
        credits: number;
        expiresAtMs: number;
        createdAtMs: number;
        features?: Record<string, unknown> | null;
      };

      const workspaces: Array<{
        workspace_id: string;
        plan: string;
        credits_remaining: number;
        credits_allocated: number;
        expires_at: string;
        created_at: string;
        is_expired: boolean;
        has_key: boolean;
      }> = [];

      const nowMs = Date.now();
      const planCounts: Record<string, number> = {};

      for (const [key, value] of allSubs) {
        const workspaceId = key.replace('sub:', '');
        const sub = value as SubRecord;

        planCounts[sub.plan] = (planCounts[sub.plan] || 0) + 1;

        if (planFilter && sub.plan !== planFilter) continue;

        const bal = await this.readBalanceRecord(workspaceId);
        const auth = await this.getAuth(workspaceId);

        workspaces.push({
          workspace_id: workspaceId,
          plan: sub.plan,
          credits_remaining: bal?.credits ?? 0,
          credits_allocated: sub.credits,
          expires_at: new Date(sub.expiresAtMs).toISOString(),
          created_at: new Date(sub.createdAtMs).toISOString(),
          is_expired: sub.expiresAtMs < nowMs,
          has_key: !!auth,
        });
      }

      // Sort newest first
      workspaces.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      return Response.json({
        ok: true,
        total: workspaces.length,
        total_all_plans: allSubs.size,
        by_plan: planCounts,
        workspaces,
      }, { status: 200 });
    }

    return new Response('not_found', { status: 404 });
  }
}
