import { Hono } from 'hono';
import type { Env, Vars } from '../types.js';
import { checkSchema } from '../lib/schemas.js';
import { computeRetryFrictionPrice, computeLowConfidencePrice } from '../lib/pricing.js';
import { getBillingMode, getX402Price, getX402Chain, getX402Recipient } from '../lib/config.js';
import { makeDecisionId, setProceedgateHeaders } from '../lib/utils.js';
import { signProceedToken } from '../services/signing.js';
import { putDecisionRecord, consumeWorkspaceCredits } from '../services/store.js';
import { requireWorkspaceAuth } from '../middleware/auth.js';
import { logEvent, actorKey } from '../observability.js';
import { writeMetric } from '../metrics.js';
import { webhookCreditsLow } from '../services/webhook.js';
import { getBillingStub, doUrl } from '../lib/do.js';
import { hashApiKey } from '../lib/crypto.js';
import { API_KEY_PREFIXES } from '../lib/constants.js';
import { generateReasoning } from '../lib/aiReasoning.js';

const checkRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

checkRoutes.post('/v1/governor/check', async (c) => {
  const startMs = Date.now();
  const origin = new URL(c.req.url).origin;
  const body = await c.req.json().catch(() => null);
  const parsed = checkSchema.safeParse(body);

  if (!parsed.success) {
    writeMetric(c.env, {
      indexes: ['check_invalid', 'unknown', 'unknown', 'invalid_request'],
      doubles: [1, Date.now() - startMs],
    });
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const billingMode = getBillingMode(c.env);
  if (billingMode === 'credits') {
    const workspaceId = parsed.data.actor.project?.trim() || parsed.data.actor.id;

    const authErr = await requireWorkspaceAuth(c, workspaceId);
    if (authErr) return authErr;

    // Loop detection - check if this action pattern is repeating too fast
    const stub = getBillingStub(c.env);
    const patternHash = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`${parsed.data.action}:${parsed.data.context.task_hash || ''}:${parsed.data.context.step_hash || ''}`)
    ).then(buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16));

    const loopCheckRes = await stub.fetch(doUrl(`/workspaces/${workspaceId}/check-loop`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 
        pattern_hash: patternHash,
        window_ms: 60000, // 1 minute window
        max_count: 10, // Max 10 identical patterns per minute
      }),
    });

    if (loopCheckRes.status === 429) {
      const loopData = await loopCheckRes.json() as { count: number };
      logEvent({
        event: 'loop_detected',
        workspace_id: workspaceId,
        actor_key: await actorKey(parsed.data.actor.id),
        action: parsed.data.action,
        pattern_hash: patternHash,
        count: loopData.count,
      });

      writeMetric(c.env, {
        indexes: ['check_loop_blocked', parsed.data.policy_id, parsed.data.action, 'loop_detected'],
        doubles: [1, Date.now() - startMs],
      });

      c.header('cache-control', 'no-store');
      c.header('X-Proceedgate-Loop-Detected', 'true');

      const reasoning = generateReasoning({
        decision: 'blocked_storm',
        action: parsed.data.action,
        actor_id: parsed.data.actor.id,
        pattern_count: loopData.count,
        window_seconds: 60,
        cost_saved_usd: 0.05,
        task_hash: parsed.data.context.task_hash,
        step_hash: parsed.data.context.step_hash,
      });

      return c.json({
        allowed: false,
        error: 'loop_detected',
        workspace_id: workspaceId,
        reason: 'Too many identical requests detected. Possible agent loop.',
        pattern_count: loopData.count,
        cost_saved: '$0.05',
        cost_saved_usd: 0.05,
        message: `🚫 Blocked retry storm. You just saved $0.05`,
        hint: 'Add variation to task_hash or step_hash, or wait before retrying.',
        ...reasoning,
      }, 429);
    }

    const consumed = await consumeWorkspaceCredits(c.env, workspaceId, 1, {
      action: parsed.data.action,
    });
    if (!consumed.ok) {
      logEvent({
        event: 'billing_consume_fail',
        workspace_id: workspaceId,
        actor_key: await actorKey(parsed.data.actor.id),
        error: consumed.error,
      });

      writeMetric(c.env, {
        indexes: ['billing_consume_fail', parsed.data.policy_id, parsed.data.action, consumed.error],
        doubles: [1, Date.now() - startMs],
      });

      // Track blocked request for "cost saved" metric
      const stub = getBillingStub(c.env);
      stub.fetch(doUrl(`/workspaces/${workspaceId}/block`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ 
          reason: consumed.error || 'insufficient_credits',
          estimated_cost_usd: 0.01, // Conservative estimate per blocked API call
          action: parsed.data.action,
        }),
      }).catch(() => {}); // Fire and forget

      c.header('cache-control', 'no-store');
      c.header('X-Proceedgate-Billing-Mode', 'credits');

      const creditsReasoning = generateReasoning({
        decision: 'blocked_credits',
        action: parsed.data.action,
        actor_id: parsed.data.actor.id,
        credits_remaining: consumed.credits,
      });

      return c.json(
        {
          allowed: false,
          error: 'insufficient_credits',
          workspace_id: workspaceId,
          credits_remaining: consumed.credits,
          cost_saved: '$0.01',
          cost_saved_usd: 0.01,
          message: '🚫 Blocked. You just saved $0.01 by not burning more credits.',
          billing: {
            quote_url: '/v1/billing/quote',
            redeem_url: '/v1/billing/redeem',
            balance_url: `/v1/billing/balance?workspace_id=${encodeURIComponent(workspaceId)}`,
          },
          ...creditsReasoning,
        },
        402,
      );
    }

    // Send credits.low webhook if this is the first time crossing the threshold
    if (consumed.creditsLowNotify && consumed.maxCredits) {
      const stub = getBillingStub(c.env);
      const webhookRes = await stub.fetch(doUrl(`/workspaces/${workspaceId}/webhook`));
      if (webhookRes.ok) {
        const webhookConfig = await webhookRes.json() as { ok: boolean; webhook_url?: string; webhook_secret?: string };
        if (webhookConfig.ok && webhookConfig.webhook_url) {
          webhookCreditsLow(c.env, {
            webhookUrl: webhookConfig.webhook_url,
            webhookSecret: webhookConfig.webhook_secret,
            workspaceId,
            creditsRemaining: consumed.credits,
            thresholdPercent: 20,
            maxCredits: consumed.maxCredits,
          }).catch(err => console.error('Credits low webhook failed:', err));
        }
      }
    }
  }

  const decisionId = makeDecisionId();
  const attempt = parsed.data.context.attempt_in_window;
  const confidence = parsed.data.context.confidence;

  let priceInfo: { price: string; required: boolean; explain: string };
  let reasonCode: string = 'none';

  if (parsed.data.policy_id === 'retry_friction_v1') {
    priceInfo = computeRetryFrictionPrice(c.env, attempt);
    reasonCode = priceInfo.required ? 'retry_friction' : 'none';
  } else {
    priceInfo = computeLowConfidencePrice(c.env, { confidence, attemptInWindow: attempt });
    reasonCode = priceInfo.required ? 'low_confidence' : 'none';
  }

  if (!priceInfo.required) {
    const signed = await signProceedToken({
      env: c.env,
      origin,
      actorId: parsed.data.actor.id,
      decisionId,
      policyId: parsed.data.policy_id,
      action: parsed.data.action,
      taskHash: parsed.data.context.task_hash,
      stepHash: parsed.data.context.step_hash,
      contextHash: parsed.data.context.context_hash,
    });

    setProceedgateHeaders(c, {
      decisionId,
      policyId: parsed.data.policy_id,
      reasonCode: 'none',
    });

    logEvent({
      event: 'governor_check_ok',
      decision_id: decisionId,
      policy_id: parsed.data.policy_id,
      action: parsed.data.action,
      reason_code: 'none',
      actor_key: await actorKey(parsed.data.actor.id),
      task_hash: parsed.data.context.task_hash ?? '',
      step_hash: parsed.data.context.step_hash ?? '',
      context_hash: parsed.data.context.context_hash ?? '',
    });

    writeMetric(c.env, {
      indexes: ['check_ok', parsed.data.policy_id, parsed.data.action, 'none'],
      doubles: [1, Date.now() - startMs],
    });

    const allowReasoning = generateReasoning({
      decision: 'allowed',
      action: parsed.data.action,
      actor_id: parsed.data.actor.id,
    });

    return c.json(
      {
        allowed: true,
        decision_id: decisionId,
        proceed_token: signed.token,
        expires_in_seconds: signed.expiresInSeconds,
        reason_code: 'none',
        policy: {
          policy_id: parsed.data.policy_id,
          friction_required: false,
          friction_price: '0 USDC',
        },
        ...allowReasoning,
      },
      200,
    );
  }

  // Friction required - return 402
  const x402Price = getX402Price(c.env, priceInfo.price);
  const recipient = getX402Recipient(c.env);
  const chain = getX402Chain(c.env);

  c.header('x402-price', x402Price);
  c.header('x402-recipient', recipient);
  c.header('x402-chain', chain);
  c.header('cache-control', 'no-store');

  const nowMs = Date.now();
  await putDecisionRecord(c.env, {
    decisionId,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + 10 * 60 * 1000, // 10 minutes for human to pay
    actorId: parsed.data.actor.id,
    policyId: parsed.data.policy_id,
    action: parsed.data.action,
    taskHash: parsed.data.context.task_hash,
    stepHash: parsed.data.context.step_hash,
    contextHash: parsed.data.context.context_hash,
    price: x402Price,
    chain,
    recipient,
  });

  setProceedgateHeaders(c, {
    decisionId,
    policyId: parsed.data.policy_id,
    reasonCode,
    frictionPrice: x402Price,
  });

  logEvent({
    event: 'governor_check_402',
    decision_id: decisionId,
    policy_id: parsed.data.policy_id,
    action: parsed.data.action,
    reason_code: reasonCode,
    actor_key: await actorKey(parsed.data.actor.id),
    task_hash: parsed.data.context.task_hash ?? '',
    step_hash: parsed.data.context.step_hash ?? '',
    context_hash: parsed.data.context.context_hash ?? '',
    friction_price: x402Price,
    chain,
    recipient,
  });

  writeMetric(c.env, {
    indexes: ['check_402', parsed.data.policy_id, parsed.data.action, reasonCode],
    doubles: [1, Date.now() - startMs],
  });

  const frictionReasoning = generateReasoning({
    decision: 'friction_required',
    action: parsed.data.action,
    actor_id: parsed.data.actor.id,
    friction_price: x402Price,
    policy_id: parsed.data.policy_id,
    attempt,
  });

  return c.json(
    {
      allowed: false,
      decision_id: decisionId,
      reason_code: reasonCode,
      policy: {
        policy_id: parsed.data.policy_id,
        friction_required: true,
        friction_price: x402Price,
        explain: priceInfo.explain,
      },
      redeem: {
        method: 'POST',
        url: '/v1/governor/redeem',
        requires_header: 'x402-tx-hash',
      },
      ...frictionReasoning,
    },
    402,
  );
});

