import type { MiddlewareHandler } from 'hono';
import type { Env, Vars, AppContext } from '../types.js';
import { getApiAuthMode, getSharedApiKey, getAdminApiKey, getAdminMetricsToken } from '../lib/config.js';
import { getRequestApiKey, sha256Hex } from '../lib/utils.js';
import { verifyWorkspaceApiKeyInStore } from '../services/store.js';
import { timingSafeCompare } from '../lib/crypto.js';

export type AuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 404 | 501; error: string };

/**
 * Verify workspace API key against the configured auth mode.
 */
export async function verifyWorkspaceApiKey(
  env: Env,
  workspaceId: string,
  apiKey: string,
): Promise<'ok' | 'unauthorized' | 'not_found' | 'misconfigured'> {
  const mode = getApiAuthMode(env);
  if (mode !== 'workspace') return 'misconfigured';
  if (!workspaceId || !apiKey) return 'unauthorized';

  const apiKeyHash = await sha256Hex(apiKey);
  return verifyWorkspaceApiKeyInStore(env, workspaceId, apiKeyHash);
}

/**
 * Require workspace authentication based on configured auth mode.
 * Returns null if auth passes, or a Response if it fails.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export async function requireWorkspaceAuth(c: AppContext, workspaceId: string): Promise<Response | null> {
  const mode = getApiAuthMode(c.env);
  if (mode === 'off') return null;

  const apiKey = getRequestApiKey(c);

  if (mode === 'shared') {
    const shared = getSharedApiKey(c.env);
    if (!shared) return c.json({ ok: false, error: 'auth_misconfigured' }, 501);
    // Use timing-safe comparison to prevent timing attacks
    const isValid = await timingSafeCompare(apiKey, shared);
    if (!isValid) return c.json({ ok: false, error: 'unauthorized' }, 401);
    return null;
  }

  // workspace mode
  const result = await verifyWorkspaceApiKey(c.env, workspaceId, apiKey);
  if (result === 'ok') return null;
  if (result === 'not_found') return c.json({ ok: false, error: 'workspace_not_found' }, 404);
  return c.json({ ok: false, error: 'unauthorized' }, 401);
}

/**
 * Require admin authentication via X-Admin-Key header.
 * Returns null if auth passes, or a Response if it fails.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export async function requireAdminAuth(c: AppContext): Promise<Response | null> {
  const admin = getAdminApiKey(c.env);
  if (!admin) return c.json({ ok: false, error: 'admin_key_not_configured' }, 501);

  const header = String(c.req.header('x-admin-key') ?? '').trim();
  // Use timing-safe comparison to prevent timing attacks
  const isValid = await timingSafeCompare(header, admin);
  if (!isValid) return c.json({ ok: false, error: 'unauthorized' }, 401);

  return null;
}

/**
 * Admin auth via X-Admin-Key or Authorization: Bearer ADMIN_METRICS_TOKEN.
 */
export async function requireAdminOrMetricsAuth(c: AppContext): Promise<Response | null> {
  const adminErr = await requireAdminAuth(c);
  if (!adminErr) return null;

  const metricsToken = getAdminMetricsToken(c.env);
  if (!metricsToken) return adminErr;

  const auth = String(c.req.header('authorization') ?? '').trim();
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const isValid = await timingSafeCompare(bearer, metricsToken);
  if (!isValid) return adminErr;

  return null;
}

/**
 * Require facilitator key authentication.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export async function requireFacilitatorAuth(c: AppContext): Promise<Response | null> {
  const key = String(c.env.FACILITATOR_KEY ?? '').trim();
  if (!key) return c.json({ ok: false, error: 'facilitator_key_missing' }, 501);

  const auth = String(c.req.header('authorization') ?? '').trim();
  const expected = `Bearer ${key}`;
  // Use timing-safe comparison to prevent timing attacks
  const isValid = await timingSafeCompare(auth, expected);
  if (!isValid) return c.json({ ok: false, error: 'unauthorized' }, 401);

  return null;
}
