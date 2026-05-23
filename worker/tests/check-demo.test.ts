import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import { checkRoutes } from '../src/routes/check.js';
import { dlRoutes } from '../src/routes/dl.js';
import { BillingStoreDO } from '../src/billingStoreDO.js';
import { CREDITS } from '../src/lib/constants.js';
import type { Env, Vars } from '../src/types.js';
import { createMockDOState } from './helpers/mockDoState.js';

const checkApp = new Hono<{ Bindings: Env; Variables: Vars }>();
checkApp.route('/', checkRoutes);

const dlApp = new Hono<{ Bindings: Env; Variables: Vars }>();
dlApp.route('/', dlRoutes);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const demoWorkflowPath = join(repoRoot, 'examples', 'n8n', 'proceedgate-demo-no-account.json');

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

const demoPayload = {
  agent_id: 'n8n-demo',
  task_hash: 'quickstart-repeat-demo',
  action: 'tool_call' as const,
  step_hash: 'mock_paid_tool',
};

async function postDemoCheck(
  env: Env,
  body: Record<string, unknown> = demoPayload,
  headers: Record<string, string> = { 'cf-connecting-ip': '203.0.113.50' },
) {
  return checkApp.request(
    'http://localhost/v1/check/demo',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe('POST /v1/check/demo', () => {
  let billingDo: BillingStoreDO;
  let env: Env;
  let taskCounter = 0;

  beforeEach(() => {
    billingDo = new BillingStoreDO(createMockDOState(), {});
    env = createBillingEnv(billingDo);
    taskCounter += 1;
  });

  it('allows first request without Authorization', async () => {
    const res = await postDemoCheck(env, {
      ...demoPayload,
      task_hash: `demo-first-${taskCounter}`,
    });
    const body = await res.json() as {
      allowed: boolean;
      demo: boolean;
      zone: string;
      proceed_token?: string;
    };

    expect(res.status).toBe(200);
    expect(body.allowed).toBe(true);
    expect(body.demo).toBe(true);
    expect(body.zone).toBe('demo_safe');
    expect(body.proceed_token).toBeUndefined();
  });

  it('blocks repeated same task_hash with demo_storm', async () => {
    const task = `demo-repeat-${taskCounter}`;
    const payload = { ...demoPayload, task_hash: task };
    const first = await postDemoCheck(env, payload);
    expect(first.status).toBe(200);

    const second = await postDemoCheck(env, payload);
    const body = await second.json() as {
      allowed: boolean;
      demo: boolean;
      zone: string;
      reason?: string;
      proceed_token?: string;
    };

    expect(second.status).toBe(429);
    expect(body.allowed).toBe(false);
    expect(body.demo).toBe(true);
    expect(body.zone).toBe('demo_storm');
    expect(body.reason).toContain('Repeated demo task blocked');
    expect(body.proceed_token).toBeUndefined();
  });

  it('blocks task_hash containing deny without repeat state', async () => {
    const res = await postDemoCheck(env, {
      ...demoPayload,
      task_hash: `quickstart-deny-demo-${taskCounter}`,
    });
    const body = await res.json() as { allowed: boolean; zone: string };

    expect(res.status).toBe(429);
    expect(body.allowed).toBe(false);
    expect(body.zone).toBe('demo_storm');
  });

  it('does not consume workspace credits', async () => {
    const wsId = 'ws-demo-credits-untouched';
    await billingDo.fetch(
      new Request('https://do.internal/workspaces/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspace_id: wsId,
          api_key_hash: 'a'.repeat(64),
          plan: 'free',
          credits: CREDITS.FREE_TIER,
          expires_at_ms: Date.now() + 86_400_000,
        }),
      }),
    );

    await postDemoCheck(env, { ...demoPayload, task_hash: `no-consume-${taskCounter}` });

    const balRes = await billingDo.fetch(new Request(`https://do.internal/workspaces/${wsId}`));
    const bal = await balRes.json() as { credits: number };
    expect(bal.credits).toBe(CREDITS.FREE_TIER);
  });

  it('no-account demo workflow JSON parses and targets demo endpoint', () => {
    const raw = readFileSync(demoWorkflowPath, 'utf8');
    const wf = JSON.parse(raw) as {
      nodes: Array<{ name: string; parameters?: { url?: string; options?: unknown } }>;
    };
    expect(wf.nodes.some((n) => n.name === 'Manual Trigger')).toBe(true);
    expect(wf.nodes.some((n) => n.name === 'ProceedGate Demo Check')).toBe(true);
    const http = wf.nodes.find((n) => n.name === 'ProceedGate Demo Check');
    expect(http?.parameters?.url).toBe('https://governor.proceedgate.dev/v1/check/demo');
    expect(JSON.stringify(http?.parameters?.options ?? {})).toContain('neverError');
  });
});

describe('GET /dl/n8n/proceedgate-demo-no-account', () => {
  let billingDo: BillingStoreDO;
  let env: Env;

  beforeEach(() => {
    billingDo = new BillingStoreDO(createMockDOState(), {});
    env = createBillingEnv(billingDo);
  });

  it('redirects to raw GitHub JSON', async () => {
    const res = await dlApp.request(
      'http://localhost/dl/n8n/proceedgate-demo-no-account',
      { headers: { 'cf-connecting-ip': '203.0.113.1' } },
      env,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toBe(
      'https://raw.githubusercontent.com/loquit-doru/agent-cost-governor/main/examples/n8n/proceedgate-demo-no-account.json',
    );
  });

  it('logs download for metrics aggregation', async () => {
    const res = await dlApp.request(
      'http://localhost/dl/n8n/proceedgate-demo-no-account',
      { headers: { 'cf-connecting-ip': '203.0.113.2' } },
      env,
    );
    expect(res.status).toBe(302);
    await new Promise((r) => setTimeout(r, 10));
    const day = new Date().toISOString().slice(0, 10);
    const state = (billingDo as unknown as {
      state: {
        storage: {
          get: (k: string) => Promise<Array<{ asset_id: string }> | undefined>;
        };
      };
    }).state;
    const downloads = await state.storage.get(`n8n_download:${day}`);
    expect(downloads?.some((d) => d.asset_id === 'proceedgate-demo-no-account')).toBe(true);
  });
});