// ============================================================================
// /v1/demo/check - Public demo endpoint (no auth needed)
// ============================================================================
// Lets anyone test loop detection from the website.
// Uses a fixed "demo-public" workspace internally.
// Rate limited per IP via the standard middleware.
// ============================================================================

const demoCheckSchema = z.object({
  action: z.string().max(200).optional().default('tool_call'),
  task_hash: z.string().max(200).optional().default('demo-task'),
  step_hash: z.string().max(200).optional().default('demo-step'),
});

checkRoutes.post('/v1/demo/check', async (c) => {
  const startMs = Date.now();
  const body = await c.req.json().catch(() => null);
  const parsed = demoCheckSchema.safeParse(body ?? {});

  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const { action, task_hash, step_hash } = parsed.data;
  const demoWs = 'demo-public';

  // Loop detection — same logic as the real endpoint
  const stub = getBillingStub(c.env);
  const patternHash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${action}:${task_hash}:${step_hash}`),
  ).then(buf =>
    Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 16),
  );

  const loopCheckRes = await stub.fetch(doUrl(`/workspaces/${demoWs}/check-loop`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pattern_hash: patternHash,
      window_ms: 60_000,
      max_count: 10,
    }),
  });

  if (loopCheckRes.status === 429) {
    const loopData = (await loopCheckRes.json()) as { count: number };
    writeMetric(c.env, {
      indexes: ['demo_loop_blocked', 'demo', action, 'loop_detected'],
      doubles: [1, Date.now() - startMs],
    });

    const reasoning = generateReasoning({
      decision: 'blocked_storm',
      action,
      actor_id: 'demo-user',
      pattern_count: loopData.count,
      window_seconds: 60,
      cost_saved_usd: 0.05,
      task_hash: task_hash,
      step_hash: step_hash,
    });

    return c.json(
      {
        allowed: false,
        demo: true,
        error: 'loop_detected',
        reason: 'Too many identical requests. ProceedGate caught the storm!',
        pattern_count: loopData.count,
        cost_saved_usd: 0.05,
        message: '🚫 Blocked retry storm. You just saved $0.05',
        hint: 'Change task_hash/step_hash to vary the pattern, or wait 60 s.',
        ...reasoning,
      },
      429,
    );
  }

  writeMetric(c.env, {
    indexes: ['demo_check_ok', 'demo', action, 'allowed'],
    doubles: [1, Date.now() - startMs],
  });

  const allowReasoning = generateReasoning({
    decision: 'allowed',
    action,
    actor_id: 'demo-user',
  });

  return c.json(
    {
      allowed: true,
      demo: true,
      action,
      task_hash,
      step_hash,
      pattern_hash: patternHash,
      message: '✅ Request allowed through the gate.',
      hint: 'Click rapidly (>10×) with the same task_hash to trigger storm detection.',
      ...allowReasoning,
    },
    200,
  );
});

// ============================================================================
// /v1/check/simple - Simplified billing-only check endpoint
// ============================================================================
// This endpoint is for customers who only need credit-based billing
// without the full policy/friction system.
// Workspace is automatically derived from the API key.
// ============================================================================

import { z } from 'zod';

const simpleCheckSchema = z.object({
  user_id: z.string().min(1),
  action: z.string().optional().default('api_call'),
  cost: z.number().int().min(1).max(1000).optional().default(1),
  metadata: z.record(z.unknown()).optional(),
});

checkRoutes.post('/v1/check/simple', async (c) => {
  const startMs = Date.now();

  // 1. Extract and validate API key
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({
      ok: false,
      error: 'missing_authorization',
      hint: 'Include Authorization header: Authorization: Bearer pg_ws_...',
      docs: 'https://docs.proceedgate.dev/authentication',
    }, 401);
  }

  const apiKey = authHeader.slice(7).trim();
  if (!apiKey.startsWith(API_KEY_PREFIXES.WORKSPACE)) {
    return c.json({
      ok: false,
      error: 'invalid_api_key_format',
      hint: `API key should start with ${API_KEY_PREFIXES.WORKSPACE}`,
      docs: 'https://docs.proceedgate.dev/authentication',
    }, 401);
  }

  // 2. Parse body
  const body = await c.req.json().catch(() => null);
  const parsed = simpleCheckSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({
      ok: false,
      error: 'invalid_request',
      hint: 'Required: { "user_id": "your-user-id" }',
      issues: parsed.error.issues,
      docs: 'https://docs.proceedgate.dev/api/check-simple',
    }, 400);
  }

  // 3. Look up workspace from API key
  const apiKeyHash = await hashApiKey(apiKey);
  const stub = getBillingStub(c.env);

  const lookupRes = await stub.fetch(doUrl('/keys/lookup'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key_hash: apiKeyHash }),
  });

  if (!lookupRes.ok) {
    return c.json({
      ok: false,
      error: 'workspace_not_found',
      hint: 'The API key is not associated with any workspace.',
      docs: 'https://docs.proceedgate.dev/errors/workspace-not-found',
    }, 404);
  }

  const { workspace_id: workspaceId } = await lookupRes.json() as { workspace_id: string };

  // 4. Consume credits (use cost from request, default 1)
  const creditCost = parsed.data.cost || 1;
  const consumed = await consumeWorkspaceCredits(c.env, workspaceId, creditCost, {
    action: parsed.data.action || 'simple_check',
  });

  if (!consumed.ok) {
    logEvent({
      event: 'simple_check_fail',
      workspace_id: workspaceId,
      user_id: parsed.data.user_id,
      error: consumed.error,
    });

    writeMetric(c.env, {
      indexes: ['simple_check_fail', workspaceId, parsed.data.action, consumed.error],
      doubles: [1, Date.now() - startMs],
    });

    // Track blocked request for "cost saved" metric
    stub.fetch(doUrl(`/workspaces/${workspaceId}/block`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 
        reason: consumed.error || 'insufficient_credits',
        estimated_cost_usd: 0.01,
        action: parsed.data.action,
      }),
    }).catch(() => {}); // Fire and forget

    return c.json({
      ok: false,
      allowed: false,
      error: 'insufficient_credits',
      workspace_id: workspaceId,
      credits_remaining: consumed.credits,
      cost_saved: '$0.01',
      cost_saved_usd: 0.01,
      message: '🚫 Blocked. You just saved $0.01 by not burning more credits.',
      upgrade: {
        message: 'You have run out of credits. Top up to continue.',
        quote_url: `/v1/billing/quote?workspace_id=${encodeURIComponent(workspaceId)}&credits=10000`,
        balance_url: `/v1/billing/balance?workspace_id=${encodeURIComponent(workspaceId)}`,
        docs: 'https://docs.proceedgate.dev/billing/top-up',
      },
    }, 402);
  }

  // 5. Trigger credits.low webhook if needed
  if (consumed.creditsLowNotify && consumed.maxCredits) {
    const webhookRes = await stub.fetch(doUrl(`/workspaces/${workspaceId}/webhook`));
    if (webhookRes.ok) {
      const webhookConfig = await webhookRes.json() as { ok: boolean; webhook_url?: string; webhook_secret?: string };
      if (webhookConfig.ok && webhookConfig.webhook_url) {
        webhookCreditsLow(c.env, {
          webhookUrl: webhookConfig.webhook_url,
          webhookSecret: webhookConfig.webhook_secret,
          workspaceId,
          creditsRemaining: consumed.credits,
          thresholdPercent: 20,
          maxCredits: consumed.maxCredits,
        }).catch(err => console.error('Credits low webhook failed:', err));
      }
    }
  }

  // 6. Log success
  logEvent({
    event: 'simple_check_ok',
    workspace_id: workspaceId,
    user_id: parsed.data.user_id,
    action: parsed.data.action,
    credits_remaining: consumed.credits,
  });

  writeMetric(c.env, {
    indexes: ['simple_check_ok', workspaceId, parsed.data.action, 'success'],
    doubles: [1, Date.now() - startMs],
  });

  // 7. Return success
  return c.json({
    ok: true,
    allowed: true,
    workspace_id: workspaceId,
    user_id: parsed.data.user_id,
    credits_remaining: consumed.credits,
    credits_used: creditCost,
  }, 200);
});

export { checkRoutes };
