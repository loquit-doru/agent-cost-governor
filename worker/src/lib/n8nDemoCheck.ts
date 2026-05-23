import type { Context } from 'hono';
import { z } from 'zod';
import type { Env, Vars } from '../types.js';
import { getBillingStub, doUrl } from './do.js';
import { writeMetric } from '../metrics.js';
import { clientIpFromHeaders, hashIpForUsage } from './usageTracking.js';

/** Same shape as POST /v1/check (easyCheckSchema). */
export const n8nDemoCheckSchema = z.object({
  agent_id: z.string().min(1).max(200),
  task_hash: z.string().min(1).max(200),
  action: z.enum(['model_call', 'tool_call', 'retry', 'override', 'plan_execute']).optional().default('tool_call'),
  step_hash: z.string().max(200).optional(),
});

const DEMO_REPEAT_WINDOW_MS = 120_000;
const DEMO_IP_LIMIT = 40;
const DEMO_IP_WINDOW_MS = 60_000;

type DemoCheckContext = Context<{ Bindings: Env; Variables: Vars }>;

async function distributedRateLimit(
  env: Env,
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean; count: number } | null> {
  try {
    const stub = getBillingStub(env);
    const res = await stub.fetch(doUrl('/rate-limit/check'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, limit, window_ms: windowMs }),
    });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      allowed?: boolean;
      count?: number;
    } | null;
    if (!body || body.ok !== true || typeof body.count !== 'number') return null;
    return { allowed: body.allowed !== false, count: body.count };
  } catch {
    return null;
  }
}

export async function handleN8nDemoCheck(c: DemoCheckContext): Promise<Response> {
  const startMs = Date.now();
  const body = await c.req.json().catch(() => null);
  const parsed = n8nDemoCheckSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { ok: false, demo: true, error: 'invalid_request', issues: parsed.error.issues },
      400,
    );
  }

  const ip = clientIpFromHeaders(c.req.raw.headers);
  const ipHash = (await hashIpForUsage(ip)) ?? 'unknown';
  const { agent_id, task_hash, action, step_hash } = parsed.data;

  const ipBucket = await distributedRateLimit(
    c.env,
    `n8n-demo:ip:${ipHash}`,
    DEMO_IP_LIMIT,
    DEMO_IP_WINDOW_MS,
  );
  if (ipBucket && !ipBucket.allowed) {
    writeMetric(c.env, {
      indexes: ['demo_n8n_rate_limited', agent_id, action, 'ip_cap'],
      doubles: [1, Date.now() - startMs],
    });
    return c.json(
      {
        allowed: false,
        demo: true,
        zone: 'demo_storm',
        error: 'rate_limit_exceeded',
        reason: 'Demo rate limit exceeded. Try again in a minute or create a free workspace for /v1/check.',
      },
      429,
    );
  }

  if (task_hash.toLowerCase().includes('deny')) {
    writeMetric(c.env, {
      indexes: ['demo_n8n_blocked', agent_id, action, 'deny_hint'],
      doubles: [1, Date.now() - startMs],
    });
    return c.json(
      {
        allowed: false,
        demo: true,
        zone: 'demo_storm',
        reason: 'Repeated demo task blocked before mock paid tool.',
      },
      429,
    );
  }

  const repeatKey = `n8n-demo:repeat:${ipHash}:${task_hash}:${action}:${step_hash ?? ''}`;
  const repeatBucket = await distributedRateLimit(
    c.env,
    repeatKey,
    1,
    DEMO_REPEAT_WINDOW_MS,
  );

  if (repeatBucket && (repeatBucket.count > 1 || !repeatBucket.allowed)) {
    writeMetric(c.env, {
      indexes: ['demo_n8n_blocked', agent_id, action, 'repeat_task'],
      doubles: [1, Date.now() - startMs],
    });
    return c.json(
      {
        allowed: false,
        demo: true,
        zone: 'demo_storm',
        reason: 'Repeated demo task blocked before mock paid tool.',
      },
      429,
    );
  }

  writeMetric(c.env, {
    indexes: ['demo_n8n_allowed', agent_id, action, 'demo_safe'],
    doubles: [1, Date.now() - startMs],
  });

  return c.json(
    {
      allowed: true,
      demo: true,
      zone: 'demo_safe',
      hint: 'Demo only — no credits consumed. Use POST /v1/check with a workspace key for production guard.',
    },
    200,
  );
}
