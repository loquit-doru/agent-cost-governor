/**
 * Self-service subscription routes for ProceedGate
 * 
 * These endpoints allow new users to subscribe without an existing API key.
 * Flow:
 * 1. POST /v1/billing/subscribe - Create invoice for a plan
 * 2. User pays USDC on-chain
 * 3. POST /v1/billing/subscribe/confirm - Confirm payment and create workspace
 */

import { Hono } from 'hono';
import type { Env, Vars } from '../types.js';
import { z } from 'zod';
import { getBillingRecipient, getBillingChain } from '../lib/config.js';
import { logEvent } from '../observability.js';
import { writeMetric } from '../metrics.js';
import { sendSubscriptionConfirmation, sendFreeWelcomeEmail, isEmailConfigured } from '../services/email.js';
import { webhookSubscriptionCreated, webhookSubscriptionRenewed, sendWebhook } from '../services/webhook.js';
import { getBillingStub, doUrl } from '../lib/do.js';
import { hashApiKey } from '../lib/crypto.js';
import { CREDITS, API_KEY_PREFIXES } from '../lib/constants.js';

const subscribeRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

// Subscription plans with full feature set
const PLANS = {
  free: {
    name: 'Free',
    priceMonthly: 0,
    checks: 2000,
    projects: 1,
    logRetentionDays: 3,
    customPolicies: 0,
    webhooks: false,
    alerts: false,
    analytics: false,
    teamKeys: 1,
    ipAllowlist: false,
    auditLogs: false,
    support: 'community',
  },
  starter: {
    name: 'Starter',
    priceMonthly: 19,
    checks: 25000,
    projects: 3,
    logRetentionDays: 14,
    customPolicies: 0,
    webhooks: false,
    alerts: false,
    analytics: true, // Basic analytics
    teamKeys: 1,
    ipAllowlist: false,
    auditLogs: false,
    support: 'email',
  },
  pro: {
    name: 'Pro',
    priceMonthly: 59,
    checks: 1000000,
    projects: 5,
    logRetentionDays: 30,
    customPolicies: 10,
    webhooks: true,
    alerts: true,
    analytics: true,
    teamKeys: 1,        // Number of API keys per workspace
    ipAllowlist: false,
    auditLogs: false,
    support: 'priority',
  },
  scale: {
    name: 'Scale',
    priceMonthly: 199,
    checks: 5000000,
    projects: 25,
    logRetentionDays: 90,
    customPolicies: -1, // Unlimited
    webhooks: true,
    alerts: true,
    analytics: true,
    teamKeys: 10,       // Multiple API keys for team
    ipAllowlist: true,  // Restrict API access by IP
    auditLogs: true,
    support: 'dedicated',
  },
} as const;

type PlanId = keyof typeof PLANS;

// Period multipliers and discounts
const PERIODS = {
  1: { months: 1, discount: 0 },
  3: { months: 3, discount: 0 },
  6: { months: 6, discount: 0.10 },
  12: { months: 12, discount: 0.17 },
} as const;

type PeriodMonths = keyof typeof PERIODS;

// Schemas
const subscribeSchema = z.object({
  plan: z.enum(['starter', 'pro', 'scale']), // Free tier uses separate endpoint
  months: z.number().refine((n): n is PeriodMonths => n === 1 || n === 3 || n === 6 || n === 12),
  chain: z.enum(['base', 'polygon']).optional().default('base'),
  email: z.string().email().optional(),
});

const freeSignupSchema = z.object({
  email: z.string().email(),
});

const confirmSchema = z.object({
  invoice_id: z.string().min(1),
  tx_hash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

// Invoice type (stored in Durable Object)
interface Invoice {
  id: string;
  plan: PlanId;
  months: number;
  totalUsdc: number;
  chain: string;
  chainId: number;
  recipient: string;
  createdAtMs: number;
  expiresAtMs: number;
  status: 'pending' | 'confirming' | 'confirmed' | 'expired';
  txHash?: string;
  workspaceId?: string;
  apiKey?: string;
  email?: string;
}

// Helper: Store invoice in DO
async function storeInvoice(env: Env, invoice: Invoice): Promise<void> {
  const stub = getBillingStub(env);
  await stub.fetch(doUrl(`/invoices/${invoice.id}`), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(invoice),
  });
}

// Helper: Get invoice from DO
async function getInvoice(env: Env, invoiceId: string): Promise<Invoice | null> {
  const stub = getBillingStub(env);
  const res = await stub.fetch(doUrl(`/invoices/${invoiceId}`));
  if (!res.ok) return null;
  const data = await res.json() as { ok: boolean; invoice?: Invoice };
  return data.invoice || null;
}

// Helper: Record payment in audit log
async function recordPayment(env: Env, data: {
  invoiceId: string;
  workspaceId: string;
  txHash: string;
  chain: string;
  chainId: number;
  amountUsdc: number;
  plan: string;
  months: number;
  email?: string;
  type: 'subscription' | 'renewal' | 'upgrade';
}): Promise<void> {
  const stub = getBillingStub(env);
  await stub.fetch(doUrl('/payments'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...data,
      confirmedAtMs: Date.now(),
    }),
  });
}

