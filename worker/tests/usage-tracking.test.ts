import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { checkRoutes } from '../src/routes/check.js';
import { adminRoutes } from '../src/routes/admin.js';
import { dlRoutes } from '../src/routes/dl.js';
import { BillingStoreDO } from '../src/billingStoreDO.js';
import { hashApiKey } from '../src/lib/crypto.js';
import { CREDITS } from '../src/lib/constants.js';
import type { Env, Vars } from '../src/types.js';
import { createMockDOState } from './helpers/mockDoState.js';
import {
  categorizeV1CheckStatus,
  isN8nLike,
  type V1CheckEvent,
} from '../src/lib/usageTracking.js';

const checkApp = new Hono<{ Bindings: Env; Variables: Vars }>();
checkApp.route('/', checkRoutes);

const adminApp = new Hono<{ Bindings: Env; Variables: Vars }>();
adminApp.route('/', adminRoutes);

const dlApp = new Hono<{ Bindings: Env; Variables: Vars }>();
dlApp.route('/', dlRoutes);

function createBillingEnv(doInstance: BillingStoreDO, extra: Partial<Env> = {}): Env {
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
    API_ADMIN_KEY: 'test-admin-key',
    ...extra,
  } as unknown as Env;
}

async function seedWorkspace(
  doInstance: BillingStoreDO,
  opts: { workspaceId: string; credits: number; apiKey?: string },
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
        plan: 'free',
        credits: opts.credits,
        expires_at_ms: Date.now() + 30 * 24 * 60 * 60 * 1000,
      }),
    }),
  );
  if (!res.ok) throw new Error(`workspace create failed: ${res.status}`);
  return { apiKey, apiKeyHash };
}

async function getV1CheckEvents(doInstance: BillingStoreDO): Promise<V1CheckEvent[]> {
  const day = new Date().toISOString().slice(0, 10);
  const state = (doInstance as unknown as { state: { storage: { get: (k: string) => Promise<V1CheckEvent[] | undefined> } } }).state;
  return (await state.storage.get(`v1_check:${day}`)) ?? [];
}

describe('usage tracking helpers', () => {
  it('1: categorizes status codes', () => {
    expect(categorizeV1CheckStatus(200, true)).toBe('allowed');
    expect(categorizeV1CheckStatus(402)).toBe('billing');
    expect(categorizeV1CheckStatus(429)).toBe('storm');
    expect(categorizeV1CheckStatus(400)).toBe('invalid');
    expect(categorizeV1CheckStatus(401)).toBe('other');
  });

  it('2: detects n8n-like agents and user agents', () => {
    expect(isN8nLike('n8n-lead-enrich', null)).toBe(true);
    expect(isN8nLike('agent-1', 'n8n/1.0')).toBe(true);
    expect(isN8nLike('agent-1', 'curl/8')).toBe(false);
  });
});

