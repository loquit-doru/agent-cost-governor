import { CREDITS } from './constants.js';

export type EffectivePlanReason =
  | 'active_paid'
  | 'expired_paid_fallback_free'
  | 'active_free';

export type EffectivePlanStatus = 'active' | 'expired';

export type EffectivePlanSnapshot = {
  stored_plan: string;
  effective_plan: string;
  status: EffectivePlanStatus;
  included_checks: number;
  credits_remaining: number;
  free_period_key: string;
  reason: EffectivePlanReason;
  previous_plan?: string;
};

const PAID_PLANS = new Set(['starter', 'pro', 'scale', 'enterprise']);

export function freeBillingPeriodKey(nowMs: number): string {
  const d = new Date(nowMs);
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${d.getUTCFullYear()}-${month}`;
}

export function planIncludedChecks(plan: string): number {
  switch (plan) {
    case 'starter':
      return CREDITS.STARTER;
    case 'pro':
      return CREDITS.PRO;
    case 'scale':
    case 'enterprise':
      return CREDITS.ENTERPRISE;
    case 'free':
    default:
      return CREDITS.FREE_TIER;
  }
}

export function isPaidPlan(plan: string): boolean {
  return PAID_PLANS.has(plan);
}

export function resolveEffectivePlanFromSub(input: {
  storedPlan: string;
  expiresAtMs: number;
  creditsRemaining: number;
  nowMs: number;
}): EffectivePlanSnapshot {
  const { storedPlan, expiresAtMs, creditsRemaining, nowMs } = input;
  const freePeriodKey = freeBillingPeriodKey(nowMs);
  const paid = isPaidPlan(storedPlan);
  const expired = paid && expiresAtMs <= nowMs;

  if (paid && !expired) {
    return {
      stored_plan: storedPlan,
      effective_plan: storedPlan,
      status: 'active',
      included_checks: planIncludedChecks(storedPlan),
      credits_remaining: creditsRemaining,
      free_period_key: freePeriodKey,
      reason: 'active_paid',
    };
  }

  if (expired) {
    return {
      stored_plan: storedPlan,
      effective_plan: 'free',
      status: 'expired',
      included_checks: CREDITS.FREE_TIER,
      credits_remaining: creditsRemaining,
      free_period_key: freePeriodKey,
      reason: 'expired_paid_fallback_free',
      previous_plan: storedPlan,
    };
  }

  return {
    stored_plan: storedPlan,
    effective_plan: 'free',
    status: 'active',
    included_checks: CREDITS.FREE_TIER,
    credits_remaining: creditsRemaining,
    free_period_key: freePeriodKey,
    reason: 'active_free',
  };
}

export function freeGrantStorageKey(workspaceId: string, periodKey: string): string {
  return `free_grant:${workspaceId}:${periodKey}`;
}

/** Top up to free cap once per period; never leave free tier above cap (Policy B). */
export function applyFreeTopUp(currentCredits: number, cap = CREDITS.FREE_TIER): number {
  return Math.min(cap, Math.max(currentCredits, cap));
}
