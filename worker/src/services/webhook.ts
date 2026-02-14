/**
 * Webhook notification service for ProceedGate
 * 
 * Sends webhook notifications for various events:
 * - subscription.created
 * - subscription.renewed
 * - credits.low
 * - subscription.expiring
 */

import type { Env } from '../types.js';
import { logEvent } from '../observability.js';

export interface WebhookPayload {
  event: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface WebhookResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
}

/**
 * Send a webhook notification to a URL
 */
export async function sendWebhook(
  url: string,
  payload: WebhookPayload,
  secret?: string
): Promise<WebhookResult> {
  try {
    const body = JSON.stringify(payload);
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'ProceedGate-Webhook/1.0',
      'X-ProceedGate-Event': payload.event,
      'X-ProceedGate-Timestamp': payload.timestamp,
    };

    // Add signature if secret is provided
    if (secret) {
      const signature = await signPayload(body, secret);
      headers['X-ProceedGate-Signature'] = signature;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
    });

    if (!res.ok) {
      return {
        ok: false,
        statusCode: res.status,
        error: `HTTP ${res.status}: ${res.statusText}`,
      };
    }

    return { ok: true, statusCode: res.status };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, error };
  }
}

/**
 * Sign payload with HMAC-SHA256
 */
async function signPayload(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const hashArray = Array.from(new Uint8Array(signature));
  return 'sha256=' + hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ============================================================================
// Webhook event senders
// ============================================================================

/**
 * Send subscription.created webhook
 */
export async function webhookSubscriptionCreated(
  env: Env,
  data: {
    webhookUrl: string;
    webhookSecret?: string;
    workspaceId: string;
    plan: string;
    months: number;
    credits: number;
    expiresAt: string;
    txHash: string;
  }
): Promise<void> {
  const payload: WebhookPayload = {
    event: 'subscription.created',
    timestamp: new Date().toISOString(),
    data: {
      workspace_id: data.workspaceId,
      plan: data.plan,
      months: data.months,
      credits: data.credits,
      expires_at: data.expiresAt,
      tx_hash: data.txHash,
    },
  };

  const result = await sendWebhook(data.webhookUrl, payload, data.webhookSecret);
  
  logEvent({
    event: 'webhook_sent',
    webhook_event: 'subscription.created',
    workspace_id: data.workspaceId,
    ok: result.ok,
    status_code: result.statusCode,
    error: result.error,
  });
}

/**
 * Send subscription.renewed webhook
 */
export async function webhookSubscriptionRenewed(
  env: Env,
  data: {
    webhookUrl: string;
    webhookSecret?: string;
    workspaceId: string;
    plan: string;
    months: number;
    creditsAdded: number;
    newExpiresAt: string;
    txHash: string;
  }
): Promise<void> {
  const payload: WebhookPayload = {
    event: 'subscription.renewed',
    timestamp: new Date().toISOString(),
    data: {
      workspace_id: data.workspaceId,
      plan: data.plan,
      months: data.months,
      credits_added: data.creditsAdded,
      new_expires_at: data.newExpiresAt,
      tx_hash: data.txHash,
    },
  };

  const result = await sendWebhook(data.webhookUrl, payload, data.webhookSecret);
  
  logEvent({
    event: 'webhook_sent',
    webhook_event: 'subscription.renewed',
    workspace_id: data.workspaceId,
    ok: result.ok,
    status_code: result.statusCode,
    error: result.error,
  });
}

/**
 * Send credits.low webhook
 */
export async function webhookCreditsLow(
  env: Env,
  data: {
    webhookUrl: string;
    webhookSecret?: string;
    workspaceId: string;
    creditsRemaining: number;
    thresholdPercent: number;
    maxCredits: number;
  }
): Promise<void> {
  const payload: WebhookPayload = {
    event: 'credits.low',
    timestamp: new Date().toISOString(),
    data: {
      workspace_id: data.workspaceId,
      credits_remaining: data.creditsRemaining,
      threshold_percent: data.thresholdPercent,
      max_credits: data.maxCredits,
      usage_percent: Math.round((1 - data.creditsRemaining / data.maxCredits) * 100),
    },
  };

  const result = await sendWebhook(data.webhookUrl, payload, data.webhookSecret);
  
  logEvent({
    event: 'webhook_sent',
    webhook_event: 'credits.low',
    workspace_id: data.workspaceId,
    ok: result.ok,
    status_code: result.statusCode,
    error: result.error,
  });
}

/**
 * Send subscription.expiring webhook
 */
export async function webhookSubscriptionExpiring(
  env: Env,
  data: {
    webhookUrl: string;
    webhookSecret?: string;
    workspaceId: string;
    expiresAt: string;
    daysRemaining: number;
  }
): Promise<void> {
  const payload: WebhookPayload = {
    event: 'subscription.expiring',
    timestamp: new Date().toISOString(),
    data: {
      workspace_id: data.workspaceId,
      expires_at: data.expiresAt,
      days_remaining: data.daysRemaining,
    },
  };

  const result = await sendWebhook(data.webhookUrl, payload, data.webhookSecret);
  
  logEvent({
    event: 'webhook_sent',
    webhook_event: 'subscription.expiring',
    workspace_id: data.workspaceId,
    ok: result.ok,
    status_code: result.statusCode,
    error: result.error,
  });
}

/**
 * Send budget.exceeded webhook
 */
export async function webhookBudgetExceeded(
  env: Env,
  data: {
    webhookUrl: string;
    webhookSecret?: string;
    workspaceId: string;
    limitType: 'daily' | 'weekly' | 'monthly';
    limit: number;
    usage: number;
  }
): Promise<void> {
  const payload: WebhookPayload = {
    event: 'budget.exceeded',
    timestamp: new Date().toISOString(),
    data: {
      workspace_id: data.workspaceId,
      limit_type: data.limitType,
      limit: data.limit,
      current_usage: data.usage,
    },
  };

  const result = await sendWebhook(data.webhookUrl, payload, data.webhookSecret);
  
  logEvent({
    event: 'webhook_sent',
    webhook_event: 'budget.exceeded',
    workspace_id: data.workspaceId,
    ok: result.ok,
    status_code: result.statusCode,
    error: result.error,
  });
}
