import { describe, it, expect, beforeEach } from 'vitest';
import { BillingStoreDO } from '../src/billingStoreDO.js';
import { hashApiKey } from '../src/lib/crypto.js';
import { CREDITS } from '../src/lib/constants.js';
import { freeGrantStorageKey, freeExpiredPaidRepairStorageKey, freeBillingPeriodKey } from '../src/lib/effectivePlan.js';
import { createMockDOState } from './helpers/mockDoState.js';

function doRequest(doInstance: BillingStoreDO, path: string, init?: RequestInit) {
  return doInstance.fetch(new Request(`https://do.internal${path}`, init));
}

describe('BillingStoreDO balance resolution', () => {
  let billingDo: BillingStoreDO;

  beforeEach(() => {
    billingDo = new BillingStoreDO(createMockDOState(), {});
  });

  it('returns existing balance without creating a zero row', async () => {
    const wsId = 'ws-existing';
    await doRequest(billingDo, '/workspaces/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace_id: wsId,
        api_key_hash: 'b'.repeat(64),
        plan: 'free',
        credits: CREDITS.FREE_TIER,
        expires_at_ms: Date.now() + 86_400_000,
      }),
    });

    const res = await doRequest(billingDo, `/workspaces/${wsId}`);
    const body = await res.json() as { credits: number };
    expect(res.status).toBe(200);
    expect(body.credits).toBe(CREDITS.FREE_TIER);
  });

  it('reconstructs free-tier balance when sub+auth exist but ws row is missing', async () => {
    const wsId = 'ws-reconstruct';
    const apiKeyHash = 'c'.repeat(64);
    await doRequest(billingDo, '/workspaces/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace_id: wsId,
        api_key_hash: apiKeyHash,
        plan: 'free',
        credits: CREDITS.FREE_TIER,
        expires_at_ms: Date.now() + 86_400_000,
      }),
    });

    const state = (billingDo as unknown as { state: { storage: { delete: (k: string) => Promise<void> } } }).state;
    await state.storage.delete(`ws:${wsId}`);

    const res = await doRequest(billingDo, `/workspaces/${wsId}`);
    const body = await res.json() as { credits: number };
    expect(res.status).toBe(200);
    expect(body.credits).toBe(CREDITS.FREE_TIER);
  });

  it('orphan keyidx without ws/sub returns billing_not_initialized on GET', async () => {
    const apiKey = 'pg_ws_' + 'd'.repeat(48);
    const apiKeyHash = await hashApiKey(apiKey);
    const state = (billingDo as unknown as { state: { storage: { put: (k: string, v: string) => Promise<void> } } }).state;
    await state.storage.put(`keyidx:${apiKeyHash}`, 'orphan-ws-only');

    const lookup = await doRequest(billingDo, '/keys/lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key_hash: apiKeyHash }),
    });
    expect(lookup.status).toBe(200);

    const balance = await doRequest(billingDo, '/workspaces/orphan-ws-only');
    const body = await balance.json() as { error: string; credits: number };
    expect(balance.status).toBe(404);
    expect(body.error).toBe('billing_not_initialized');
    expect(body.credits).toBe(0);
  });

  it('expired starter reconciles to free with one-time 5000 grant', async () => {
    const wsId = 'ws-expired-starter';
    const now = Date.UTC(2026, 4, 18, 12, 0, 0);
    await doRequest(billingDo, '/workspaces/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace_id: wsId,
        api_key_hash: 's'.repeat(64),
        plan: 'starter',
        credits: 0,
        expires_at_ms: now - 86_400_000,
      }),
    });

    const res = await doRequest(billingDo, `/workspaces/${wsId}/billing-effective`);
    const body = await res.json() as {
      effective_plan: string;
      included_checks: number;
      credits_remaining: number;
      reason: string;
      previous_plan?: string;
      free_grant_applied: boolean;
    };
    expect(res.status).toBe(200);
    expect(body.effective_plan).toBe('free');
    expect(body.included_checks).toBe(CREDITS.FREE_TIER);
    expect(body.credits_remaining).toBe(CREDITS.FREE_TIER);
    expect(body.reason).toBe('expired_paid_fallback_free');
    expect(body.previous_plan).toBe('starter');
    expect(body.free_grant_applied).toBe(true);

    const grantKey = freeGrantStorageKey(wsId, '2026-05');
    const state = (billingDo as unknown as { state: { storage: { get: (k: string) => Promise<unknown> } } }).state;
    expect(await state.storage.get(grantKey)).toBe(true);
  });

  it('second reconcile in same month does not duplicate free grant', async () => {
    const wsId = 'ws-no-dup-grant';
    const now = Date.UTC(2026, 4, 18, 12, 0, 0);
    await doRequest(billingDo, '/workspaces/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace_id: wsId,
        api_key_hash: 't'.repeat(64),
        plan: 'starter',
        credits: 0,
        expires_at_ms: now - 1,
      }),
    });

    await doRequest(billingDo, `/workspaces/${wsId}/billing-effective`);
    const state = (billingDo as unknown as { state: { storage: { put: (k: string, v: object) => Promise<void> } } }).state;
    await state.storage.put(`ws:${wsId}`, { workspaceId: wsId, credits: 100, updatedAtMs: Date.now() });

    const res = await doRequest(billingDo, `/workspaces/${wsId}/billing-effective`);
    const body = await res.json() as { credits_remaining: number; free_grant_applied: boolean };
    expect(body.credits_remaining).toBe(100);
    expect(body.free_grant_applied).toBe(false);
  });

  it('new month grants free allowance once again', async () => {
    const wsId = 'ws-rollover';
    await doRequest(billingDo, '/workspaces/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace_id: wsId,
        api_key_hash: 'u'.repeat(64),
        plan: 'starter',
        credits: 0,
        expires_at_ms: Date.now() - 86_400_000,
      }),
    });

    await doRequest(billingDo, `/workspaces/${wsId}/billing-effective`);
    const state = (billingDo as unknown as { state: { storage: { put: (k: string, v: object) => Promise<void> } } }).state;
    await state.storage.put(`ws:${wsId}`, { workspaceId: wsId, credits: 0, updatedAtMs: Date.now() });

    const sameMonth = await doRequest(billingDo, `/workspaces/${wsId}/billing-effective`);
    const sameBody = await sameMonth.json() as { credits_remaining: number; free_grant_applied: boolean };
    expect(sameBody.credits_remaining).toBe(0);
    expect(sameBody.free_grant_applied).toBe(false);

    const origNow = Date.now;
    Date.now = () => Date.UTC(2026, 5, 15, 12, 0, 0);
    try {
      const res = await doRequest(billingDo, `/workspaces/${wsId}/billing-effective`);
      const body = await res.json() as {
        credits_remaining: number;
        free_grant_applied: boolean;
        free_period_key: string;
      };
      expect(body.free_period_key).toBe('2026-06');
      expect(body.credits_remaining).toBe(CREDITS.FREE_TIER);
      expect(body.free_grant_applied).toBe(true);
    } finally {
      Date.now = origNow;
    }
  });

  it('expired starter with frozen credits and existing free_grant repairs to 5000 once', async () => {
    const wsId = 'starter-mnk55htu85mf';
    const periodKey = freeBillingPeriodKey(Date.now());
    await doRequest(billingDo, '/workspaces/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace_id: wsId,
        api_key_hash: 'm'.repeat(64),
        plan: 'starter',
        credits: 4994,
        expires_at_ms: Date.now() - 86_400_000,
      }),
    });

    const state = (billingDo as unknown as {
      state: {
        storage: {
          put: (k: string, v: unknown) => Promise<void>;
          get: (k: string) => Promise<unknown>;
        };
      };
    }).state;
    await state.storage.put(`ws:${wsId}`, { workspaceId: wsId, credits: 0, updatedAtMs: Date.now() });
    await state.storage.put(`frozen_credits:${wsId}`, 4994);
    await state.storage.put(freeGrantStorageKey(wsId, periodKey), true);

    const res = await doRequest(billingDo, `/workspaces/${wsId}/billing-effective`);
    const body = await res.json() as {
      effective_plan: string;
      previous_plan?: string;
      credits_remaining: number;
      included_checks: number;
      free_repair_applied?: boolean;
    };
    expect(res.status).toBe(200);
    expect(body.effective_plan).toBe('free');
    expect(body.previous_plan).toBe('starter');
    expect(body.credits_remaining).toBe(CREDITS.FREE_TIER);
    expect(body.included_checks).toBe(CREDITS.FREE_TIER);
    expect(body.free_repair_applied).toBe(true);
    expect(await state.storage.get(freeExpiredPaidRepairStorageKey(wsId, periodKey))).toBe(true);
    expect(await state.storage.get(`frozen_credits:${wsId}`)).toBe(4994);
  });

  it('expired starter frozen repair does not apply twice in same period', async () => {
    const wsId = 'ws-frozen-no-dup-repair';
    const periodKey = freeBillingPeriodKey(Date.now());
    await doRequest(billingDo, '/workspaces/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace_id: wsId,
        api_key_hash: 'n'.repeat(64),
        plan: 'starter',
        credits: 100,
        expires_at_ms: Date.now() - 1,
      }),
    });
    const state = (billingDo as unknown as {
      state: {
        storage: {
          put: (k: string, v: unknown) => Promise<void>;
        };
      };
    }).state;
    await state.storage.put(`ws:${wsId}`, { workspaceId: wsId, credits: 0, updatedAtMs: Date.now() });
    await state.storage.put(`frozen_credits:${wsId}`, 100);
    await state.storage.put(freeGrantStorageKey(wsId, periodKey), true);

    await doRequest(billingDo, `/workspaces/${wsId}/billing-effective`);
    await state.storage.put(`ws:${wsId}`, { workspaceId: wsId, credits: 0, updatedAtMs: Date.now() });

    const res = await doRequest(billingDo, `/workspaces/${wsId}/billing-effective`);
    const body = await res.json() as { credits_remaining: number; free_repair_applied?: boolean };
    expect(body.credits_remaining).toBe(0);
    expect(body.free_repair_applied).toBe(false);
  });

  it('expired starter with frozen credits but free allowance genuinely used is not repaired', async () => {
    const wsId = 'ws-frozen-exhausted';
    const periodKey = freeBillingPeriodKey(Date.now());
    await doRequest(billingDo, '/workspaces/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace_id: wsId,
        api_key_hash: 'o'.repeat(64),
        plan: 'starter',
        credits: 0,
        expires_at_ms: Date.now() - 1,
      }),
    });
    const state = (billingDo as unknown as {
      state: {
        storage: {
          put: (k: string, v: unknown) => Promise<void>;
        };
      };
    }).state;
    const today = new Date().toISOString().slice(0, 10);
    await state.storage.put(`usage:${wsId}:${today}`, {
      workspaceId: wsId,
      date: today,
      credits: CREDITS.FREE_TIER,
      actions: {},
      tools: {},
    });
    await state.storage.put(`ws:${wsId}`, { workspaceId: wsId, credits: 0, updatedAtMs: Date.now() });
    await state.storage.put(`frozen_credits:${wsId}`, 4994);
    await state.storage.put(freeGrantStorageKey(wsId, periodKey), true);

    const res = await doRequest(billingDo, `/workspaces/${wsId}/billing-effective`);
    const body = await res.json() as { credits_remaining: number; free_repair_applied?: boolean };
    expect(body.credits_remaining).toBe(0);
    expect(body.free_repair_applied).toBe(false);
  });

  it('active free with zero balance and no frozen credits is not repaired', async () => {
    const wsId = 'ws-free-exhausted';
    const periodKey = freeBillingPeriodKey(Date.now());
    await doRequest(billingDo, '/workspaces/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace_id: wsId,
        api_key_hash: 'p'.repeat(64),
        plan: 'free',
        credits: CREDITS.FREE_TIER,
        expires_at_ms: Date.now() + 86_400_000,
      }),
    });
    const state = (billingDo as unknown as {
      state: {
        storage: {
          put: (k: string, v: unknown) => Promise<void>;
        };
      };
    }).state;
    await state.storage.put(`ws:${wsId}`, { workspaceId: wsId, credits: 0, updatedAtMs: Date.now() });
    await state.storage.put(freeGrantStorageKey(wsId, periodKey), true);

    const res = await doRequest(billingDo, `/workspaces/${wsId}/billing-effective`);
    const body = await res.json() as {
      credits_remaining: number;
      free_repair_applied?: boolean;
      reason: string;
    };
    expect(body.reason).toBe('active_free');
    expect(body.credits_remaining).toBe(0);
    expect(body.free_repair_applied).toBe(false);
  });

  it('consume on zero credits does not create a phantom balance row', async () => {
    const wsId = 'ws-zero';
    await doRequest(billingDo, '/workspaces/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace_id: wsId,
        api_key_hash: 'e'.repeat(64),
        plan: 'free',
        credits: 1,
        expires_at_ms: Date.now() + 86_400_000,
      }),
    });
    await doRequest(billingDo, `/workspaces/${wsId}/billing-effective`);
    const state = (billingDo as unknown as { state: { storage: { put: (k: string, v: object) => Promise<void> } } }).state;
    await state.storage.put(`ws:${wsId}`, { workspaceId: wsId, credits: 0, updatedAtMs: Date.now() });

    const consume = await doRequest(billingDo, `/workspaces/${wsId}/consume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n: 1 }),
    });
    const body = await consume.json() as { error: string; credits: number };
    expect(consume.status).toBe(402);
    expect(body.error).toBe('insufficient_credits');
    expect(body.credits).toBe(0);
  });
});