// Helper: Generate invoice ID
function makeInvoiceId(): string {
  return 'inv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Helper: Generate workspace ID
function makeWorkspaceId(plan: string): string {
  return plan + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Helper: Generate API key
function makeApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return 'pg_ws_' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Helper: Calculate total price
function calculateTotal(plan: PlanId, months: PeriodMonths): number {
  const basePrice = PLANS[plan].priceMonthly;
  const period = PERIODS[months];
  const total = basePrice * period.months * (1 - period.discount);
  return Math.round(total);
}

// Helper: Get chain ID
function getChainId(chain: string): number {
  return chain === 'polygon' ? 137 : 8453;
}

// ============================================================================
// POST /v1/billing/subscribe - Create subscription invoice
// ============================================================================
subscribeRoutes.post('/v1/billing/subscribe', async (c) => {
  const startMs = Date.now();

  const body = await c.req.json().catch(() => null);
  const parsed = subscribeSchema.safeParse(body);

  if (!parsed.success) {
    writeMetric(c.env, {
      indexes: ['subscribe_fail', 'unknown', 'invalid_request'],
      doubles: [1, Date.now() - startMs],
    });
    return c.json({ ok: false, error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const { plan, months, chain, email } = parsed.data;
  const totalUsdc = calculateTotal(plan, months as PeriodMonths);
  const chainId = getChainId(chain);
  const recipient = getBillingRecipient(c.env);

  const invoiceId = makeInvoiceId();
  const nowMs = Date.now();

  const invoice: Invoice = {
    id: invoiceId,
    plan,
    months,
    totalUsdc,
    chain,
    chainId,
    recipient,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + 30 * 60 * 1000, // 30 minutes
    status: 'pending',
    email,
  };

  // Store invoice in Durable Object for persistence
  await storeInvoice(c.env, invoice);

  logEvent({
    event: 'subscribe_invoice_created',
    invoice_id: invoiceId,
    plan,
    months,
    total_usdc: totalUsdc,
    chain,
  });

  writeMetric(c.env, {
    indexes: ['subscribe_invoice_ok', plan, chain],
    doubles: [1, Date.now() - startMs, totalUsdc],
  });

  return c.json({
    ok: true,
    invoice_id: invoiceId,
    plan: PLANS[plan].name,
    months,
    total_usdc: totalUsdc,
    chain,
    chain_id: chainId,
    recipient,
    expires_at: new Date(invoice.expiresAtMs).toISOString(),
  }, 200);
});

// ============================================================================
// GET /v1/billing/subscribe/:id - Get invoice status
// ============================================================================
subscribeRoutes.get('/v1/billing/subscribe/:id', async (c) => {
  const invoiceId = c.req.param('id');
  const invoice = await getInvoice(c.env, invoiceId);

  if (!invoice) {
    return c.json({ ok: false, error: 'invoice_not_found' }, 404);
  }

  // Check if expired
  if (invoice.status === 'pending' && Date.now() > invoice.expiresAtMs) {
    invoice.status = 'expired';
    await storeInvoice(c.env, invoice);
  }

  return c.json({
    ok: true,
    invoice_id: invoice.id,
    status: invoice.status,
    plan: PLANS[invoice.plan].name,
    months: invoice.months,
    total_usdc: invoice.totalUsdc,
    chain: invoice.chain,
    expires_at: new Date(invoice.expiresAtMs).toISOString(),
    // Only include credentials if confirmed — redact api_key for unauthenticated polling
    ...(invoice.status === 'confirmed' && {
      workspace_id: invoice.workspaceId,
      api_key_prefix: invoice.apiKey ? invoice.apiKey.slice(0, 12) + '...' : undefined,
    }),
  }, 200);
});

// ============================================================================
// POST /v1/billing/subscribe/confirm - Confirm payment and create workspace
// ============================================================================
subscribeRoutes.post('/v1/billing/subscribe/confirm', async (c) => {
  const startMs = Date.now();

  const body = await c.req.json().catch(() => null);
  const parsed = confirmSchema.safeParse(body);

  if (!parsed.success) {
    writeMetric(c.env, {
      indexes: ['subscribe_confirm_fail', 'invalid_request'],
      doubles: [1, Date.now() - startMs],
    });
    return c.json({ ok: false, error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const { invoice_id, tx_hash } = parsed.data;
  
  // Check for replay attack - has this tx_hash already been used?
  {
    const replayStub = getBillingStub(c.env);
    const txCheckRes = await replayStub.fetch(doUrl(`/payments/by-tx/${tx_hash.toLowerCase()}`));
    if (txCheckRes.ok) {
      const existingPayment = await txCheckRes.json() as { ok: boolean; payment?: { workspaceId: string } };
      if (existingPayment.ok && existingPayment.payment) {
        logEvent({
          event: 'subscribe_confirm_replay_attempt',
          invoice_id,
          tx_hash,
          existing_workspace: existingPayment.payment.workspaceId,
        });
        return c.json({ 
          ok: false, 
          error: 'tx_already_used',
          message: 'This transaction has already been used to create a workspace.',
        }, 409);
      }
    }
  }

  const invoice = await getInvoice(c.env, invoice_id);

  if (!invoice) {
    return c.json({ ok: false, error: 'invoice_not_found' }, 404);
  }

  // Check if already confirmed
  if (invoice.status === 'confirmed') {
    return c.json({
      ok: true,
      status: 'confirmed',
      workspace_id: invoice.workspaceId,
      api_key: invoice.apiKey,
      plan: PLANS[invoice.plan].name,
      months: invoice.months,
    }, 200);
  }

  // Check if expired
  if (Date.now() > invoice.expiresAtMs) {
    invoice.status = 'expired';
    await storeInvoice(c.env, invoice);
    return c.json({ ok: false, error: 'invoice_expired' }, 410);
  }

  // Verify payment on-chain
  invoice.status = 'confirming';
  invoice.txHash = tx_hash;
  await storeInvoice(c.env, invoice);

  const verified = await verifyUsdcTransfer(c.env, {
    txHash: tx_hash,
    chainId: invoice.chainId,
    expectedRecipient: invoice.recipient,
    expectedAmountUsdc: invoice.totalUsdc,
  });

  if (!verified.ok) {
    invoice.status = 'pending';
    await storeInvoice(c.env, invoice);
    logEvent({
      event: 'subscribe_confirm_fail',
      invoice_id,
      tx_hash,
      error: verified.error,
    });
    writeMetric(c.env, {
      indexes: ['subscribe_confirm_fail', verified.error || 'unknown'],
      doubles: [1, Date.now() - startMs],
    });
    return c.json({ ok: false, error: verified.error }, 402);
  }

  // Payment verified! Create workspace
  const workspaceId = makeWorkspaceId(invoice.plan);
  const apiKey = makeApiKey();
  const apiKeyHash = await hashApiKey(apiKey);

  // Get plan features
  const planConfig = PLANS[invoice.plan];

  // Store workspace in billing DO
  const stub = getBillingStub(c.env);
  const createRes = await stub.fetch(doUrl('/workspaces/create'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workspace_id: workspaceId,
      api_key_hash: apiKeyHash,
      plan: invoice.plan,
      credits: planConfig.checks,
      expires_at_ms: Date.now() + invoice.months * 30 * 24 * 60 * 60 * 1000,
      features: {
        projects: planConfig.projects,
        logRetentionDays: planConfig.logRetentionDays,
        customPolicies: planConfig.customPolicies,
        webhooks: planConfig.webhooks,
        alerts: planConfig.alerts,
        analytics: planConfig.analytics,
        teamKeys: planConfig.teamKeys,
        ipAllowlist: planConfig.ipAllowlist,
        auditLogs: planConfig.auditLogs,
      },
    }),
  });

  if (!createRes.ok) {
    logEvent({
      event: 'subscribe_workspace_create_fail',
      invoice_id,
      workspace_id: workspaceId,
    });
    return c.json({ ok: false, error: 'workspace_creation_failed' }, 500);
  }

  // Mark invoice as confirmed
  invoice.status = 'confirmed';
  invoice.workspaceId = workspaceId;
  invoice.apiKey = apiKey;
  await storeInvoice(c.env, invoice);

  // Record payment in audit log
  await recordPayment(c.env, {
    invoiceId: invoice.id,
    workspaceId,
    txHash: tx_hash,
    chain: invoice.chain,
    chainId: invoice.chainId,
    amountUsdc: invoice.totalUsdc,
    plan: invoice.plan,
    months: invoice.months,
    email: invoice.email,
    type: 'subscription',
  });

  logEvent({
    event: 'subscribe_confirmed',
    invoice_id,
    workspace_id: workspaceId,
    plan: invoice.plan,
    months: invoice.months,
    total_usdc: invoice.totalUsdc,
    tx_hash,
  });

  writeMetric(c.env, {
    indexes: ['subscribe_confirm_ok', invoice.plan, invoice.chain],
    doubles: [1, Date.now() - startMs, invoice.totalUsdc],
  });

  // Calculate expiry date
  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + invoice.months);

  // Send confirmation email if provided
  if (invoice.email) {
    await sendSubscriptionConfirmation(c.env, {
      to: invoice.email,
      workspaceId,
      apiKey,
      plan: PLANS[invoice.plan].name,
      months: invoice.months,
      expiresAt: expiresAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      totalPaid: invoice.totalUsdc,
      txHash: tx_hash,
    }).catch(err => console.error('Email send failed:', err));
  }

  // Send webhook if configured (fire-and-forget)
  {
    const webhookRes = await stub.fetch(doUrl(`/workspaces/${workspaceId}/webhook`));
    if (webhookRes.ok) {
      const webhookConfig = await webhookRes.json() as { ok: boolean; webhook_url?: string; webhook_secret?: string };
      if (webhookConfig.ok && webhookConfig.webhook_url) {
        webhookSubscriptionCreated(c.env, {
          webhookUrl: webhookConfig.webhook_url,
          webhookSecret: webhookConfig.webhook_secret,
          workspaceId,
          plan: invoice.plan,
          months: invoice.months,
          credits: PLANS[invoice.plan].checks,
          expiresAt: expiresAt.toISOString(),
          txHash: tx_hash,
        }).catch(err => console.error('Webhook send failed:', err));
      }
    }
  }

  return c.json({
    ok: true,
    status: 'confirmed',
    workspace_id: workspaceId,
    api_key: apiKey,
    plan: PLANS[invoice.plan].name,
    months: invoice.months,
    checks_included: PLANS[invoice.plan].checks,
    expires_at: expiresAt.toISOString(),
    quickstart: {
      step_1: {
        description: 'Test your API key with the /me endpoint',
        curl: `curl https://governor.proceedgate.dev/v1/me -H "Authorization: Bearer ${apiKey}"`,
      },
      step_2: {
        description: 'Make your first billing check',
        curl: `curl -X POST https://governor.proceedgate.dev/v1/check/simple \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"user_id": "your-user-id"}'`,
      },
      step_3: {
        description: 'Configure webhooks for alerts',
        curl: `curl -X PUT https://governor.proceedgate.dev/v1/billing/webhook \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"webhook_url": "https://your-server.com/webhook"}'`,
      },
      docs: 'https://docs.proceedgate.dev/quickstart',
      dashboard: `https://proceedgate.dev/dashboard?workspace=${workspaceId}`,
    },
  }, 200);
});

// ============================================================================
// Helper: Verify USDC transfer on-chain
// ============================================================================
interface VerifyResult {
  ok: boolean;
  error?: string;
}

async function verifyUsdcTransfer(
  env: Env,
  params: {
    txHash: string;
    chainId: number;
    expectedRecipient: string;
    expectedAmountUsdc: number;
  }
): Promise<VerifyResult> {
  const { txHash, chainId, expectedRecipient, expectedAmountUsdc } = params;

  // Get RPC URL based on chain
  const rpcUrl = chainId === 137
    ? 'https://polygon-rpc.com'
    : (env.BASE_RPC_URL || 'https://mainnet.base.org');

  // USDC contract addresses
  const usdcAddress = chainId === 137
    ? '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
    : '0x833589fCD6eDb6E08f4c7C32D4f71b54bda02913';

  try {
    // Fetch transaction receipt
    const receiptRes = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      }),
    });

    const receiptData = await receiptRes.json() as {
      result?: {
        status: string;
        logs: Array<{
          address: string;
          topics: string[];
          data: string;
        }>;
      };
    };

    if (!receiptData.result) {
      return { ok: false, error: 'tx_not_found' };
    }

    const receipt = receiptData.result;

    // Check if transaction succeeded
    if (receipt.status !== '0x1') {
      return { ok: false, error: 'tx_failed' };
    }

    // Find USDC Transfer event
    // Transfer(address from, address to, uint256 value)
    // Topic0: 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
    const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    
    const transferLog = receipt.logs.find(log =>
      log.address.toLowerCase() === usdcAddress.toLowerCase() &&
      log.topics[0] === transferTopic
    );

    if (!transferLog) {
      return { ok: false, error: 'no_usdc_transfer' };
    }

    // Parse recipient from topics[2] (indexed 'to' address)
    const toAddress = '0x' + transferLog.topics[2].slice(26).toLowerCase();
    if (toAddress !== expectedRecipient.toLowerCase()) {
      return { ok: false, error: 'wrong_recipient' };
    }

    // Parse amount from data (USDC has 6 decimals)
    const amountHex = transferLog.data;
    const amountRaw = BigInt(amountHex);
    const amountUsdc = Number(amountRaw) / 1_000_000;

    if (amountUsdc < expectedAmountUsdc) {
      return { ok: false, error: 'insufficient_amount' };
    }

    return { ok: true };

  } catch (err) {
    console.error('verifyUsdcTransfer error:', err);
    return { ok: false, error: 'verification_failed' };
  }
}

// ============================================================================
// GET /v1/billing/workspace - Get workspace info for dashboard
// Requires Authorization: Bearer <api_key>
// ============================================================================
subscribeRoutes.get('/v1/billing/workspace', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ ok: false, error: 'missing_authorization' }, 401);
  }

  const apiKey = authHeader.slice(7).trim();
  if (!apiKey.startsWith('pg_ws_')) {
    return c.json({ ok: false, error: 'invalid_api_key_format' }, 401);
  }

  const apiKeyHash = await hashApiKey(apiKey);
  const stub = getBillingStub(c.env);
  
  // Look up workspace by API key hash
  const lookupRes = await stub.fetch(doUrl('/keys/lookup'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key_hash: apiKeyHash }),
  });

  if (!lookupRes.ok) {
    return c.json({ ok: false, error: 'workspace_not_found' }, 404);
  }

  const { workspace_id: workspaceId } = await lookupRes.json() as { workspace_id: string };

  // Verify the API key against the stored hash
  const verifyRes = await stub.fetch(doUrl(`/workspaces/${workspaceId}/verify`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key_hash: apiKeyHash }),
  });

  if (!verifyRes.ok) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }

  // Get workspace balance
  const balanceRes = await stub.fetch(doUrl(`/workspaces/${workspaceId}`));
  const balanceData = await balanceRes.json() as { credits: number };

  // Get subscription metadata
  const subRes = await stub.fetch(doUrl(`/workspaces/${workspaceId}/subscription`));
  let subData: { plan?: string; expiresAtMs?: number; credits?: number } = {};
  if (subRes.ok) {
    subData = await subRes.json() as typeof subData;
  }

  // Get usage for today
  const usageRes = await stub.fetch(doUrl(`/workspaces/${workspaceId}/usage?period=today`));
  let usageData: { total_credits_used?: number } = {};
  if (usageRes.ok) {
    usageData = await usageRes.json() as typeof usageData;
  }

  const plan = (subData.plan || 'starter') as keyof typeof PLANS;
  const planConfig = PLANS[plan] || PLANS.starter;

  return c.json({
    ok: true,
    workspace_id: workspaceId,
    credits: balanceData.credits,
    max_credits: planConfig.checks,
    plan: plan,
    plan_name: planConfig.name,
    status: (subData.expiresAtMs && Date.now() < subData.expiresAtMs) ? 'active' : 'expired',
    expires_at: subData.expiresAtMs ? new Date(subData.expiresAtMs).toISOString() : null,
    calls_today: usageData.total_credits_used || 0,
    features: {
      checks_per_month: planConfig.checks,
      projects: planConfig.projects,
      log_retention_days: planConfig.logRetentionDays,
      custom_policies: planConfig.customPolicies === -1 ? 'unlimited' : planConfig.customPolicies,
      webhooks: planConfig.webhooks,
      alerts: planConfig.alerts,
      analytics: planConfig.analytics,
      team_keys: planConfig.teamKeys,
      ip_allowlist: planConfig.ipAllowlist,
      audit_logs: planConfig.auditLogs,
      support: planConfig.support,
    },
  }, 200);
});

