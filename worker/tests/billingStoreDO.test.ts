import { describe, it, expect, beforeEach } from 'vitest';
import { BillingStoreDO } from '../src/billingStoreDO.js';
import { hashApiKey } from '../src/lib/crypto.js';
import { CREDITS } from '../src/lib/constants.js';
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
