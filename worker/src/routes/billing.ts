import { Hono } from 'hono';
import type { Env, Vars } from '../types.js';
import {
  billingQuoteSchema,
  billingRedeemSchema,
  budgetSetSchema,
} from '../lib/schemas.js';
import {
  getBillingMode,
  getBillingChain,
  getBillingRecipient,
  getBillingCreditCostMicroUsdc,
} from '../lib/config.js';
import { makeQuoteId, quotePriceFromCredits } from '../lib/utils.js';
import { requireWorkspaceAuth } from '../middleware/auth.js';
import {
  putBillingQuote,
  getBillingQuote,
  redeemBillingQuote,
  getWorkspaceCredits,
} from '../services/store.js';
import { facilitatorVerifyPayment } from '../facilitator.js';
import { logEvent, txKey } from '../observability.js';
import { writeMetric } from '../metrics.js';
import { getBillingStub, doUrl } from '../lib/do.js';
import type { BillingQuoteRecord } from '../billingStoreDO.js';

const billingRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

// Create billing quote
billingRoutes.post('/v1/billing/quote', async (c) => {
  const startMs = Date.now();

  if (getBillingMode(c.env) !== 'credits') {
    return c.json({ ok: false, error: 'billing_not_enabled' }, 501);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = billingQuoteSchema.safeParse(body);

  if (!parsed.success) {
    writeMetric(c.env, {
      indexes: ['billing_quote_fail', 'unknown', 'unknown', 'invalid_request'],
      doubles: [1, Date.now() - startMs],
    });
    return c.json({ ok: false, error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const authErr = await requireWorkspaceAuth(c, parsed.data.workspace_id);
  if (authErr) return authErr;

  const quoteId = makeQuoteId();
  const micro = getBillingCreditCostMicroUsdc(c.env);
  const { units, price } = quotePriceFromCredits(parsed.data.credits, micro);

  if (units <= 0n) {
    return c.json({ ok: false, error: 'invalid_price' }, 400);
  }

  const recipient = getBillingRecipient(c.env);
  const chain = getBillingChain(c.env);

  const nowMs = Date.now();
  const record: BillingQuoteRecord = {
    quoteId,
    workspaceId: parsed.data.workspace_id,
    credits: parsed.data.credits,
    requiredPrice: price,
    chain,
    recipient,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + 30 * 60 * 1000, // 30 minutes
  };

  await putBillingQuote(c.env, record);

  logEvent({
    event: 'billing_quote_created',
    quote_id: quoteId,
    workspace_id: parsed.data.workspace_id,
    credits: parsed.data.credits,
    required_price: price,
    chain: chain.toLowerCase(),
    recipient,
  });

  writeMetric(c.env, {
    indexes: ['billing_quote_ok', 'unknown', 'unknown', 'ok'],
    doubles: [1, Date.now() - startMs],
  });

  return c.json(
    {
      ok: true,
      quote_id: quoteId,
      workspace_id: parsed.data.workspace_id,
      credits: parsed.data.credits,
      required_price: price,
      required_chain: chain,
      required_recipient: recipient,
      expires_at: new Date(record.expiresAtMs).toISOString(),
    },
    200,
  );
});

// Redeem billing quote
billingRoutes.post('/v1/billing/redeem', async (c) => {
  const startMs = Date.now();

  if (getBillingMode(c.env) !== 'credits') {
    return c.json({ ok: false, error: 'billing_not_enabled' }, 501);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = billingRedeemSchema.safeParse(body);

  if (!parsed.success) {
    writeMetric(c.env, {
      indexes: ['billing_redeem_fail', 'unknown', 'unknown', 'invalid_request'],
      doubles: [1, Date.now() - startMs],
    });
    return c.json({ ok: false, error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const quote = await getBillingQuote(c.env, parsed.data.quote_id);
  if (!quote) {
    writeMetric(c.env, {
      indexes: ['billing_redeem_fail', 'unknown', 'unknown', 'unknown_or_expired_quote'],
      doubles: [1, Date.now() - startMs],
    });
    return c.json({ ok: false, error: 'unknown_or_expired_quote' }, 404);
  }

  const authErr = await requireWorkspaceAuth(c, quote.workspaceId);
  if (authErr) return authErr;

  const verified = await facilitatorVerifyPayment(c.env, {
    tx_hash: parsed.data.tx_hash,
    required_price: quote.requiredPrice,
    required_chain: quote.chain,
    required_recipient: quote.recipient,
    decision_id: quote.quoteId,
  });

  if (!verified.ok) {
    logEvent({
      event: 'billing_redeem_fail',
      quote_id: quote.quoteId,
      workspace_id: quote.workspaceId,
      error: verified.error,
      tx: txKey(parsed.data.tx_hash),
    });

    writeMetric(c.env, {
      indexes: ['billing_redeem_fail', 'unknown', 'unknown', verified.error],
      doubles: [1, Date.now() - startMs],
    });

    return c.json({ ok: false, error: verified.error }, verified.status);
  }

  const redeemed = await redeemBillingQuote(c.env, quote.quoteId, parsed.data.tx_hash);
  if (!redeemed.ok) {
    logEvent({
      event: 'billing_redeem_fail',
      quote_id: quote.quoteId,
      workspace_id: quote.workspaceId,
      error: redeemed.error,
      tx: txKey(parsed.data.tx_hash),
    });

    writeMetric(c.env, {
      indexes: ['billing_redeem_fail', 'unknown', 'unknown', redeemed.error],
      doubles: [1, Date.now() - startMs],
    });

    return c.json({ ok: false, error: redeemed.error }, redeemed.status);
  }

  logEvent({
    event: 'billing_redeem_ok',
    quote_id: quote.quoteId,
    workspace_id: quote.workspaceId,
    credits_added: quote.credits,
    credits_total: redeemed.credits,
    tx: txKey(parsed.data.tx_hash),
    paid_price: verified.receipt.paid_price,
  });

  writeMetric(c.env, {
    indexes: ['billing_redeem_ok', 'unknown', 'unknown', 'ok'],
    doubles: [1, Date.now() - startMs],
  });

  return c.json(
    {
      ok: true,
      quote_id: quote.quoteId,
      workspace_id: quote.workspaceId,
      credits_added: quote.credits,
      credits_total: redeemed.credits,
      receipt: verified.receipt,
    },
    200,
  );
});

// Get workspace balance
billingRoutes.get('/v1/billing/balance', async (c) => {
  if (getBillingMode(c.env) !== 'credits') {
    return c.json({ ok: false, error: 'billing_not_enabled' }, 501);
  }

  const workspaceId = String(c.req.query('workspace_id') ?? '').trim();
  if (!workspaceId) {
    return c.json({ ok: false, error: 'missing_workspace_id' }, 400);
  }

  const authErr = await requireWorkspaceAuth(c, workspaceId);
  if (authErr) return authErr;

  const credits = await getWorkspaceCredits(c.env, workspaceId);
  return c.json({ ok: true, workspace_id: workspaceId, credits }, 200);
});

// Set budget limits
billingRoutes.put('/v1/billing/budget', async (c) => {
  if (getBillingMode(c.env) !== 'credits') {
    return c.json({ ok: false, error: 'billing_not_enabled' }, 501);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = budgetSetSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const { workspace_id: workspaceId, daily_limit, weekly_limit, monthly_limit, alert_threshold, webhook_url } = parsed.data;

  const authErr = await requireWorkspaceAuth(c, workspaceId);
  if (authErr) return authErr;

  const stub = getBillingStub(c.env);
  const response = await stub.fetch(doUrl(`/workspaces/${encodeURIComponent(workspaceId)}/budget`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      daily_limit,
      weekly_limit,
      monthly_limit,
      alert_threshold,
      webhook_url,
    }),
  });

  const data = await response.json();
  return c.json(data, response.status as 200 | 400 | 500);
});

// Get budget limits
billingRoutes.get('/v1/billing/budget', async (c) => {
  if (getBillingMode(c.env) !== 'credits') {
    return c.json({ ok: false, error: 'billing_not_enabled' }, 501);
  }

  const workspaceId = String(c.req.query('workspace_id') ?? '').trim();
  if (!workspaceId) {
    return c.json({ ok: false, error: 'missing_workspace_id' }, 400);
  }

  const authErr = await requireWorkspaceAuth(c, workspaceId);
  if (authErr) return authErr;

  const stub = getBillingStub(c.env);
  const response = await stub.fetch(doUrl(`/workspaces/${encodeURIComponent(workspaceId)}/budget`), {
    method: 'GET',
  });

  const data = await response.json();
  return c.json(data, response.status as 200 | 404);
});

// Delete budget limits
billingRoutes.delete('/v1/billing/budget', async (c) => {
  if (getBillingMode(c.env) !== 'credits') {
    return c.json({ ok: false, error: 'billing_not_enabled' }, 501);
  }

  const workspaceId = String(c.req.query('workspace_id') ?? '').trim();
  if (!workspaceId) {
    return c.json({ ok: false, error: 'missing_workspace_id' }, 400);
  }

  const authErr = await requireWorkspaceAuth(c, workspaceId);
  if (authErr) return authErr;

  const stub = getBillingStub(c.env);
  await stub.fetch(doUrl(`/workspaces/${encodeURIComponent(workspaceId)}/budget`), {
    method: 'DELETE',
  });

  return c.json({ ok: true }, 200);
});

// Get usage report
billingRoutes.get('/v1/billing/usage', async (c) => {
  if (getBillingMode(c.env) !== 'credits') {
    return c.json({ ok: false, error: 'billing_not_enabled' }, 501);
  }

  const workspaceId = String(c.req.query('workspace_id') ?? '').trim();
  const period = c.req.query('period') || 'today';
  if (!workspaceId) {
    return c.json({ ok: false, error: 'missing_workspace_id' }, 400);
  }

  const authErr = await requireWorkspaceAuth(c, workspaceId);
  if (authErr) return authErr;

  const stub = getBillingStub(c.env);
  const response = await stub.fetch(doUrl(`/workspaces/${encodeURIComponent(workspaceId)}/usage?period=${period}`), {
    method: 'GET',
  });

  const data = await response.json();
  return c.json(data, response.status as 200);
});

// ============================================================================
// GET /v1/billing/stats - Get workspace statistics including "cost saved" metric
// ============================================================================
// Returns:
// - blocked_requests: Total requests blocked
// - cost_saved_usd: Estimated money saved by blocking runaway requests
// - blocked_by_reason: Breakdown by reason (insufficient_credits, budget_exceeded, loop_detected)
// ============================================================================
billingRoutes.get('/v1/billing/stats', async (c) => {
  if (getBillingMode(c.env) !== 'credits') {
    return c.json({ ok: false, error: 'billing_not_enabled' }, 501);
  }

  const workspaceId = String(c.req.query('workspace_id') ?? '').trim();
  if (!workspaceId) {
    return c.json({ ok: false, error: 'missing_workspace_id' }, 400);
  }

  const authErr = await requireWorkspaceAuth(c, workspaceId);
  if (authErr) return authErr;

  const stub = getBillingStub(c.env);
  const response = await stub.fetch(doUrl(`/workspaces/${encodeURIComponent(workspaceId)}/stats`), {
    method: 'GET',
  });

  const data = await response.json();
  return c.json(data, response.status as 200);
});

export { billingRoutes };