// ============================================================================
// POST /v1/billing/renew - Renew or upgrade existing subscription
// ============================================================================
const renewSchema = z.object({
  plan: z.enum(['starter', 'pro', 'scale']),
  months: z.number().refine((n): n is PeriodMonths => n === 1 || n === 3 || n === 6 || n === 12),
  chain: z.enum(['base', 'polygon']).optional().default('base'),
});

subscribeRoutes.post('/v1/billing/renew', async (c) => {
  const startMs = Date.now();

  // Require authorization
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ ok: false, error: 'missing_authorization' }, 401);
  }

  const apiKey = authHeader.slice(7).trim();
  if (!apiKey.startsWith('pg_ws_')) {
    return c.json({ ok: false, error: 'invalid_api_key_format' }, 401);
  }

  const apiKeyHash = await hashApiKey(apiKey);
  const stub = getBillingStub(c.env);

  // Look up workspace
  const lookupRes = await stub.fetch(doUrl('/keys/lookup'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key_hash: apiKeyHash }),
  });

  if (!lookupRes.ok) {
    return c.json({ ok: false, error: 'workspace_not_found' }, 404);
  }

  const { workspace_id: workspaceId } = await lookupRes.json() as { workspace_id: string };

  // Parse body
  const body = await c.req.json().catch(() => null);
  const parsed = renewSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ ok: false, error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const { plan, months, chain } = parsed.data;
  const totalUsdc = calculateTotal(plan, months as PeriodMonths);
  const chainId = getChainId(chain);
  const recipient = getBillingRecipient(c.env);

  const invoiceId = makeInvoiceId();
  const nowMs = Date.now();

  // Create invoice linked to existing workspace
  const invoice: Invoice = {
    id: invoiceId,
    plan,
    months,
    totalUsdc,
    chain,
    chainId,
    recipient,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + 30 * 60 * 1000,
    status: 'pending',
    workspaceId, // Link to existing workspace
    apiKey,
  };

  // Store invoice in Durable Object for persistence
  await storeInvoice(c.env, invoice);

  logEvent({
    event: 'renew_invoice_created',
    invoice_id: invoiceId,
    workspace_id: workspaceId,
    plan,
    months,
    total_usdc: totalUsdc,
    chain,
  });

  writeMetric(c.env, {
    indexes: ['renew_invoice_ok', plan, chain],
    doubles: [1, Date.now() - startMs, totalUsdc],
  });

  return c.json({
    ok: true,
    invoice_id: invoiceId,
    workspace_id: workspaceId,
    plan: PLANS[plan].name,
    months,
    total_usdc: totalUsdc,
    chain,
    chain_id: chainId,
    recipient,
    expires_at: new Date(invoice.expiresAtMs).toISOString(),
  }, 200);
});