describe('POST /v1/check usage logging', () => {
  let billingDo: BillingStoreDO;
  let env: Env;

  beforeEach(() => {
    billingDo = new BillingStoreDO(createMockDOState(), {});
    env = createBillingEnv(billingDo);
  });

  it('3: logs allowed 200 check with workspace metadata', async () => {
    const { apiKey, apiKeyHash } = await seedWorkspace(billingDo, {
      workspaceId: 'ws-track-ok',
      credits: CREDITS.FREE_TIER,
    });

    const res = await checkApp.request(
      'http://localhost/v1/check',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'user-agent': 'n8n/1.0',
          'cf-connecting-ip': '203.0.113.10',
        },
        body: JSON.stringify({
          agent_id: 'n8n-test-agent',
          task_hash: 'task-1',
          action: 'tool_call',
          step_hash: 'step-a',
        }),
      },
      env,
    );

    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    const events = await getV1CheckEvents(billingDo);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const last = events[events.length - 1]!;
    expect(last.workspace_id).toBe('ws-track-ok');
    expect(last.api_key_hash).toBe(apiKeyHash);
    expect(last.agent_id).toBe('n8n-test-agent');
    expect(last.error_category).toBe('allowed');
    expect(last.source).toBe('v1_check');
    expect(last.ip_hash).toBeTruthy();
  });

  it('4: logs 400 invalid without workspace', async () => {
    const { apiKey } = await seedWorkspace(billingDo, {
      workspaceId: 'ws-track-invalid',
      credits: 10,
    });

    const res = await checkApp.request(
      'http://localhost/v1/check',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ agent_id: 'a', task_hash: 't', action: 'costly_tool_lookup' }),
      },
      env,
    );

    expect(res.status).toBe(400);
    await new Promise((r) => setTimeout(r, 10));
    const events = await getV1CheckEvents(billingDo);
    const invalid = events.filter((e) => e.error_category === 'invalid');
    expect(invalid.length).toBeGreaterThanOrEqual(1);
    expect(invalid[invalid.length - 1]?.workspace_id).toBeNull();
  });

  it('5: logs 402 billing denial', async () => {
    const wsId = 'ws-track-402';
    const { apiKey } = await seedWorkspace(billingDo, { workspaceId: wsId, credits: 1 });
    await billingDo.fetch(new Request(`https://do.internal/workspaces/${wsId}/billing-effective`));
    const state = (billingDo as unknown as { state: { storage: { put: (k: string, v: object) => Promise<void> } } }).state;
    await state.storage.put(`ws:${wsId}`, { workspaceId: wsId, credits: 0, updatedAtMs: Date.now() });

    const res = await checkApp.request(
      'http://localhost/v1/check',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ agent_id: 'agent-1', task_hash: 't', action: 'tool_call' }),
      },
      env,
    );

    expect(res.status).toBe(402);
    await new Promise((r) => setTimeout(r, 10));
    const events = await getV1CheckEvents(billingDo);
    const billing = events.filter((e) => e.error_category === 'billing');
    expect(billing.length).toBeGreaterThanOrEqual(1);
  });
});

describe('GET /admin/metrics', () => {
  let billingDo: BillingStoreDO;
  let env: Env;

  beforeEach(() => {
    billingDo = new BillingStoreDO(createMockDOState(), {});
    env = createBillingEnv(billingDo);
  });

  it('6: requires admin auth', async () => {
    const res = await adminApp.request('http://localhost/admin/metrics', {}, env);
    expect(res.status).toBe(401);
  });

  it('7: returns metrics with admin key', async () => {
    const res = await adminApp.request(
      'http://localhost/admin/metrics',
      { headers: { 'x-admin-key': 'test-admin-key' } },
      env,
    );
    const body = await res.json() as { ok: boolean; checks_7d: number };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.checks_7d).toBe('number');
  });

  it('8: accepts ADMIN_METRICS_TOKEN bearer', async () => {
    const metricsEnv = createBillingEnv(billingDo, { ADMIN_METRICS_TOKEN: 'metrics-secret' });
    const res = await adminApp.request(
      'http://localhost/admin/metrics',
      { headers: { Authorization: 'Bearer metrics-secret' } },
      metricsEnv,
    );
    expect(res.status).toBe(200);
  });
});

