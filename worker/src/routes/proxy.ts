/**
 * Proxy Mode — Zero-code integration for OpenAI/Anthropic-compatible APIs.
 * 
 * Usage:
 *   const client = new OpenAI({
 *     baseURL: 'https://governor.proceedgate.dev/proxy/openai',
 *     apiKey: 'pg_ws_...', // ProceedGate workspace API key
 *   });
 * 
 * Every request is automatically checked against the workspace budget,
 * loop detection, and custom policies. The `X-Upstream-Api-Key` header
 * carries the real provider API key.
 * 
 * Supported upstreams:
 *   /proxy/openai/*   → https://api.openai.com/*
 *   /proxy/anthropic/* → https://api.anthropic.com/*
 *   /proxy/custom      → any upstream via X-Upstream-Url header
 */

import { Hono } from 'hono';
import type { Env, Vars } from '../types.js';
import { getBillingStub, doUrl } from '../lib/do.js';
import { hashApiKey } from '../lib/crypto.js';
import { consumeWorkspaceCredits } from '../services/store.js';
import { logEvent, actorKey } from '../observability.js';
import { writeMetric } from '../metrics.js';
import { API_KEY_PREFIXES } from '../lib/constants.js';
import { computeLLMCostPrice } from '../lib/pricing.js';

const proxyRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

// Upstream provider configs
const UPSTREAMS: Record<string, { baseUrl: string; authHeader: string }> = {
  openai: { baseUrl: 'https://api.openai.com', authHeader: 'Authorization' },
  anthropic: { baseUrl: 'https://api.anthropic.com', authHeader: 'x-api-key' },
};

/**
 * Extract workspace API key and upstream API key from request.
 * ProceedGate key: Authorization: Bearer pg_ws_...
 * Upstream key: X-Upstream-Api-Key: sk-...
 */
function extractKeys(c: { req: { header: (name: string) => string | undefined } }) {
  const authHeader = c.req.header('Authorization');
  const pgKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const upstreamKey = c.req.header('X-Upstream-Api-Key') ?? null;
  return { pgKey, upstreamKey };
}

// Proxy handler for known upstreams
for (const [provider, config] of Object.entries(UPSTREAMS)) {
  proxyRoutes.all(`/proxy/${provider}/*`, async (c) => {
    const startMs = Date.now();
    const { pgKey, upstreamKey } = extractKeys(c);

    if (!pgKey?.startsWith(API_KEY_PREFIXES.WORKSPACE)) {
      return c.json({
        error: 'missing_pg_api_key',
        hint: `Set Authorization: Bearer pg_ws_... (ProceedGate key). Pass provider key in X-Upstream-Api-Key header.`,
      }, 401);
    }

    if (!upstreamKey) {
      return c.json({
        error: 'missing_upstream_key',
        hint: `Set X-Upstream-Api-Key header with your ${provider} API key.`,
      }, 401);
    }

    // 1. Look up workspace from PG API key
    const apiKeyHash = await hashApiKey(pgKey);
    const stub = getBillingStub(c.env);
    const lookupRes = await stub.fetch(doUrl('/keys/lookup'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key_hash: apiKeyHash }),
    });

    if (!lookupRes.ok) {
      return c.json({ error: 'workspace_not_found' }, 404);
    }

    const { workspace_id: workspaceId } = await lookupRes.json() as { workspace_id: string };

    // 2. Extract model from request body (for LLM cost tracking)
    let bodyText: string | null = null;
    let bodyJson: Record<string, unknown> | null = null;
    const contentType = c.req.header('content-type') ?? '';
    if (contentType.includes('json')) {
      bodyText = await c.req.text();
      try { bodyJson = JSON.parse(bodyText); } catch { /* skip */ }
    }

    const model = (bodyJson?.model as string) ?? 'unknown';
    const action = `llm_call`;

    // 3. Consume credits + check budget (1 credit per proxy call)
    const consumed = await consumeWorkspaceCredits(c.env, workspaceId, 1, { action });
    if (!consumed.ok) {
      writeMetric(c.env, {
        indexes: ['proxy_blocked', provider, model, consumed.error],
        doubles: [1, Date.now() - startMs],
      });
      return c.json({
        error: 'insufficient_credits',
        workspace_id: workspaceId,
        credits_remaining: consumed.credits,
        message: '🚫 Proxy blocked: insufficient credits.',
        upgrade: { quote_url: `/v1/billing/quote?workspace_id=${encodeURIComponent(workspaceId)}&credits=10000` },
      }, 402);
    }

    // 4. Forward to upstream
    const subPath = c.req.path.replace(`/proxy/${provider}`, '');
    const upstreamUrl = `${config.baseUrl}${subPath}`;

    // Build upstream headers (forward everything except PG-specific)
    const upstreamHeaders = new Headers();
    for (const [key, value] of Object.entries(c.req.header())) {
      if (typeof value !== 'string') continue;
      const lower = key.toLowerCase();
      if (lower === 'host' || lower === 'x-upstream-api-key' || lower === 'authorization') continue;
      upstreamHeaders.set(key, value);
    }

    // Set upstream auth
    if (provider === 'openai') {
      upstreamHeaders.set('Authorization', `Bearer ${upstreamKey}`);
    } else if (provider === 'anthropic') {
      upstreamHeaders.set('x-api-key', upstreamKey);
    }

    const upstreamRes = await fetch(upstreamUrl, {
      method: c.req.method,
      headers: upstreamHeaders,
      body: bodyText ?? undefined,
    });

    // 5. Compute LLM cost for tracking and log it
    const priceInfo = computeLLMCostPrice(c.env, { model });

    logEvent({
      event: 'proxy_forwarded',
      workspace_id: workspaceId,
      provider,
      model,
      upstream_status: upstreamRes.status,
      cost_estimate: priceInfo.explain,
    });

    writeMetric(c.env, {
      indexes: ['proxy_ok', provider, model, String(upstreamRes.status)],
      doubles: [1, Date.now() - startMs],
    });

    // 6. Stream response back with added ProceedGate headers
    const responseHeaders = new Headers(upstreamRes.headers);
    responseHeaders.set('X-Proceedgate-Proxy', 'true');
    responseHeaders.set('X-Proceedgate-Provider', provider);
    responseHeaders.set('X-Proceedgate-Model', model);
    responseHeaders.set('X-Proceedgate-Workspace', workspaceId);
    responseHeaders.set('X-Proceedgate-Credits-Remaining', String(consumed.credits));

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: responseHeaders,
    });
  });
}

export { proxyRoutes };