// ============================================================================
// POST /v1/billing/renew/confirm - Confirm renewal payment
// ============================================================================
subscribeRoutes.post('/v1/billing/renew/confirm', async (c) => {
  const startMs = Date.now();

  const body = await c.req.json().catch(() => null);
  const parsed = confirmSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ ok: false, error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const { invoice_id, tx_hash } = parsed.data;
  
  // Check for replay attack - has this tx_hash already been used?
  {
    const replayStub = getBillingStub(c.env);
    const txCheckRes = await replayStub.fetch(doUrl(`/payments/by-tx/${tx_hash.toLowerCase()}`));
    if (txCheckRes.ok) {
      const existingPayment = await txCheckRes.json() as { ok: boolean; payment?: { workspaceId: string } };
      if (existingPayment.ok && existingPayment.payment) {
        logEvent({
          event: 'renew_confirm_replay_attempt',
          invoice_id,
          tx_hash,
          existing_workspace: existingPayment.payment.workspaceId,
        });
        return c.json({ 
          ok: false, 
          error: 'tx_already_used',
          message: 'This transaction has already been used.',
        }, 409);
      }
    }
  }

  const invoice = await getInvoice(c.env, invoice_id);

  if (!invoice) {
    return c.json({ ok: false, error: 'invoice_not_found' }, 404);
  }

  // Must be a renewal invoice (has workspaceId pre-set)
  if (!invoice.workspaceId) {
    return c.json({ ok: false, error: 'not_a_renewal_invoice' }, 400);
  }

  // Check if already confirmed
  if (invoice.status === 'confirmed') {
    return c.json({
      ok: true,
      status: 'confirmed',
      workspace_id: invoice.workspaceId,
      plan: PLANS[invoice.plan].name,
      months: invoice.months,
    }, 200);
  }

  // Check if expired
  if (Date.now() > invoice.expiresAtMs) {
    invoice.status = 'expired';
    await storeInvoice(c.env, invoice);
    return c.json({ ok: false, error: 'invoice_expired' }, 410);
  }

  // Verify payment on-chain
  invoice.status = 'confirming';
  invoice.txHash = tx_hash;
  await storeInvoice(c.env, invoice);

  const verified = await verifyUsdcTransfer(c.env, {
    txHash: tx_hash,
    chainId: invoice.chainId,
    expectedRecipient: invoice.recipient,
    expectedAmountUsdc: invoice.totalUsdc,
  });

  if (!verified.ok) {
    invoice.status = 'pending';
    await storeInvoice(c.env, invoice);
    return c.json({ ok: false, error: verified.error }, 402);
  }

  // Payment verified! Update workspace subscription
  const stub = getBillingStub(c.env);
  
  // Add credits
  const addCreditsRes = await stub.fetch(
    doUrl(`/workspaces/${invoice.workspaceId}/add-credits`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        credits: PLANS[invoice.plan].checks,
        plan: invoice.plan,
        months: invoice.months,
      }),
    }
  );

  if (!addCreditsRes.ok) {
    return c.json({ ok: false, error: 'credits_update_failed' }, 500);
  }

  // Mark invoice as confirmed
  invoice.status = 'confirmed';
  await storeInvoice(c.env, invoice);

  // Record payment in audit log
  await recordPayment(c.env, {
    invoiceId: invoice.id,
    workspaceId: invoice.workspaceId!,
    txHash: tx_hash,
    chain: invoice.chain,
    chainId: invoice.chainId,
    amountUsdc: invoice.totalUsdc,
    plan: invoice.plan,
    months: invoice.months,
    email: invoice.email,
    type: 'renewal',
  });

  logEvent({
    event: 'renew_confirmed',
    invoice_id,
    workspace_id: invoice.workspaceId,
    plan: invoice.plan,
    months: invoice.months,
    total_usdc: invoice.totalUsdc,
    tx_hash,
  });

  writeMetric(c.env, {
    indexes: ['renew_confirm_ok', invoice.plan, invoice.chain],
    doubles: [1, Date.now() - startMs, invoice.totalUsdc],
  });

  // Calculate new expiry date
  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + invoice.months);

  // Send webhook if configured (fire-and-forget)
  {
    const webhookRes = await stub.fetch(doUrl(`/workspaces/${invoice.workspaceId}/webhook`));
    if (webhookRes.ok) {
      const webhookConfig = await webhookRes.json() as { ok: boolean; webhook_url?: string; webhook_secret?: string };
      if (webhookConfig.ok && webhookConfig.webhook_url) {
        webhookSubscriptionRenewed(c.env, {
          webhookUrl: webhookConfig.webhook_url,
          webhookSecret: webhookConfig.webhook_secret,
          workspaceId: invoice.workspaceId!,
          plan: invoice.plan,
          months: invoice.months,
          creditsAdded: PLANS[invoice.plan].checks,
          newExpiresAt: expiresAt.toISOString(),
          txHash: tx_hash,
        }).catch(err => console.error('Webhook send failed:', err));
      }
    }
  }

  return c.json({
    ok: true,
    status: 'confirmed',
    workspace_id: invoice.workspaceId,
    plan: PLANS[invoice.plan].name,
    months: invoice.months,
    checks_added: PLANS[invoice.plan].checks,
    expires_at: expiresAt.toISOString(),
  }, 200);
});

// ============================================================================
// PUT /v1/billing/webhook - Configure webhook for workspace
// ============================================================================
const webhookConfigSchema = z.object({
  webhook_url: z.string().url().optional(),
  webhook_secret: z.string().min(16).optional(),
  events: z.array(z.enum([
    'subscription.created',
    'subscription.renewed',
    'credits.low',
    'subscription.expiring',
    'budget.exceeded',
  ])).optional(),
});

subscribeRoutes.put('/v1/billing/webhook', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ ok: false, error: 'missing_authorization' }, 401);
  }

  const apiKey = authHeader.slice(7).trim();
  if (!apiKey.startsWith('pg_ws_')) {
    return c.json({ ok: false, error: 'invalid_api_key_format' }, 401);
  }

  const apiKeyHash = await hashApiKey(apiKey);
  const stub = getBillingStub(c.env);

  // Look up workspace
  const lookupRes = await stub.fetch(doUrl('/keys/lookup'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key_hash: apiKeyHash }),
  });

  if (!lookupRes.ok) {
    return c.json({ ok: false, error: 'workspace_not_found' }, 404);
  }

  const { workspace_id: workspaceId } = await lookupRes.json() as { workspace_id: string };

  // Parse body
  const body = await c.req.json().catch(() => null);
  const parsed = webhookConfigSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ ok: false, error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const { webhook_url, webhook_secret, events } = parsed.data;

  // Update webhook config in DO
  const updateRes = await stub.fetch(
    doUrl(`/workspaces/${workspaceId}/webhook`),
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        webhook_url,
        webhook_secret,
        events: events || ['subscription.created', 'subscription.renewed', 'credits.low', 'subscription.expiring'],
      }),
    }
  );

  if (!updateRes.ok) {
    return c.json({ ok: false, error: 'update_failed' }, 500);
  }

  return c.json({
    ok: true,
    workspace_id: workspaceId,
    webhook_configured: !!webhook_url,
    events: events || ['subscription.created', 'subscription.renewed', 'credits.low', 'subscription.expiring'],
  }, 200);
});

