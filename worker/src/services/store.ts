import type { Env } from '../types.js';
import type { DecisionRecord } from '../decisionStoreDO.js';
import type { BillingQuoteRecord } from '../billingStoreDO.js';

// ============================================================================
// Durable Object Stubs
// ============================================================================

function getDecisionStoreStub(env: Env): DurableObjectStub {
  const id = env.DECISIONS.idFromName('decision-store');
  return env.DECISIONS.get(id);
}

function getBillingStoreStub(env: Env): DurableObjectStub {
  const id = env.BILLING.idFromName('billing-store');
  return env.BILLING.get(id);
}

// ============================================================================
// Decision Store Operations
// ============================================================================

export async function putDecisionRecord(env: Env, record: DecisionRecord): Promise<void> {
  const stub = getDecisionStoreStub(env);
  const url = new URL(`/decisions/${encodeURIComponent(record.decisionId)}`, 'https://do.internal');
  const res = await stub.fetch(url.toString(), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ record }),
  });
  if (!res.ok) throw new Error(`decision_store_put_failed status=${res.status}`);
}

export async function getDecisionRecord(env: Env, decisionId: string): Promise<DecisionRecord | null> {
  const stub = getDecisionStoreStub(env);
  const url = new URL(`/decisions/${encodeURIComponent(decisionId)}`, 'https://do.internal');
  const res = await stub.fetch(url.toString(), { method: 'GET' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`decision_store_get_failed status=${res.status}`);
  const body = (await res.json().catch(() => null)) as { record?: DecisionRecord } | null;
  return body?.record ?? null;
}

export async function deleteDecisionRecord(env: Env, decisionId: string): Promise<void> {
  const stub = getDecisionStoreStub(env);
  const url = new URL(`/decisions/${encodeURIComponent(decisionId)}`, 'https://do.internal');
  const res = await stub.fetch(url.toString(), { method: 'DELETE' });
  if (!res.ok) throw new Error(`decision_store_delete_failed status=${res.status}`);
}

// ============================================================================
// Billing Store Operations
// ============================================================================

export async function putBillingQuote(env: Env, record: BillingQuoteRecord): Promise<void> {
  const stub = getBillingStoreStub(env);
  const url = new URL(`/quotes/${encodeURIComponent(record.quoteId)}`, 'https://do.internal');
  const res = await stub.fetch(url.toString(), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ record }),
  });
  if (!res.ok) throw new Error(`billing_quote_put_failed status=${res.status}`);
}

export async function getBillingQuote(env: Env, quoteId: string): Promise<BillingQuoteRecord | null> {
  const stub = getBillingStoreStub(env);
  const url = new URL(`/quotes/${encodeURIComponent(quoteId)}`, 'https://do.internal');
  const res = await stub.fetch(url.toString(), { method: 'GET' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`billing_quote_get_failed status=${res.status}`);
  const body = (await res.json().catch(() => null)) as { record?: BillingQuoteRecord } | null;
  return body?.record ?? null;
}

export type BillingRedeemStatus = 400 | 402 | 404 | 409 | 500 | 502;

export async function redeemBillingQuote(
  env: Env,
  quoteId: string,
  txHash: string,
): Promise<{ ok: true; credits: number } | { ok: false; status: BillingRedeemStatus; error: string; credits?: number }> {
  const stub = getBillingStoreStub(env);
  const url = new URL(`/quotes/${encodeURIComponent(quoteId)}/redeem`, 'https://do.internal');
  const res = await stub.fetch(url.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tx_hash: txHash }),
  });

  const body = (await res.json().catch(() => null)) as { ok?: unknown; credits?: unknown; error?: unknown } | null;
  if (res.ok && body?.ok === true && typeof body.credits === 'number') {
    return { ok: true, credits: body.credits };
  }

  const err =
    typeof body?.error === 'string' && body.error ? body.error : res.status === 409 ? 'conflict' : 'redeem_failed';
  const credits = typeof body?.credits === 'number' ? body.credits : undefined;

  const safeStatus: BillingRedeemStatus =
    res.status === 400 || res.status === 402 || res.status === 404 || res.status === 409 || res.status === 500
      ? res.status
      : 502;

  return { ok: false, status: safeStatus, error: err, credits };
}

