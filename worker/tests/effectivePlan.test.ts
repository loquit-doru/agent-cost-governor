import { describe, it, expect } from 'vitest';
import {
  applyFreeTopUp,
  freeBillingPeriodKey,
  resolveEffectivePlanFromSub,
} from '../src/lib/effectivePlan.js';
import { CREDITS } from '../src/lib/constants.js';

describe('effectivePlan', () => {
  const now = Date.UTC(2026, 4, 18, 12, 0, 0);

  it('active starter stays on starter allowance', () => {
    const snap = resolveEffectivePlanFromSub({
      storedPlan: 'starter',
      expiresAtMs: now + 86_400_000,
      creditsRemaining: 100,
      nowMs: now,
    });
    expect(snap.effective_plan).toBe('starter');
    expect(snap.included_checks).toBe(CREDITS.STARTER);
    expect(snap.reason).toBe('active_paid');
  });

  it('expired starter falls back to free', () => {
    const snap = resolveEffectivePlanFromSub({
      storedPlan: 'starter',
      expiresAtMs: now - 1,
      creditsRemaining: 0,
      nowMs: now,
    });
    expect(snap.effective_plan).toBe('free');
    expect(snap.included_checks).toBe(CREDITS.FREE_TIER);
    expect(snap.reason).toBe('expired_paid_fallback_free');
    expect(snap.previous_plan).toBe('starter');
    expect(snap.status).toBe('expired');
  });

  it('free period key is YYYY-MM UTC', () => {
    expect(freeBillingPeriodKey(now)).toBe('2026-05');
  });

  it('applyFreeTopUp tops up below cap and clamps above cap', () => {
    expect(applyFreeTopUp(0)).toBe(5000);
    expect(applyFreeTopUp(4999)).toBe(5000);
    expect(applyFreeTopUp(5000)).toBe(5000);
    expect(applyFreeTopUp(6000)).toBe(5000);
  });
});