// ============================================================================
// GET /v1/billing/webhook - Get webhook configuration
// ============================================================================
subscribeRoutes.get('/v1/billing/webhook', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ ok: false, error: 'missing_authorization' }, 401);
  }

  const apiKey = authHeader.slice(7).trim();
  if (!apiKey.startsWith('pg_ws_')) {
    return c.json({ ok: false, error: 'invalid_api_key_format' }, 401);
  }

  const apiKeyHash = await hashApiKey(apiKey);
  const stub = getBillingStub(c.env);

  // Look up workspace
  const lookupRes = await stub.fetch(doUrl('/keys/lookup'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key_hash: apiKeyHash }),
  });

  if (!lookupRes.ok) {
    return c.json({ ok: false, error: 'workspace_not_found' }, 404);
  }

  const { workspace_id: workspaceId } = await lookupRes.json() as { workspace_id: string };

  // Get webhook config
  const configRes = await stub.fetch(
    doUrl(`/workspaces/${workspaceId}/webhook`)
  );

  if (!configRes.ok) {
    return c.json({
      ok: true,
      workspace_id: workspaceId,
      webhook_configured: false,
    }, 200);
  }

  const config = await configRes.json() as { webhook_url?: string; events?: string[] };

  return c.json({
    ok: true,
    workspace_id: workspaceId,
    webhook_configured: !!config.webhook_url,
    webhook_url: config.webhook_url ? '***configured***' : null,
    events: config.events || [],
  }, 200);
});

// ============================================================================
// POST /v1/billing/webhook/test - Send a test webhook
// ============================================================================
subscribeRoutes.post('/v1/billing/webhook/test', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ ok: false, error: 'missing_authorization' }, 401);
  }

  const apiKey = authHeader.slice(7).trim();
  if (!apiKey.startsWith('pg_ws_')) {
    return c.json({ ok: false, error: 'invalid_api_key_format' }, 401);
  }

  const apiKeyHash = await hashApiKey(apiKey);
  const stub = getBillingStub(c.env);

  // Look up workspace
  const lookupRes = await stub.fetch(doUrl('/keys/lookup'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key_hash: apiKeyHash }),
  });

  if (!lookupRes.ok) {
    return c.json({ ok: false, error: 'workspace_not_found' }, 404);
  }

  const { workspace_id: workspaceId } = await lookupRes.json() as { workspace_id: string };

  // Get webhook config
  const configRes = await stub.fetch(
    doUrl(`/workspaces/${workspaceId}/webhook`)
  );

  if (!configRes.ok) {
    return c.json({ ok: false, error: 'webhook_not_configured' }, 400);
  }

  const config = await configRes.json() as { webhook_url?: string; webhook_secret?: string };

  if (!config.webhook_url) {
    return c.json({ ok: false, error: 'webhook_not_configured' }, 400);
  }

  // Send test webhook
  const testPayload = {
    event: 'test',
    timestamp: new Date().toISOString(),
    data: {
      workspace_id: workspaceId,
      message: 'This is a test webhook from ProceedGate. If you receive this, your webhook is configured correctly!',
    },
  };

  const result = await sendWebhook(config.webhook_url, testPayload, config.webhook_secret);

  if (!result.ok) {
    return c.json({
      ok: false,
      error: 'webhook_delivery_failed',
      details: {
        status_code: result.statusCode,
        message: result.error,
      },
    }, 502);
  }

  return c.json({
    ok: true,
    message: 'Test webhook sent successfully',
    status_code: result.statusCode,
  }, 200);
});

// ============================================================================
// ANALYTICS ENDPOINTS
// ============================================================================

// GET /v1/analytics - Get usage analytics for workspace
subscribeRoutes.get('/v1/analytics', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ ok: false, error: 'missing_authorization' }, 401);
  }

  const apiKey = authHeader.slice(7).trim();
  const apiKeyHash = await hashApiKey(apiKey);
  const stub = getBillingStub(c.env);
  
  // Look up workspace
  const lookupRes = await stub.fetch(doUrl('/keys/lookup'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key_hash: apiKeyHash }),
  });

  if (!lookupRes.ok) {
    return c.json({ ok: false, error: 'workspace_not_found' }, 404);
  }

  const { workspace_id: workspaceId } = await lookupRes.json() as { workspace_id: string };

  // Get subscription to check if analytics is enabled
  const subRes = await stub.fetch(doUrl(`/workspaces/${workspaceId}/subscription`));
  const subData = await subRes.json() as { plan?: string };
  const plan = (subData.plan || 'starter') as keyof typeof PLANS;
  
  if (!PLANS[plan]?.analytics) {
    return c.json({ 
      ok: false, 
      error: 'feature_not_available', 
      message: 'Analytics is not available on your plan. Upgrade to Starter or higher.',
      upgrade_url: 'https://proceedgate.dev/pay.html',
    }, 403);
  }

  // Get period from query params (default: last 30 days)
  const period = c.req.query('period') || '30d';
  
  // Get analytics data from DO
  const analyticsRes = await stub.fetch(
    doUrl(`/workspaces/${workspaceId}/analytics?period=${period}`)
  );
  
  if (!analyticsRes.ok) {
    return c.json({ ok: false, error: 'analytics_fetch_failed' }, 500);
  }

  const analyticsData = await analyticsRes.json() as object;

  return c.json({
    ok: true,
    workspace_id: workspaceId,
    period,
    ...analyticsData,
  }, 200);
});

// ============================================================================
// PROJECTS MANAGEMENT
// ============================================================================

// GET /v1/projects - List projects
subscribeRoutes.get('/v1/projects', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ ok: false, error: 'missing_authorization' }, 401);
  }

  const apiKey = authHeader.slice(7).trim();
  const apiKeyHash = await hashApiKey(apiKey);
  const stub = getBillingStub(c.env);
  
  const lookupRes = await stub.fetch(doUrl('/keys/lookup'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key_hash: apiKeyHash }),
  });

  if (!lookupRes.ok) {
    return c.json({ ok: false, error: 'workspace_not_found' }, 404);
  }

  const { workspace_id: workspaceId } = await lookupRes.json() as { workspace_id: string };

  // Get projects from DO
  const projectsRes = await stub.fetch(
    doUrl(`/workspaces/${workspaceId}/projects`)
  );
  
  const projectsData = await projectsRes.json() as { projects: unknown[] };

  return c.json({
    ok: true,
    ...projectsData,
  }, 200);
});

