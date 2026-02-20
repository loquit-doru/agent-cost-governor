import { Hono } from 'hono';
import type { Env, Vars } from '../types.js';
import { workspaceCreateSchema, workspaceAdminSchema } from '../lib/schemas.js';
import { makeDecisionId, randomApiKey, sha256Hex } from '../lib/utils.js';
import { requireAdminAuth } from '../middleware/auth.js';
import {
  setWorkspaceApiKey,
  deleteWorkspaceApiKey,
  getWorkspaceAuthStatus,
} from '../services/store.js';
import { getBillingStub, doUrl } from '../lib/do.js';

const adminRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

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
  const apiKey = randomApiKey(32);
  const apiKeyHash = await sha256Hex(apiKey);

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
  const apiKey = randomApiKey(32);
  const apiKeyHash = await sha256Hex(apiKey);

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

// Cross-workspace intelligence: global anomaly detection (admin-only)
adminRoutes.get('/v1/admin/anomalies', requireAdminAuth, async (c) => {
  const stub = getBillingStub(c.env);
  const res = await stub.fetch(doUrl('/cross-intel/anomalies'));
  const data = await res.json() as Record<string, unknown>;
  return c.json(data, res.status as 200 | 501);
});

export { adminRoutes };
