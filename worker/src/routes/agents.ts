/**
 * Agent Identity endpoints
 *
 * GET /v1/agents/:id           — profile + reputation for a specific agent
 * GET /v1/agents               — paginated list of all known agents
 *
 * Authentication: requires a valid workspace API key (any workspace).
 */

import { Hono } from 'hono';
import type { Env, Vars } from '../types.js';
import { getBillingStub, doUrl } from '../lib/do.js';
import { requireAdminAuth } from '../middleware/auth.js';

const agentsRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

// GET /v1/agents — list all agents (admin only)
agentsRoutes.get('/v1/agents', async (c) => {
  const authErr = await requireAdminAuth(c);
  if (authErr) return authErr;

  const cursor = c.req.query('cursor') ?? '';
  const stub = getBillingStub(c.env);

  const res = await stub.fetch(doUrl(`/agents?cursor=${encodeURIComponent(cursor)}`), {
    method: 'GET',
  }).catch(() => null);

  if (!res?.ok) {
    return c.json({ ok: false, error: 'agent_list_failed' }, 502);
  }

  const data = await res.json();
  return c.json(data, 200);
});

// GET /v1/agents/:id — profile + reputation for a single agent (admin only)
agentsRoutes.get('/v1/agents/:id', async (c) => {
  const authErr = await requireAdminAuth(c);
  if (authErr) return authErr;

  const agentId = c.req.param('id');
  if (!agentId || agentId.length > 200) {
    return c.json({ ok: false, error: 'invalid_agent_id' }, 400);
  }

  const stub = getBillingStub(c.env);

  const [profileRes, repRes] = await Promise.all([
    stub.fetch(doUrl(`/agents/${agentId}/profile`)).catch(() => null),
    stub.fetch(doUrl(`/agents/${agentId}/reputation`)).catch(() => null),
  ]);

  if (!profileRes?.ok) {
    if (profileRes?.status === 404) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404);
    }
    return c.json({ ok: false, error: 'agent_fetch_failed' }, 502);
  }

  const profileData = await profileRes.json() as { ok: boolean; profile: unknown };
  const repData = repRes?.ok ? await repRes.json() as { ok: boolean; reputation: unknown } : null;

  return c.json({
    ok: true,
    profile: profileData.profile,
    reputation: repData?.reputation ?? null,
  }, 200);
});

export { agentsRoutes };
