import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { checkRoutes } from '../src/routes/check.js';
import { BillingStoreDO } from '../src/billingStoreDO.js';
import { hashApiKey } from '../src/lib/crypto.js';
import { CREDITS } from '../src/lib/constants.js';
import { freeGrantStorageKey, freeBillingPeriodKey } from '../src/lib/effectivePlan.js';
import type { Env } from '../src/types.js';
import { createMockDOState } from './helpers/mockDoState.js';
import type { Vars } from '../src/types.js';

const checkApp = new Hono<{ Bindings: Env; Variables: Vars }>();
checkApp.route('/', checkRoutes);

function createBillingEnv(doInstance: BillingStoreDO): Env {
  const stub = {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const href =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const path = new URL(href, 'https://do.internal').pathname;
      return doInstance.fetch(new Request(`https://do.internal${path}`, init));
    },
  };

  return {
    BILLING: {
      idFromName: () => ({ toString: () => 'billing-test' }),
      get: () => stub,
    },
    DECISIONS: {
      idFromName: () => ({ toString: () => 'decisions-test' }),
      get: () => ({
        fetch: async () => new Response('not_found', { status: 404 }),
      }),
    },
    BILLING_MODE: 'credits',
    API_AUTH_MODE: 'workspace',
  } as unknown as Env;
}

async function seedWorkspace(
  doInstance: BillingStoreDO,
  opts: {
    workspaceId: string;
    credits: number;
    apiKey?: string;
    plan?: string;
    expires_at_ms?: number;
  },
) {
  const apiKey = opts.apiKey ?? `pg_ws_${opts.workspaceId.padEnd(48, '0').slice(0, 48)}`;
  const apiKeyHash = await hashApiKey(apiKey);
  const res = await doInstance.fetch(
    new Request('https://do.internal/workspaces/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace_id: opts.workspaceId,
        api_key_hash: apiKeyHash,
        plan: opts.plan ?? 'free',
        credits: opts.credits,
        expires_at_ms: opts.expires_at_ms ?? Date.now() + 30 * 24 * 60 * 60 * 1000,
      }),
    }),
  );
  if (!res.ok) {
    throw new Error(`workspace create failed: ${res.status}`);
  }
  return { apiKey, apiKeyHash };
}

