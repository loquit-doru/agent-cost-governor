/**
 * /v1/governor/session — Cumulative session-based budget tracking.
 *
 * Inspired by MPP voucher accumulation pattern:
 * Agent opens a session with a budget → runs checks → cumulative spend tracked → session closes.
 */

import { Hono } from 'hono';
import type { Env, Vars } from '../types.js';
import { billingRequest } from '../lib/do.js';
import { requireWorkspaceAuth } from '../middleware/auth.js';
import { getRequestApiKey, sha256Hex } from '../lib/utils.js';
import { getApiAuthMode } from '../lib/config.js';

const sessionRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

/**
 * Resolve workspace ID from API key (same pattern as check.ts).
 */
async function resolveWorkspaceId(env: Env, apiKey: string): Promise<string | null> {
  const mode = getApiAuthMode(env);
  if (mode !== 'workspace') return null;
  const keyHash = await sha256Hex(apiKey);
  const res = await billingRequest<{ ok: boolean; workspace_id?: string }>(
    env, `/keys/lookup`, { method: 'POST', body: { api_key_hash: keyHash } },
  );
  return res.ok ? res.data.workspace_id ?? null : null;
}

/** POST /v1/governor/session — Open a new session */
sessionRoutes.post('/v1/governor/session', async (c) => {
  const apiKey = getRequestApiKey(c);
  let workspaceId = await resolveWorkspaceId(c.env, apiKey);

  if (!workspaceId) {
    const authErr = await requireWorkspaceAuth(c, '');
    if (authErr) return authErr;
    // Auth passed (mode=off or shared) but no workspace — use default
    workspaceId = 'default';
  }

  const body = await c.req.json<{
    agent_id: string;
    budget_usd: string;
    duration_hours?: number;
  }>().catch(() => null);

  if (!body?.agent_id || !body?.budget_usd) {
    return c.json({ ok: false, error: 'missing_fields', issues: ['agent_id and budget_usd are required'] }, 400);
  }

  const budget = parseFloat(body.budget_usd);
  if (isNaN(budget) || budget <= 0) {
    return c.json({ ok: false, error: 'invalid_budget', issues: ['budget_usd must be a positive number'] }, 400);
  }

  const sessionId = `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const res = await billingRequest<{
    ok: boolean;
    session?: { sessionId: string; budgetLimitUsd: string; expiresAtMs: number };
    error?: string;
  }>(c.env, '/sessions', {
    method: 'POST',
    body: {
      session_id: sessionId,
      workspace_id: workspaceId,
      agent_id: body.agent_id,
      budget_usd: body.budget_usd,
      duration_hours: body.duration_hours ?? 24,
    },
  });

  if (!res.ok) {
    return c.json({ ok: false, error: res.data.error ?? 'session_create_failed' }, res.status as 400);
  }

  const session = res.data.session!;
  return c.json({
    ok: true,
    session_id: session.sessionId,
    budget_usd: session.budgetLimitUsd,
    expires_at: new Date(session.expiresAtMs).toISOString(),
  }, 201);
});

/** GET /v1/governor/session/:sessionId — Get session status */
sessionRoutes.get('/v1/governor/session/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');

  const res = await billingRequest<{
    ok: boolean;
    session?: {
      sessionId: string;
      agentId: string;
      budgetLimitUsd: string;
      totalSpentUsd: string;
      remainingUsd: string;
      requestCount: number;
      status: string;
      expiresAtMs: number;
      createdAtMs: number;
    };
    error?: string;
  }>(c.env, `/sessions/${sessionId}`);

  if (!res.ok) {
    return c.json({ ok: false, error: res.data.error ?? 'not_found' }, 404);
  }

  const s = res.data.session!;
  return c.json({
    ok: true,
    session_id: s.sessionId,
    agent_id: s.agentId,
    status: s.status,
    budget_usd: s.budgetLimitUsd,
    total_spent_usd: s.totalSpentUsd,
    remaining_usd: s.remainingUsd,
    request_count: s.requestCount,
    expires_at: new Date(s.expiresAtMs).toISOString(),
    created_at: new Date(s.createdAtMs).toISOString(),
  });
});

/** DELETE /v1/governor/session/:sessionId — Close/settle session */
sessionRoutes.delete('/v1/governor/session/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');

  const res = await billingRequest<{
    ok: boolean;
    session_id?: string;
    final_spent_usd?: string;
    request_count?: number;
    error?: string;
  }>(c.env, `/sessions/${sessionId}`, { method: 'DELETE' });

  if (!res.ok) {
    return c.json({ ok: false, error: res.data.error ?? 'not_found' }, 404);
  }

  return c.json({
    ok: true,
    session_id: res.data.session_id,
    final_spent_usd: res.data.final_spent_usd,
    request_count: res.data.request_count,
    status: 'closed',
  });
});

export { sessionRoutes };
