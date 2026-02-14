/**
 * Centralized constants for the application.
 * Single source of truth for all magic strings.
 */

// ============================================================================
// Durable Object Names
// ============================================================================

/**
 * DO instance names - must be consistent across all files!
 * Changing these will create NEW DO instances and lose existing data.
 */
export const DO_NAMES = {
  /** Billing store DO instance name */
  BILLING: 'billing-store',
  /** Decision store DO instance name */
  DECISIONS: 'decision-store',
} as const;

// ============================================================================
// Storage Key Prefixes
// ============================================================================

/**
 * Storage key prefixes used in BillingStoreDO.
 * Format: `${PREFIX}${workspaceId}` or `${PREFIX}${workspaceId}:${subKey}`
 */
export const STORAGE_KEYS = {
  /** Workspace balance: ws:{workspaceId} */
  WORKSPACE: 'ws:',
  /** Auth info: auth:{workspaceId} */
  AUTH: 'auth:',
  /** Budget config: budget:{workspaceId} */
  BUDGET: 'budget:',
  /** Usage records: usage:{workspaceId}:{date} */
  USAGE: 'usage:',
  /** Subscription: sub:{workspaceId} */
  SUBSCRIPTION: 'sub:',
  /** Quotes: quote:{quoteId} */
  QUOTE: 'quote:',
  /** Transaction hash: tx:{txHash} */
  TX: 'tx:',
  /** API key index: keyidx:{apiKeyHash} */
  KEY_INDEX: 'keyidx:',
  /** Webhook config: webhook:{workspaceId} */
  WEBHOOK: 'webhook:',
  /** Projects list: projects:{workspaceId} */
  PROJECTS: 'projects:',
  /** Project: project:{workspaceId}:{projectId} */
  PROJECT: 'project:',
  /** Custom policies list: custpolicies:{workspaceId} */
  CUSTOM_POLICIES: 'custpolicies:',
  /** Custom policy: custpolicy:{workspaceId}:{policyId} */
  CUSTOM_POLICY: 'custpolicy:',
  /** Invoice: invoice:{invoiceId} */
  INVOICE: 'invoice:',
  /** Payment record: payment:{paymentId} */
  PAYMENT: 'payment:',
  /** Credits low notification flag: credits_low_notified:{workspaceId} */
  CREDITS_LOW_NOTIFIED: 'credits_low_notified:',
} as const;

// ============================================================================
// API Key Prefixes
// ============================================================================

export const API_KEY_PREFIXES = {
  /** Workspace API key prefix */
  WORKSPACE: 'pg_ws_',
  /** Admin key prefix */
  ADMIN: 'pg_admin_',
} as const;

// ============================================================================
// Plan IDs
// ============================================================================

export const PLAN_IDS = {
  FREE: 'free',
  STARTER: 'starter',
  PRO: 'pro',
  ENTERPRISE: 'enterprise',
} as const;

// ============================================================================
// Credit Amounts
// ============================================================================

export const CREDITS = {
  /** Free tier credits */
  FREE_TIER: 2000,
  /** Starter plan credits */
  STARTER: 25000,
  /** Pro plan credits */
  PRO: 100000,
  /** Enterprise plan credits */
  ENTERPRISE: 500000,
} as const;
