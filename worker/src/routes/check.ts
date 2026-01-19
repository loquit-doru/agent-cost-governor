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

    const consumed = await consumeWorkspaceCredits(c.env, workspaceId, 1);
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

      c.header('cache-control', 'no-store');
      c.header('X-Proceedgate-Billing-Mode', 'credits');
      return c.json(
        {
          allowed: false,
          error: 'insufficient_credits',
          workspace_id: workspaceId,
          credits_remaining: consumed.credits,
          billing: {
            quote_url: '/v1/billing/quote',
            redeem_url: '/v1/billing/redeem',
            balance_url: `/v1/billing/balance?workspace_id=${encodeURIComponent(workspaceId)}`,
          },
        },
        402,
      );
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
    },
    402,
  );
});

export { checkRoutes };