// POST /v1/projects - Create project
subscribeRoutes.post('/v1/projects', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ ok: false, error: 'missing_authorization' }, 401);
  }

  const apiKey = authHeader.slice(7).trim();
  const apiKeyHash = await hashApiKey(apiKey);
  const stub = getBillingStub(c.env);
  
  const lookupRes = await stub.fetch(doUrl('/keys/lookup'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key_hash: apiKeyHash }),
  });

  if (!lookupRes.ok) {
    return c.json({ ok: false, error: 'workspace_not_found' }, 404);
  }

  const { workspace_id: workspaceId } = await lookupRes.json() as { workspace_id: string };

  // Check project limits
  const subRes = await stub.fetch(doUrl(`/workspaces/${workspaceId}/subscription`));
  const subData = await subRes.json() as { plan?: string };
  const plan = (subData.plan || 'starter') as keyof typeof PLANS;
  const maxProjects = PLANS[plan]?.projects || 1;

  // Get current project count
  const projectsRes = await stub.fetch(
    doUrl(`/workspaces/${workspaceId}/projects`)
  );
  const projectsData = await projectsRes.json() as { projects: unknown[] };
  
  if (projectsData.projects.length >= maxProjects) {
    return c.json({ 
      ok: false, 
      error: 'project_limit_reached',
      message: `Your plan allows ${maxProjects} project(s). Upgrade to add more.`,
      current: projectsData.projects.length,
      limit: maxProjects,
    }, 403);
  }

  // Create project
  const body = await c.req.json().catch(() => null);
  const createRes = await stub.fetch(
    doUrl(`/workspaces/${workspaceId}/projects`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }
  );

  const result = await createRes.json() as object;
  return c.json(result, createRes.ok ? 201 : 400);
});

// DELETE /v1/projects/:id - Delete project
subscribeRoutes.delete('/v1/projects/:id', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ ok: false, error: 'missing_authorization' }, 401);
  }

  const apiKey = authHeader.slice(7).trim();
  const apiKeyHash = await hashApiKey(apiKey);
  const projectId = c.req.param('id');
  const stub = getBillingStub(c.env);
  
  const lookupRes = await stub.fetch(doUrl('/keys/lookup'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key_hash: apiKeyHash }),
  });

  if (!lookupRes.ok) {
    return c.json({ ok: false, error: 'workspace_not_found' }, 404);
  }

  const { workspace_id: workspaceId } = await lookupRes.json() as { workspace_id: string };

  // Delete project
  const deleteRes = await stub.fetch(
    doUrl(`/workspaces/${workspaceId}/projects/${projectId}`),
    { method: 'DELETE' }
  );

  if (!deleteRes.ok) {
    return c.json({ ok: false, error: 'project_not_found' }, 404);
  }

  return c.json({ ok: true }, 200);
});

// ============================================================================
// CUSTOM POLICIES MANAGEMENT
// ============================================================================

// GET /v1/policies - List custom policies
subscribeRoutes.get('/v1/policies', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ ok: false, error: 'missing_authorization' }, 401);
  }

  const apiKey = authHeader.slice(7).trim();
  const apiKeyHash = await hashApiKey(apiKey);
  const stub = getBillingStub(c.env);
  
  const lookupRes = await stub.fetch(doUrl('/keys/lookup'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key_hash: apiKeyHash }),
  });

  if (!lookupRes.ok) {
    return c.json({ ok: false, error: 'workspace_not_found' }, 404);
  }

  const { workspace_id: workspaceId } = await lookupRes.json() as { workspace_id: string };

  // Get policies from DO
  const policiesRes = await stub.fetch(
    doUrl(`/workspaces/${workspaceId}/policies`)
  );
  
  const policiesData = await policiesRes.json() as { policies: unknown[] };

  return c.json({
    ok: true,
    ...policiesData,
  }, 200);
});

// POST /v1/policies - Create custom policy
subscribeRoutes.post('/v1/policies', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ ok: false, error: 'missing_authorization' }, 401);
  }

  const apiKey = authHeader.slice(7).trim();
  const apiKeyHash = await hashApiKey(apiKey);
  const stub = getBillingStub(c.env);
  
  const lookupRes = await stub.fetch(doUrl('/keys/lookup'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key_hash: apiKeyHash }),
  });

  if (!lookupRes.ok) {
    return c.json({ ok: false, error: 'workspace_not_found' }, 404);
  }

  const { workspace_id: workspaceId } = await lookupRes.json() as { workspace_id: string };

  // Check custom policy limits
  const subRes = await stub.fetch(doUrl(`/workspaces/${workspaceId}/subscription`));
  const subData = await subRes.json() as { plan?: string };
  const plan = (subData.plan || 'starter') as keyof typeof PLANS;
  const maxPolicies = PLANS[plan]?.customPolicies || 0;

  if (maxPolicies === 0) {
    return c.json({ 
      ok: false, 
      error: 'feature_not_available',
      message: 'Custom policies are only available on Pro and Scale plans.',
    }, 403);
  }

  // Get current policy count
  const policiesRes = await stub.fetch(
    doUrl(`/workspaces/${workspaceId}/policies`)
  );
  const policiesData = await policiesRes.json() as { policies: unknown[] };
  
  // -1 means unlimited
  if (maxPolicies !== -1 && policiesData.policies.length >= maxPolicies) {
    return c.json({ 
      ok: false, 
      error: 'policy_limit_reached',
      message: `Your plan allows ${maxPolicies} custom policy(ies). Upgrade to Scale for unlimited.`,
      current: policiesData.policies.length,
      limit: maxPolicies,
    }, 403);
  }

  // Create policy
  const body = await c.req.json().catch(() => null);
  const createRes = await stub.fetch(
    doUrl(`/workspaces/${workspaceId}/policies`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }
  );

  const result = await createRes.json() as object;
  return c.json(result, createRes.ok ? 201 : 400);
});

// PUT /v1/policies/:id - Update custom policy
subscribeRoutes.put('/v1/policies/:id', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ ok: false, error: 'missing_authorization' }, 401);
  }

  const apiKey = authHeader.slice(7).trim();
  const apiKeyHash = await hashApiKey(apiKey);
  const policyId = c.req.param('id');
  const stub = getBillingStub(c.env);
  
  const lookupRes = await stub.fetch(doUrl('/keys/lookup'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key_hash: apiKeyHash }),
  });

  if (!lookupRes.ok) {
    return c.json({ ok: false, error: 'workspace_not_found' }, 404);
  }

  const { workspace_id: workspaceId } = await lookupRes.json() as { workspace_id: string };

  // Update policy
  const body = await c.req.json().catch(() => null);
  const updateRes = await stub.fetch(
    doUrl(`/workspaces/${workspaceId}/policies/${policyId}`),
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }
  );

  const result = await updateRes.json() as object;
  return c.json(result, updateRes.ok ? 200 : 400);
});

// DELETE /v1/policies/:id - Delete custom policy
subscribeRoutes.delete('/v1/policies/:id', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ ok: false, error: 'missing_authorization' }, 401);
  }

  const apiKey = authHeader.slice(7).trim();
  const apiKeyHash = await hashApiKey(apiKey);
  const policyId = c.req.param('id');
  const stub = getBillingStub(c.env);
  
  const lookupRes = await stub.fetch(doUrl('/keys/lookup'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key_hash: apiKeyHash }),
  });

  if (!lookupRes.ok) {
    return c.json({ ok: false, error: 'workspace_not_found' }, 404);
  }

  const { workspace_id: workspaceId } = await lookupRes.json() as { workspace_id: string };

  // Delete policy
  const deleteRes = await stub.fetch(
    doUrl(`/workspaces/${workspaceId}/policies/${policyId}`),
    { method: 'DELETE' }
  );

  if (!deleteRes.ok) {
    return c.json({ ok: false, error: 'policy_not_found' }, 404);
  }

  return c.json({ ok: true }, 200);
});

// ============================================================================
// Admin endpoints - Payment audit log (requires ADMIN_SECRET)
// ============================================================================

// GET /v1/admin/payments - List all payments
subscribeRoutes.get('/v1/admin/payments', async (c) => {
  const adminSecret = c.req.header('X-Admin-Secret');
  const expectedSecret = (c.env as Env & { ADMIN_SECRET?: string }).ADMIN_SECRET;
  
  if (!expectedSecret || adminSecret !== expectedSecret) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }

  const limit = parseInt(c.req.query('limit') || '50');
  const stub = getBillingStub(c.env);
  
  const res = await stub.fetch(doUrl(`/payments?limit=${limit}`));
  const data = await res.json() as { ok: boolean; payments: unknown[]; total: number };

  return c.json(data, 200);
});