async function postCheck(env: Env, apiKey: string, body: Record<string, unknown>) {
  return checkApp.request(
    'http://localhost/v1/check',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe('POST /v1/check', () => {
  let billingDo: BillingStoreDO;
  let env: Env;

  beforeEach(() => {
    billingDo = new BillingStoreDO(createMockDOState(), {});
    env = createBillingEnv(billingDo);
  });

  it('A: free workspace with credits returns 200 allowed:true', async () => {
    const { apiKey } = await seedWorkspace(billingDo, {
      workspaceId: 'ws-free-ok',
      credits: CREDITS.FREE_TIER,
    });

    const res = await postCheck(env, apiKey, {
      agent_id: 'agent-1',
      task_hash: 'task-a',
      action: 'tool_call',
    });
    const body = await res.json() as {
      allowed: boolean;
      credits_remaining?: number;
      proceed_token?: string;
    };

    expect(res.status).toBe(200);
    expect(body.allowed).toBe(true);
    expect(body.credits_remaining).toBe(CREDITS.FREE_TIER - 1);
    expect(body.proceed_token).toBeTruthy();
  });

  it('B: no credits returns 402 and does not increment loop counter', async () => {
    const wsId = 'ws-no-credits';
    const { apiKey } = await seedWorkspace(billingDo, { workspaceId: wsId, credits: 1 });
    await billingDo.fetch(new Request(`https://do.internal/workspaces/${wsId}/billing-effective`));
    const state = (billingDo as unknown as { state: { storage: { put: (k: string, v: object) => Promise<void> } } }).state;
    await state.storage.put(`ws:${wsId}`, { workspaceId: wsId, credits: 0, updatedAtMs: Date.now() });

    const res = await postCheck(env, apiKey, {
      agent_id: 'agent-1',
      task_hash: 'same-task',
      action: 'tool_call',
    });
    const body = await res.json() as {
      allowed: boolean;
      error: string;
      zone: string;
      credits_remaining: number;
      iteration_count?: number;
    };

    expect(res.status).toBe(402);
    expect(body.allowed).toBe(false);
    expect(body.error).toBe('insufficient_credits');
    expect(body.credits_remaining).toBe(0);
    expect(body.zone).toBe('billing');
    expect(body.iteration_count).toBeUndefined();

    const loopKeys = await (billingDo as unknown as { state: { storage: { list: (o: { prefix: string }) => Promise<Map<string, unknown>> } } }).state.storage.list({
      prefix: `loop:${wsId}:`,
    });
    expect(loopKeys.size).toBe(0);
  });

  it('C: repeated no-credit checks stay 402 and never become 429', async () => {
    const wsId = 'ws-repeat-402';
    const { apiKey } = await seedWorkspace(billingDo, { workspaceId: wsId, credits: 1 });
    await billingDo.fetch(new Request(`https://do.internal/workspaces/${wsId}/billing-effective`));
    const state = (billingDo as unknown as { state: { storage: { put: (k: string, v: object) => Promise<void> } } }).state;
    await state.storage.put(`ws:${wsId}`, { workspaceId: wsId, credits: 0, updatedAtMs: Date.now() });

    const payload = { agent_id: 'agent-1', task_hash: 'repeat-task', action: 'tool_call' as const };
    for (let i = 0; i < 15; i++) {
      const res = await postCheck(env, apiKey, payload);
      expect(res.status).toBe(402);
      const body = await res.json() as { error: string; zone: string };
      expect(body.error).toBe('insufficient_credits');
      expect(body.zone).toBe('billing');
    }
  });

  it('D: with credits, loop storm still returns 429 after threshold', async () => {
    const { apiKey } = await seedWorkspace(billingDo, {
      workspaceId: 'ws-storm',
      credits: 20,
    });

    const payload = { agent_id: 'agent-storm', task_hash: 'storm-task', action: 'tool_call' as const };
    let lastStatus = 0;
    for (let i = 0; i < 12; i++) {
      const res = await postCheck(env, apiKey, payload);
      lastStatus = res.status;
      if (res.status === 429) break;
    }
    expect(lastStatus).toBe(429);
  });

  it('E: orphan keyidx does not silently grant zero-balance workspace', async () => {
    const apiKey = 'pg_ws_' + 'f'.repeat(48);
    const apiKeyHash = await hashApiKey(apiKey);
    const state = (billingDo as unknown as { state: { storage: { put: (k: string, v: string) => Promise<void> } } }).state;
    await state.storage.put(`keyidx:${apiKeyHash}`, 'orphan-keyidx-ws');

    const res = await postCheck(env, apiKey, {
      agent_id: 'agent-1',
      task_hash: 'orphan-task',
    });
    const body = await res.json() as { error: string; allowed: boolean };

    expect(res.status).toBe(404);
    expect(body.allowed).toBe(false);
    expect(body.error).toBe('billing_not_initialized');
  });

  it('G: active starter with credits returns 200', async () => {
    const { apiKey } = await seedWorkspace(billingDo, {
      workspaceId: 'ws-starter-active',
      plan: 'starter',
      credits: 100,
      expires_at_ms: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });

    const res = await postCheck(env, apiKey, {
      agent_id: 'agent-1',
      task_hash: 'starter-task',
      action: 'tool_call',
    });
    const body = await res.json() as { allowed: boolean; credits_remaining?: number };

    expect(res.status).toBe(200);
    expect(body.allowed).toBe(true);
    expect(body.credits_remaining).toBe(99);
  });

  it('H: expired starter with zero credits reconciles free and allows check', async () => {
    const { apiKey } = await seedWorkspace(billingDo, {
      workspaceId: 'ws-starter-expired',
      plan: 'starter',
      credits: 0,
      expires_at_ms: Date.now() - 86_400_000,
    });

    const res = await postCheck(env, apiKey, {
      agent_id: 'agent-1',
      task_hash: 'expired-starter-task',
      action: 'tool_call',
    });
    const body = await res.json() as { allowed: boolean; credits_remaining?: number };

    expect(res.status).toBe(200);
    expect(body.allowed).toBe(true);
    expect(body.credits_remaining).toBe(CREDITS.FREE_TIER - 1);
  });

  it('I: expired starter after monthly grant exhausted returns 402 without storm', async () => {
    const wsId = 'ws-starter-exhausted';
    const { apiKey } = await seedWorkspace(billingDo, {
      workspaceId: wsId,
      plan: 'starter',
      credits: 0,
      expires_at_ms: Date.now() - 1,
    });
    await billingDo.fetch(
      new Request(`https://do.internal/workspaces/${wsId}/billing-effective`),
    );
    const state = (billingDo as unknown as { state: { storage: { put: (k: string, v: object) => Promise<void> } } }).state;
    await state.storage.put(`ws:${wsId}`, { workspaceId: wsId, credits: 0, updatedAtMs: Date.now() });

    const payload = { agent_id: 'agent-1', task_hash: 'no-credits-task', action: 'tool_call' as const };
    for (let i = 0; i < 5; i++) {
      const res = await postCheck(env, apiKey, payload);
      expect(res.status).toBe(402);
      const body = await res.json() as { zone: string; iteration_count?: number };
      expect(body.zone).toBe('billing');
      expect(body.iteration_count).toBeUndefined();
    }
  });

  it('J: expired starter frozen with grant marker allows check after repair', async () => {
    const wsId = 'ws-starter-frozen-repair';
    const periodKey = freeBillingPeriodKey(Date.now());
    const { apiKey } = await seedWorkspace(billingDo, {
      workspaceId: wsId,
      plan: 'starter',
      credits: 4994,
      expires_at_ms: Date.now() - 86_400_000,
    });
    const state = (billingDo as unknown as {
      state: {
        storage: {
          put: (k: string, v: unknown) => Promise<void>;
        };
      };
    }).state;
    await state.storage.put(`ws:${wsId}`, { workspaceId: wsId, credits: 0, updatedAtMs: Date.now() });
    await state.storage.put(`frozen_credits:${wsId}`, 4994);
    await state.storage.put(freeGrantStorageKey(wsId, periodKey), true);

    const res = await postCheck(env, apiKey, {
      agent_id: 'agent-1',
      task_hash: 'frozen-repair-task',
      action: 'tool_call',
    });
    const body = await res.json() as { allowed: boolean; credits_remaining?: number; zone?: string };

    expect(res.status).toBe(200);
    expect(body.allowed).toBe(true);
    expect(body.zone).toBe('safe');
    expect(body.credits_remaining).toBe(CREDITS.FREE_TIER - 1);
  });

  it('F: invalid action costly_tool_lookup returns 400', async () => {
    const { apiKey } = await seedWorkspace(billingDo, {
      workspaceId: 'ws-invalid-action',
      credits: 100,
    });

    const res = await postCheck(env, apiKey, {
      agent_id: 'agent-1',
      task_hash: 'task-x',
      action: 'costly_tool_lookup',
    });
    const body = await res.json() as { error: string };

    expect(res.status).toBe(400);
    expect(body.error).toBe('invalid_request');
  });
});