export async function getWorkspaceCredits(env: Env, workspaceId: string): Promise<number> {
  const stub = getBillingStoreStub(env);
  const url = new URL(`/workspaces/${encodeURIComponent(workspaceId)}`, 'https://do.internal');
  const res = await stub.fetch(url.toString(), { method: 'GET' });
  if (!res.ok) throw new Error(`billing_workspace_get_failed status=${res.status}`);
  const body = (await res.json().catch(() => null)) as { credits?: unknown } | null;
  return typeof body?.credits === 'number' ? body.credits : 0;
}

export async function consumeWorkspaceCredits(
  env: Env,
  workspaceId: string,
  n: number,
): Promise<{ ok: true; credits: number } | { ok: false; status: number; error: string; credits: number }> {
  const stub = getBillingStoreStub(env);
  const url = new URL(`/workspaces/${encodeURIComponent(workspaceId)}/consume`, 'https://do.internal');
  const res = await stub.fetch(url.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ n }),
  });
  const body = (await res.json().catch(() => null)) as { ok?: unknown; credits?: unknown; error?: unknown } | null;
  const credits = typeof body?.credits === 'number' ? body.credits : 0;
  if (res.ok && body?.ok === true) return { ok: true, credits };
  const err = typeof body?.error === 'string' && body.error ? body.error : 'consume_failed';
  return { ok: false, status: res.status, error: err, credits };
}

// ============================================================================
// Workspace Auth Operations
// ============================================================================

export async function setWorkspaceApiKey(env: Env, workspaceId: string, apiKeyHash: string): Promise<boolean> {
  const stub = getBillingStoreStub(env);
  const url = new URL(`/workspaces/${encodeURIComponent(workspaceId)}/key`, 'https://do.internal');
  const res = await stub.fetch(url.toString(), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key_hash: apiKeyHash }),
  });
  return res.ok;
}

export async function deleteWorkspaceApiKey(env: Env, workspaceId: string): Promise<boolean> {
  const stub = getBillingStoreStub(env);
  const url = new URL(`/workspaces/${encodeURIComponent(workspaceId)}/key`, 'https://do.internal');
  const res = await stub.fetch(url.toString(), { method: 'DELETE' });
  return res.ok;
}

export async function getWorkspaceAuthStatus(
  env: Env,
  workspaceId: string,
): Promise<{ found: boolean; hasKey?: boolean; createdAt?: string; updatedAt?: string }> {
  const stub = getBillingStoreStub(env);
  const url = new URL(`/workspaces/${encodeURIComponent(workspaceId)}/auth`, 'https://do.internal');
  const res = await stub.fetch(url.toString(), { method: 'GET' });

  if (res.status === 404) return { found: false };
  if (!res.ok) throw new Error(`workspace_auth_status_failed status=${res.status}`);

  const body = (await res.json().catch(() => null)) as {
    workspace_id?: unknown;
    has_key?: unknown;
    created_at?: unknown;
    updated_at?: unknown;
  } | null;

  return {
    found: true,
    hasKey: body?.has_key === true,
    createdAt: typeof body?.created_at === 'string' ? body.created_at : undefined,
    updatedAt: typeof body?.updated_at === 'string' ? body.updated_at : undefined,
  };
}

export async function verifyWorkspaceApiKeyInStore(
  env: Env,
  workspaceId: string,
  apiKeyHash: string,
): Promise<'ok' | 'unauthorized' | 'not_found'> {
  const stub = getBillingStoreStub(env);
  const url = new URL(`/workspaces/${encodeURIComponent(workspaceId)}/verify`, 'https://do.internal');
  const res = await stub.fetch(url.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key_hash: apiKeyHash }),
  });

  if (res.ok) return 'ok';
  if (res.status === 401) return 'unauthorized';
  if (res.status === 404) return 'not_found';
  return 'unauthorized';
}