// GET /v1/admin/payments/stats - Payment statistics
subscribeRoutes.get('/v1/admin/payments/stats', async (c) => {
  const adminSecret = c.req.header('X-Admin-Secret');
  const expectedSecret = (c.env as Env & { ADMIN_SECRET?: string }).ADMIN_SECRET;
  
  if (!expectedSecret || adminSecret !== expectedSecret) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }

  const stub = getBillingStub(c.env);
  const res = await stub.fetch(doUrl('/payments/stats'));
  const data = await res.json();

  return c.json(data, 200);
});

// GET /v1/admin/payments/by-tx/:txHash - Lookup payment by tx hash
subscribeRoutes.get('/v1/admin/payments/by-tx/:txHash', async (c) => {
  const adminSecret = c.req.header('X-Admin-Secret');
  const expectedSecret = (c.env as Env & { ADMIN_SECRET?: string }).ADMIN_SECRET;
  
  if (!expectedSecret || adminSecret !== expectedSecret) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }

  const txHash = c.req.param('txHash');
  const stub = getBillingStub(c.env);
  const res = await stub.fetch(doUrl(`/payments/by-tx/${txHash}`));
  const data = await res.json();

  return c.json(data, res.status as 200 | 404);
});

// GET /v1/admin/workspaces - List all workspaces with plan, credits, expiry
subscribeRoutes.get('/v1/admin/workspaces', async (c) => {
  const adminSecret = c.req.header('X-Admin-Secret');
  const expectedSecret = (c.env as Env & { ADMIN_SECRET?: string }).ADMIN_SECRET;

  if (!expectedSecret || adminSecret !== expectedSecret) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }

  const plan = c.req.query('plan') || ''; // optional filter: free, starter, pro, scale
  const stub = getBillingStub(c.env);
  const qs = plan ? `?plan=${encodeURIComponent(plan)}` : '';
  const res = await stub.fetch(doUrl(`/admin/workspaces${qs}`));
  const data = await res.json();

  return c.json(data, 200);
});

// POST /v1/admin/workspace - Manually create workspace (for missed payments)
subscribeRoutes.post('/v1/admin/workspace', async (c) => {
  const adminSecret = c.req.header('X-Admin-Secret');
  const expectedSecret = (c.env as Env & { ADMIN_SECRET?: string }).ADMIN_SECRET;
  
  if (!expectedSecret || adminSecret !== expectedSecret) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }

  const body = await c.req.json().catch(() => null) as {
    plan?: string;
    months?: number;
    email?: string;
    tx_hash?: string;
  } | null;

  if (!body) {
    return c.json({ ok: false, error: 'invalid_request' }, 400);
  }

  const plan = (body.plan || 'starter') as keyof typeof PLANS;
  const months = body.months || 1;
  const email = body.email;
  const txHash = body.tx_hash;

  // Generate credentials
  const workspaceId = makeWorkspaceId(plan);
  const apiKey = makeApiKey();
  const apiKeyHash = await hashApiKey(apiKey);

  // Create workspace in DO
  const stub = getBillingStub(c.env);
  const createRes = await stub.fetch(doUrl('/workspaces/create'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workspace_id: workspaceId,
      api_key_hash: apiKeyHash,
      plan: plan,
      credits: PLANS[plan].checks,
      expires_at_ms: Date.now() + months * 30 * 24 * 60 * 60 * 1000,
    }),
  });

  if (!createRes.ok) {
    return c.json({ ok: false, error: 'workspace_creation_failed' }, 500);
  }

  // Record payment if tx_hash provided
  if (txHash) {
    await recordPayment(c.env, {
      invoiceId: 'manual_' + Date.now(),
      workspaceId,
      txHash,
      chain: 'base',
      chainId: 8453,
      amountUsdc: PLANS[plan].priceMonthly * months,
      plan,
      months,
      email,
      type: 'subscription',
    });
  }

  // Send email if provided
  if (email) {
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + months);
    
    await sendSubscriptionConfirmation(c.env, {
      to: email,
      workspaceId,
      apiKey,
      plan: PLANS[plan].name,
      months,
      expiresAt: expiresAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      totalPaid: PLANS[plan].priceMonthly * months,
      txHash,
    }).catch(err => console.error('Email send failed:', err));
  }

  return c.json({
    ok: true,
    workspace_id: workspaceId,
    api_key: apiKey,
    plan: PLANS[plan].name,
    credits: PLANS[plan].checks,
    months,
  }, 201);
});

// ============================================================================
// FREE TIER SIGNUP
// ============================================================================

// POST /v1/billing/free - Create free tier workspace (no payment required)
subscribeRoutes.post('/v1/billing/free', async (c) => {
  const startMs = Date.now();
  const body = await c.req.json().catch(() => null);
  
  const parsed = freeSignupSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const { email } = parsed.data;
  const plan = 'free' as const;

  // Create workspace
  const workspaceId = makeWorkspaceId(plan);
  const apiKey = makeApiKey();
  const apiKeyHash = await hashApiKey(apiKey);

  // Store workspace in billing DO
  const stub = getBillingStub(c.env);
  const createRes = await stub.fetch(doUrl('/workspaces/create'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workspace_id: workspaceId,
      api_key_hash: apiKeyHash,
      plan: plan,
      credits: PLANS[plan].checks,
      expires_at_ms: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days for free tier
      features: {
        projects: PLANS[plan].projects,
        logRetentionDays: PLANS[plan].logRetentionDays,
        customPolicies: PLANS[plan].customPolicies,
        webhooks: PLANS[plan].webhooks,
        alerts: PLANS[plan].alerts,
        analytics: PLANS[plan].analytics,
        teamKeys: PLANS[plan].teamKeys,
        ipAllowlist: PLANS[plan].ipAllowlist,
        auditLogs: PLANS[plan].auditLogs,
      },
    }),
  });

  if (!createRes.ok) {
    logEvent({
      event: 'free_signup_workspace_create_fail',
      email,
    });
    return c.json({ ok: false, error: 'workspace_creation_failed' }, 500);
  }

  logEvent({
    event: 'free_signup_success',
    workspace_id: workspaceId,
    email,
  });

  writeMetric(c.env, {
    indexes: ['free_signup_ok'],
    doubles: [1, Date.now() - startMs],
  });

  // Send dedicated free-tier welcome email
  let emailSent = false;
  if (email) {
    const emailResult = await sendFreeWelcomeEmail(c.env, { to: email, workspaceId, apiKey })
      .catch(err => { console.error('Email send failed:', err); return { ok: false }; });
    emailSent = emailResult.ok;
    if (!emailSent) {
      console.warn('[free-signup] Email not sent for workspace:', workspaceId,
        '— set RESEND_API_KEY via: wrangler secret put RESEND_API_KEY');
    }
  }

  return c.json({
    ok: true,
    workspace_id: workspaceId,
    api_key: apiKey,
    plan: 'Free',
    credits: PLANS[plan].checks,
    email_sent: emailSent,
    features: {
      checks_per_month: PLANS[plan].checks,
      projects: PLANS[plan].projects,
      log_retention_days: PLANS[plan].logRetentionDays,
      custom_policies: PLANS[plan].customPolicies,
      webhooks: PLANS[plan].webhooks,
      alerts: PLANS[plan].alerts,
      analytics: PLANS[plan].analytics,
    },
    quickstart: {
      step_1: {
        description: 'Test your API key with the /me endpoint',
        curl: `curl https://governor.proceedgate.dev/v1/me -H "Authorization: Bearer ${apiKey}"`,
      },
      step_2: {
        description: 'Make your first billing check',
        curl: `curl -X POST https://governor.proceedgate.dev/v1/check/simple \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"user_id": "your-user-id"}'`,
      },
      step_3: {
        description: 'Check your remaining credits',
        curl: `curl "https://governor.proceedgate.dev/v1/billing/balance?workspace_id=${workspaceId}" \\
  -H "Authorization: Bearer ${apiKey}"`,
      },
      docs: 'https://docs.proceedgate.dev/quickstart',
      dashboard: `https://proceedgate.dev/dashboard?workspace=${workspaceId}`,
    },
  }, 201);
});

