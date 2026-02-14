/**
 * Durable Object utilities and stub management.
 * Single source of truth for all DO interactions.
 */

import { z } from 'zod';
import type { Env } from '../types.js';
import { DO_NAMES } from './constants.js';

// ============================================================================
// DO Stub Getters
// ============================================================================

/**
 * Get the billing store DO stub.
 * All billing-related operations go through this single instance.
 */
export function getBillingStub(env: Env): DurableObjectStub {
  const id = env.BILLING.idFromName(DO_NAMES.BILLING);
  return env.BILLING.get(id);
}

/**
 * Get the decision store DO stub.
 * All decision-related operations go through this single instance.
 */
export function getDecisionStub(env: Env): DurableObjectStub {
  const id = env.DECISIONS.idFromName(DO_NAMES.DECISIONS);
  return env.DECISIONS.get(id);
}

// ============================================================================
// DO Request Helpers
// ============================================================================

/**
 * Build a DO internal URL.
 */
export function doUrl(path: string): string {
  return new URL(path, 'https://do.internal').toString();
}

/**
 * Make a typed request to the billing DO.
 */
export async function billingRequest<T>(
  env: Env,
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: unknown;
  } = {},
): Promise<{ ok: boolean; status: number; data: T }> {
  const stub = getBillingStub(env);
  const { method = 'GET', body } = options;

  const requestInit: RequestInit = {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  };

  const res = await stub.fetch(doUrl(path), requestInit);
  const data = await res.json().catch(() => ({})) as T;

  return {
    ok: res.ok,
    status: res.status,
    data,
  };
}

// ============================================================================
// Response Schemas (Zod)
// ============================================================================

/** Schema for workspace balance response */
export const WorkspaceBalanceSchema = z.object({
  workspace_id: z.string(),
  credits: z.number(),
});

/** Schema for consume response */
export const ConsumeResponseSchema = z.object({
  ok: z.boolean(),
  credits: z.number(),
  credits_low: z.boolean().optional(),
  credits_low_notify: z.boolean().optional(),
  max_credits: z.number().optional(),
  error: z.string().optional(),
  limit_type: z.string().optional(),
  current_usage: z.number().optional(),
});

/** Schema for API key lookup response */
export const KeyLookupResponseSchema = z.object({
  ok: z.boolean(),
  workspace_id: z.string().optional(),
  error: z.string().optional(),
});

/** Schema for subscription info response */
export const SubscriptionResponseSchema = z.object({
  ok: z.boolean(),
  workspace_id: z.string().optional(),
  plan: z.string().optional(),
  credits: z.number().optional(),
  expiresAtMs: z.number().optional(),
  createdAtMs: z.number().optional(),
  expires_at: z.string().optional(),
  created_at: z.string().optional(),
  features: z.object({
    projects: z.number().optional(),
    logRetentionDays: z.number().optional(),
    customPolicies: z.number().optional(),
    webhooks: z.boolean().optional(),
    alerts: z.boolean().optional(),
    analytics: z.boolean().optional(),
    teamKeys: z.number().optional(),
    ipAllowlist: z.boolean().optional(),
    auditLogs: z.boolean().optional(),
    support: z.string().optional(),
  }).optional(),
  error: z.string().optional(),
});

/** Schema for webhook config response */
export const WebhookConfigSchema = z.object({
  ok: z.boolean(),
  webhook_url: z.string().optional(),
  webhook_secret: z.string().optional(),
  error: z.string().optional(),
});

/** Schema for usage response */
export const UsageResponseSchema = z.object({
  workspace_id: z.string(),
  period: z.string(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  total_credits_used: z.number(),
  total_cost_usd: z.number(),
  breakdown: z.object({
    by_action: z.record(z.number()),
    by_tool: z.record(z.number()),
    by_day: z.array(z.object({
      date: z.string(),
      credits: z.number(),
      actions: z.record(z.number()),
      tools: z.record(z.number()),
    })),
  }),
});

/** Schema for budget config response */
export const BudgetConfigSchema = z.object({
  workspace_id: z.string(),
  has_budget: z.boolean(),
  daily_limit: z.number().optional(),
  weekly_limit: z.number().optional(),
  monthly_limit: z.number().optional(),
  alert_threshold: z.number().optional(),
  webhook_url: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  message: z.string().optional(),
});

// ============================================================================
// Type exports
// ============================================================================

export type WorkspaceBalance = z.infer<typeof WorkspaceBalanceSchema>;
export type ConsumeResponse = z.infer<typeof ConsumeResponseSchema>;
export type KeyLookupResponse = z.infer<typeof KeyLookupResponseSchema>;
export type SubscriptionResponse = z.infer<typeof SubscriptionResponseSchema>;
export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;
export type UsageResponse = z.infer<typeof UsageResponseSchema>;
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;