describe('n8n download routes', () => {
  let billingDo: BillingStoreDO;
  let env: Env;

  const RAW_BASE =
    'https://raw.githubusercontent.com/loquit-doru/agent-cost-governor/main/examples/n8n/';
  const BLOB_BASE =
    'https://github.com/loquit-doru/agent-cost-governor/blob/main/examples/n8n/';

  beforeEach(() => {
    billingDo = new BillingStoreDO(createMockDOState(), {});
    env = createBillingEnv(billingDo);
  });

  it.each([
    ['guard-sub-workflow', 'guard-sub-workflow.json'],
    ['main-ai-agent-flow', 'main-ai-agent-flow.json'],
    ['proceedgate-guard-sub-workflow', 'proceedgate-guard-sub-workflow.json'],
  ] as const)('9: %s redirects to raw GitHub JSON', async (slug, filename) => {
    const res = await dlApp.request(
      `http://localhost/dl/n8n/${slug}`,
      { headers: { 'user-agent': 'Mozilla/5.0', 'cf-connecting-ip': '203.0.113.1' } },
      env,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toBe(`${RAW_BASE}${filename}`);
    expect(location).not.toContain('/blob/');
  });

  it('10: native-vs-proceedgate-guide redirects to GitHub blob markdown', async () => {
    const res = await dlApp.request(
      'http://localhost/dl/n8n/native-vs-proceedgate-guide',
      { headers: { 'user-agent': 'Mozilla/5.0' } },
      env,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toBe(
      `${BLOB_BASE}native-vs-proceedgate-guard-workflow.md`,
    );
    expect(location).toContain('/blob/');
    expect(location).not.toContain('raw.githubusercontent.com');
  });

  it('11: logs download with hashed IP only', async () => {
    const res = await dlApp.request(
      'http://localhost/dl/n8n/guard-sub-workflow',
      { headers: { 'user-agent': 'Mozilla/5.0', 'cf-connecting-ip': '203.0.113.1' } },
      env,
    );
    expect(res.status).toBe(302);
    await new Promise((r) => setTimeout(r, 10));
    const day = new Date().toISOString().slice(0, 10);
    const state = (billingDo as unknown as {
      state: {
        storage: {
          get: (k: string) => Promise<Array<Record<string, unknown>> | undefined>;
        };
      };
    }).state;
    const downloads = await state.storage.get(`n8n_download:${day}`);
    const entry = downloads?.find((d) => d.asset_id === 'guard-sub-workflow');
    expect(entry).toBeTruthy();
    expect(entry?.ip_hash).toBeTruthy();
    expect(entry).not.toHaveProperty('ip');
    expect(JSON.stringify(entry)).not.toContain('203.0.113.1');
  });

  it('12: admin metrics expose n8n download counters', async () => {
    await dlApp.request(
      'http://localhost/dl/n8n/guard-sub-workflow',
      { headers: { 'cf-connecting-ip': '203.0.113.1' } },
      env,
    );
    await dlApp.request(
      'http://localhost/dl/n8n/main-ai-agent-flow',
      { headers: { 'cf-connecting-ip': '203.0.113.2' } },
      env,
    );
    await new Promise((r) => setTimeout(r, 15));

    const res = await adminApp.request(
      'http://localhost/admin/metrics',
      { headers: { 'x-admin-key': 'test-admin-key' } },
      env,
    );
    const body = await res.json() as {
      ok: boolean;
      n8n_downloads_24h: number;
      n8n_downloads_7d: number;
      n8n_download_unique_ips_7d: number;
      top_n8n_downloads_7d: Array<{ asset_id: string; downloads: number }>;
    };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.n8n_downloads_24h).toBeGreaterThanOrEqual(2);
    expect(body.n8n_downloads_7d).toBeGreaterThanOrEqual(2);
    expect(body.n8n_download_unique_ips_7d).toBeGreaterThanOrEqual(2);
    expect(body.top_n8n_downloads_7d.length).toBeGreaterThanOrEqual(1);
    expect(body.top_n8n_downloads_7d[0]).toMatchObject({
      asset_id: expect.any(String),
      downloads: expect.any(Number),
    });
  });

  it('13: metrics include n8n-like counts after n8n check', async () => {
    const { apiKey } = await seedWorkspace(billingDo, {
      workspaceId: 'ws-n8n-metrics',
      credits: CREDITS.FREE_TIER,
    });

    await checkApp.request(
      'http://localhost/v1/check',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'user-agent': 'n8n',
        },
        body: JSON.stringify({ agent_id: 'n8n-flow', task_hash: 't1', action: 'tool_call' }),
      },
      env,
    );
    await new Promise((r) => setTimeout(r, 15));

    const metricsRes = await billingDo.fetch(new Request('https://do.internal/usage/metrics'));
    const metrics = await metricsRes.json() as { n8n_like_checks_7d: number; checks_7d: number };
    expect(metrics.n8n_like_checks_7d).toBeGreaterThanOrEqual(1);
    expect(metrics.checks_7d).toBeGreaterThanOrEqual(1);
  });
});