// ============================================================================
// ADMIN CREDITS ENDPOINT
// ============================================================================

// POST /v1/admin/credits - Add credits to existing workspace (admin only)
subscribeRoutes.post('/v1/admin/credits', async (c) => {
  const adminSecret = c.req.header('X-Admin-Secret');
  const expectedSecret = (c.env as Env & { ADMIN_SECRET?: string }).ADMIN_SECRET;
  
  if (!expectedSecret || adminSecret !== expectedSecret) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }

  const body = await c.req.json().catch(() => null) as {
    workspace_id?: string;
    credits?: number;
    plan?: string;
    months?: number;
  } | null;

  if (!body?.workspace_id || !body?.credits || body.credits <= 0) {
    return c.json({ ok: false, error: 'invalid_request', message: 'workspace_id and credits required' }, 400);
  }

  const stub = getBillingStub(c.env);
  const res = await stub.fetch(
    doUrl(`/workspaces/${encodeURIComponent(body.workspace_id)}/add-credits`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        credits: body.credits,
        plan: body.plan,
        months: body.months || 1,
      }),
    }
  );

  const data = await res.json();
  return c.json(data, res.status as 200 | 400 | 404);
});

// ============================================================================
// PLAN FEATURES ENDPOINT
// ============================================================================

// GET /v1/plans - Get all available plans with features
subscribeRoutes.get('/v1/plans', async (c) => {
  const plans = Object.entries(PLANS).map(([id, plan]) => ({
    id,
    name: plan.name,
    price_monthly: plan.priceMonthly,
    checks_per_month: plan.checks,
    projects: plan.projects,
    log_retention_days: plan.logRetentionDays,
    custom_policies: plan.customPolicies === -1 ? 'unlimited' : plan.customPolicies,
    webhooks: plan.webhooks,
    alerts: plan.alerts,
    analytics: plan.analytics,
    team_keys: plan.teamKeys,
    ip_allowlist: plan.ipAllowlist,
    audit_logs: plan.auditLogs,
    support: plan.support,
  }));

  return c.json({ ok: true, plans });
});

// ============================================================================
// /v1/me - Get workspace info from API key
// ============================================================================
subscribeRoutes.get('/v1/me', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({
      ok: false,
      error: 'missing_authorization',
      hint: 'Include Authorization header with Bearer token: Authorization: Bearer pg_ws_...',
      docs: 'https://docs.proceedgate.dev/authentication',
    }, 401);
  }

  const apiKey = authHeader.slice(7).trim();
  if (!apiKey.startsWith('pg_ws_')) {
    return c.json({
      ok: false,
      error: 'invalid_api_key_format',
      hint: 'API key should start with pg_ws_',
      docs: 'https://docs.proceedgate.dev/authentication',
    }, 401);
  }

  const apiKeyHash = await hashApiKey(apiKey);
  const stub = getBillingStub(c.env);

  // Look up workspace
  const lookupRes = await stub.fetch(doUrl('/keys/lookup'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key_hash: apiKeyHash }),
  });

  if (!lookupRes.ok) {
    return c.json({
      ok: false,
      error: 'workspace_not_found',
      hint: 'The API key is not associated with any workspace. It may have been revoked or never activated.',
      docs: 'https://docs.proceedgate.dev/errors/workspace-not-found',
    }, 404);
  }

  const { workspace_id: workspaceId } = await lookupRes.json() as { workspace_id: string };

  // Get balance
  const balanceRes = await stub.fetch(
    doUrl(`/workspaces/${workspaceId}`)
  );
  const balance = await balanceRes.json() as { credits: number };

  // Get subscription info
  const subRes = await stub.fetch(
    doUrl(`/workspaces/${workspaceId}/subscription`)
  );
  const subscription = subRes.ok 
    ? await subRes.json() as { plan: string; credits: number; expiresAtMs: number; createdAtMs: number }
    : null;

  // Get webhook config
  const webhookRes = await stub.fetch(
    doUrl(`/workspaces/${workspaceId}/webhook`)
  );
  const webhookConfigured = webhookRes.ok;

  // Determine plan and features
  const planId = (subscription?.plan || 'free') as PlanId;
  const plan = PLANS[planId] || PLANS.free;

  return c.json({
    ok: true,
    workspace_id: workspaceId,
    plan: {
      id: planId,
      name: plan.name,
    },
    credits: {
      remaining: balance.credits,
      included: plan.checks,
    },
    features: {
      projects: plan.projects,
      log_retention_days: plan.logRetentionDays,
      custom_policies: plan.customPolicies === -1 ? 'unlimited' : plan.customPolicies,
      webhooks: plan.webhooks,
      alerts: plan.alerts,
      analytics: plan.analytics,
      team_keys: plan.teamKeys,
      ip_allowlist: plan.ipAllowlist,
      audit_logs: plan.auditLogs,
      support: plan.support,
    },
    webhook_configured: webhookConfigured,
    subscription: subscription ? {
      expires_at: new Date(subscription.expiresAtMs).toISOString(),
      created_at: new Date(subscription.createdAtMs).toISOString(),
    } : null,
    quickstart: {
      check_endpoint: 'POST /v1/check/simple',
      example_curl: `curl -X POST https://governor.proceedgate.dev/v1/check/simple \\
  -H "Authorization: Bearer ${apiKey.slice(0, 20)}..." \\
  -H "Content-Type: application/json" \\
  -d '{"user_id": "your-user-id"}'`,
      docs: 'https://docs.proceedgate.dev/quickstart',
    },
  }, 200);
});

// ============================================================================
// /v1/me/stats - Real workspace stats (authenticated)
// ============================================================================
subscribeRoutes.get('/v1/me/stats', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ ok: false, error: 'missing_authorization' }, 401);
  }
  const apiKey = authHeader.slice(7).trim();
  if (!apiKey.startsWith('pg_ws_')) {
    return c.json({ ok: false, error: 'invalid_api_key_format' }, 401);
  }

  const apiKeyHash = await hashApiKey(apiKey);
  const stub = getBillingStub(c.env);

  const lookupRes = await stub.fetch(doUrl('/keys/lookup'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key_hash: apiKeyHash }),
  });
  if (!lookupRes.ok) {
    return c.json({ ok: false, error: 'workspace_not_found' }, 404);
  }
  const { workspace_id: workspaceId } = await lookupRes.json() as { workspace_id: string };

  const [statsRes, logRes, stormRes] = await Promise.all([
    stub.fetch(doUrl(`/workspaces/${workspaceId}/stats`)),
    stub.fetch(doUrl(`/workspaces/${workspaceId}/decision-log?limit=50`)),
    stub.fetch(doUrl(`/workspaces/${workspaceId}/storm-chart`)),
  ]);

  const stats = await statsRes.json() as Record<string, unknown>;
  const log = logRes.ok ? await logRes.json() as { decisions: unknown[]; total_count: number } : { decisions: [], total_count: 0 };
  const storm = stormRes.ok ? await stormRes.json() as { buckets: unknown[] } : { buckets: [] };

  return c.json({
    ok: true,
    workspace_id: workspaceId,
    total_decisions: log.total_count,
    storms_blocked: (stats as { blocked_requests?: number }).blocked_requests ?? 0,
    cost_saved_usd: (stats as { cost_saved_usd?: number }).cost_saved_usd ?? 0,
    blocked_by_reason: (stats as { blocked_by_reason?: Record<string, number> }).blocked_by_reason ?? {},
    last_blocked_at: (stats as { last_blocked_at?: string }).last_blocked_at ?? null,
    decisions: log.decisions,
    storm_chart: storm.buckets,
    data_source: 'real-time workspace data',
  });
});

export { subscribeRoutes };
