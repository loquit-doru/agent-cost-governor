import type { Env } from '../types.js';
import { getBillingStub, doUrl } from './do.js';
import { sha256Hex } from './utils.js';

export type V1CheckErrorCategory = 'allowed' | 'billing' | 'storm' | 'invalid' | 'other';

export type V1CheckEvent = {
  created_at: string;
  workspace_id: string | null;
  api_key_hash: string | null;
  agent_id: string | null;
  action: string | null;
  step_hash: string | null;
  task_hash: string | null;
  allowed: boolean;
  zone: string | null;
  http_status: number;
  error_category: V1CheckErrorCategory;
  user_agent: string | null;
  ip_hash: string | null;
  request_id: string;
  source: 'v1_check';
};

export type N8nDownloadEvent = {
  created_at: string;
  asset_id: string;
  user_agent: string | null;
  referrer: string | null;
  ip_hash: string | null;
};

const IP_HASH_SALT = 'proceedgate-usage-v1';

export async function hashIpForUsage(ip: string): Promise<string | null> {
  const trimmed = String(ip ?? '').trim();
  if (!trimmed) return null;
  const h = await sha256Hex(`${IP_HASH_SALT}:${trimmed}`);
  return h.slice(0, 16);
}

export function clientIpFromHeaders(headers: {
  get(name: string): string | null;
}): string {
  const cf = headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  const xff = headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]?.trim() ?? '';
  return '';
}

export function categorizeV1CheckStatus(httpStatus: number, allowed?: boolean): V1CheckErrorCategory {
  if (httpStatus === 400) return 'invalid';
  if (httpStatus === 402) return 'billing';
  if (httpStatus === 429) return 'storm';
  if (httpStatus === 200 && allowed === true) return 'allowed';
  if (httpStatus === 200 && allowed === false) return 'other';
  if (httpStatus >= 400) return 'other';
  return 'allowed';
}

export function isN8nLike(agentId: string | null, userAgent: string | null): boolean {
  if (agentId?.startsWith('n8n-')) return true;
  return (userAgent ?? '').toLowerCase().includes('n8n');
}

export async function appendV1CheckEvent(env: Env, event: V1CheckEvent): Promise<void> {
  const stub = getBillingStub(env);
  await stub.fetch(doUrl('/usage/v1-check'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });
}

export async function appendN8nDownloadEvent(env: Env, event: N8nDownloadEvent): Promise<void> {
  const stub = getBillingStub(env);
  await stub.fetch(doUrl('/usage/n8n-download'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });
}

export async function fetchUsageMetrics(env: Env): Promise<Record<string, unknown>> {
  const stub = getBillingStub(env);
  const res = await stub.fetch(doUrl('/usage/metrics'));
  if (!res.ok) {
    throw new Error(`usage_metrics_failed:${res.status}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export function scheduleBackgroundTask(
  executionCtx: { waitUntil: (p: Promise<unknown>) => void } | undefined,
  task: () => Promise<unknown>,
): void {
  const run = () => task().catch(() => {});
  if (executionCtx?.waitUntil) {
    executionCtx.waitUntil(run());
    return;
  }
  void run();
}

export function scheduleV1CheckLog(
  executionCtx: { waitUntil: (p: Promise<unknown>) => void } | undefined,
  env: Env,
  build: () => Promise<V1CheckEvent>,
): void {
  scheduleBackgroundTask(executionCtx, () =>
    build().then((event) => appendV1CheckEvent(env, event)),
  );
}

export function tryExecutionCtx(c: {
  executionCtx: { waitUntil: (p: Promise<unknown>) => void };
}): { waitUntil: (p: Promise<unknown>) => void } | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}
