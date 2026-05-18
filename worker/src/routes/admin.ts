import { Hono } from 'hono';
import type { Env, Vars } from '../types.js';
import { workspaceCreateSchema, workspaceAdminSchema } from '../lib/schemas.js';
import { makeDecisionId } from '../lib/utils.js';
import { hashApiKey } from '../lib/crypto.js';
import { requireAdminAuth, requireAdminOrMetricsAuth } from '../middleware/auth.js';
import { fetchUsageMetrics } from '../lib/usageTracking.js';
import {
  setWorkspaceApiKey,
  deleteWorkspaceApiKey,
  getWorkspaceAuthStatus,
} from '../services/store.js';
import { getBillingStub, doUrl } from '../lib/do.js';

const adminRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

function makeApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return 'pg_ws_' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Create workspace
adminRoutes.post('/v1/workspaces/create', async (c) => {
  const authErr = await requireAdminAuth(c);
  if (authErr) return authErr;

  const body = await c.req.json().catch(() => null);
  const parsed = workspaceCreateSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ ok: false, error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const workspaceId = parsed.data.workspace_id?.trim() || makeDecisionId().replace(/^dec_/, 'ws_');
  const apiKey = makeApiKey();
  const apiKeyHash = await hashApiKey(apiKey);

  const ok = await setWorkspaceApiKey(c.env, workspaceId, apiKeyHash);
  if (!ok) {
    return c.json({ ok: false, error: 'workspace_create_failed' }, 502);
  }

  return c.json({ ok: true, workspace_id: workspaceId, api_key: apiKey }, 200);
});

// Rotate workspace API key
adminRoutes.post('/v1/workspaces/rotate_key', async (c) => {
  const authErr = await requireAdminAuth(c);
  if (authErr) return authErr;

  const body = await c.req.json().catch(() => null);
  const parsed = workspaceAdminSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ ok: false, error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const workspaceId = parsed.data.workspace_id.trim();
  const apiKey = makeApiKey();
  const apiKeyHash = await hashApiKey(apiKey);

  const ok = await setWorkspaceApiKey(c.env, workspaceId, apiKeyHash);
  if (!ok) {
    return c.json({ ok: false, error: 'workspace_rotate_failed' }, 502);
  }

  return c.json({ ok: true, workspace_id: workspaceId, api_key: apiKey }, 200);
});

// Revoke workspace API key
adminRoutes.post('/v1/workspaces/revoke_key', async (c) => {
  const authErr = await requireAdminAuth(c);
  if (authErr) return authErr;

  const body = await c.req.json().catch(() => null);
  const parsed = workspaceAdminSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ ok: false, error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const workspaceId = parsed.data.workspace_id.trim();
  const ok = await deleteWorkspaceApiKey(c.env, workspaceId);

  if (!ok) {
    return c.json({ ok: false, error: 'workspace_revoke_failed' }, 502);
  }

  return c.json({ ok: true, workspace_id: workspaceId, revoked: true }, 200);
});

// Get workspace status
adminRoutes.get('/v1/workspaces/status', async (c) => {
  const authErr = await requireAdminAuth(c);
  if (authErr) return authErr;

  const workspaceId = String(c.req.query('workspace_id') ?? '').trim();
  if (!workspaceId) {
    return c.json({ ok: false, error: 'missing_workspace_id' }, 400);
  }

  const status = await getWorkspaceAuthStatus(c.env, workspaceId);

  return c.json(
    {
      ok: true,
      workspace_id: workspaceId,
      has_key: status.found ? status.hasKey : false,
      created_at: status.createdAt,
      updated_at: status.updatedAt,
    },
    200,
  );
});

adminRoutes.get('/admin/metrics', async (c) => {
  const authErr = await requireAdminOrMetricsAuth(c);
  if (authErr) return authErr;

  try {
    const metrics = await fetchUsageMetrics(c.env);
    return c.json({ ok: true, ...metrics }, 200);
  } catch {
    return c.json({ ok: false, error: 'metrics_unavailable' }, 500);
  }
});

// Cross-workspace intelligence: global anomaly detection (admin-only)
adminRoutes.get('/v1/admin/anomalies', requireAdminAuth, async (c) => {
  const stub = getBillingStub(c.env);
  const res = await stub.fetch(doUrl('/cross-intel/anomalies'));
  const data = await res.json() as Record<string, unknown>;
  return c.json(data, res.status as 200 | 501);
});

// Register email index manually (for backfilling old signups)
adminRoutes.post('/v1/admin/email-index', async (c) => {
  const authErr = await requireAdminAuth(c);
  if (authErr) return authErr;
  const body = await c.req.json().catch(() => null) as { email?: string; workspace_id?: string } | null;
  if (!body?.email || !body?.workspace_id) {
    return c.json({ ok: false, error: 'missing email or workspace_id' }, 400);
  }
  const stub = getBillingStub(c.env);
  const res = await stub.fetch(doUrl('/email-index'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: body.email, workspace_id: body.workspace_id }),
  });
  return c.json({ ok: res.ok }, res.ok ? 200 : 502);
});

// Look up email index (debugging)
adminRoutes.get('/v1/admin/email-index', async (c) => {
  const authErr = await requireAdminAuth(c);
  if (authErr) return authErr;
  const email = c.req.query('email');
  if (!email) return c.json({ ok: false, error: 'missing email' }, 400);
  const stub = getBillingStub(c.env);
  const res = await stub.fetch(doUrl('/email-index/lookup'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: email.toLowerCase() }),
  });
  const data = await res.json() as Record<string, unknown>;
  return c.json({ ok: res.ok, ...data }, res.ok ? 200 : 404);
});

// Test email sending — returns raw Resend response for debugging
adminRoutes.post('/v1/admin/test-email', async (c) => {
  const authErr = await requireAdminAuth(c);
  if (authErr) return authErr;
  const body = await c.req.json().catch(() => null) as { to?: string } | null;
  if (!body?.to) return c.json({ ok: false, error: 'missing to' }, 400);

  const env = c.env as Env & { RESEND_API_KEY?: string };
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return c.json({ ok: false, error: 'RESEND_API_KEY not set' }, 500);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'ProceedGate <billing@proceedgate.dev>',
      to: [body.to],
      subject: 'ProceedGate test email',
      text: 'If you received this, Resend is working correctly.',
      html: '<p>If you received this, Resend is working correctly.</p>',
    }),
  });

  const data = await res.text();
  return c.json({ ok: res.ok, status: res.status, resend_response: data });
});

export { adminRoutes };
