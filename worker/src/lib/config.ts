import type { Env, ApiAuthMode, BillingMode } from '../types.js';

// ============================================================================
// Token & JWT Configuration
// ============================================================================

export function getTtlSeconds(env: Env): number {
  const n = Number(env.PROCEED_TOKEN_TTL_SECONDS ?? '45');
  if (!Number.isFinite(n)) return 45;
  return Math.max(10, Math.min(300, Math.floor(n)));
}

// ============================================================================
// x402 Configuration
// ============================================================================

export function getX402Price(env: Env, price: string): string {
  const p = String(price || env.X402_PRICE_DEFAULT || '0.004 USDC').trim();
  return p || '0.004 USDC';
}

export function getX402Chain(env: Env): string {
  return String(env.X402_CHAIN ?? 'BSC').trim() || 'BSC';
}

export function getX402Recipient(env: Env): string {
  return String(env.X402_RECIPIENT ?? '').trim() || '0x0000000000000000000000000000000000000000';
}

// ============================================================================
// Billing Configuration
// ============================================================================

export function getBillingMode(env: Env): BillingMode {
  const m = String(env.BILLING_MODE ?? 'off').trim().toLowerCase();
  return m === 'credits' ? 'credits' : 'off';
}

export function getBillingCreditCostMicroUsdc(env: Env): number {
  const n = Number(env.BILLING_CREDIT_COST_MICROUSDC ?? '10');
  if (!Number.isFinite(n)) return 10;
  return Math.max(1, Math.min(1_000_000, Math.floor(n)));
}

export function getBillingChain(env: Env): string {
  return String(env.BILLING_CHAIN ?? env.X402_CHAIN ?? 'BSC').trim() || 'BSC';
}

export function getBillingRecipient(env: Env): string {
  return String(env.BILLING_RECIPIENT ?? env.X402_RECIPIENT ?? '').trim() || '0x0000000000000000000000000000000000000000';
}

// ============================================================================
// Auth Configuration
// ============================================================================

export function getApiAuthMode(env: Env): ApiAuthMode {
  const m = String(env.API_AUTH_MODE ?? 'off').trim().toLowerCase();
  if (m === 'shared') return 'shared';
  if (m === 'workspace') return 'workspace';
  return 'off';
}

export function getSharedApiKey(env: Env): string {
  return String(env.API_SHARED_KEY ?? '').trim();
}

export function getAdminApiKey(env: Env): string {
  return String(env.API_ADMIN_KEY ?? '').trim();
}

// ============================================================================
// Rate Limiting Configuration
// ============================================================================

export function getRateLimitCheckPerMinute(env: Env): number {
  const n = Number(env.RATE_LIMIT_CHECK_PER_MINUTE ?? '100');
  if (!Number.isFinite(n) || n <= 0) return 100;
  return Math.floor(n);
}

export function getRateLimitBillingPerMinute(env: Env): number {
  const n = Number(env.RATE_LIMIT_BILLING_PER_MINUTE ?? '20');
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.floor(n);
}

// ============================================================================
// Pricing Configuration (externalized constants)
// ============================================================================

export type PricingConfig = {
  freeAttempts: number;
  base: number;
  growth: number;
  maxPrice: number;
};

export type ConfidencePricingConfig = {
  threshold: number;
  base: number;
  maxPrice: number;
  mult: number;
};

export function getRetryPricingConfig(env: Env): PricingConfig {
  return {
    freeAttempts: Math.max(0, Number(env.PRICING_FREE_ATTEMPTS ?? '3') || 3),
    base: Math.max(0, Number(env.PRICING_BASE ?? '0.001') || 0.001),
    growth: Math.max(1, Number(env.PRICING_GROWTH ?? '1.8') || 1.8),
    maxPrice: Math.max(0, Number(env.PRICING_MAX ?? '0.02') || 0.02),
  };
}

export function getConfidencePricingConfig(env: Env): ConfidencePricingConfig {
  return {
    threshold: Math.max(0, Math.min(1, Number(env.PRICING_CONFIDENCE_THRESHOLD ?? '0.45') || 0.45)),
    base: Math.max(0, Number(env.PRICING_CONFIDENCE_BASE ?? '0.002') || 0.002),
    maxPrice: Math.max(0, Number(env.PRICING_CONFIDENCE_MAX ?? '0.05') || 0.05),
    mult: Math.max(0, Number(env.PRICING_CONFIDENCE_MULT ?? '2.0') || 2.0),
  };
}

// ============================================================================
// CORS Configuration
// ============================================================================

const DEFAULT_ALLOWED_ORIGINS = [
  'https://proceedgate.dev',
  'https://www.proceedgate.dev',
  'https://governor.proceedgate.dev',
  'http://localhost:8787',
  'http://localhost:8788',
  'http://localhost:8099',
  'http://127.0.0.1:8787',
  'http://127.0.0.1:8788',
  'http://127.0.0.1:8099',
];

export function getAllowedOrigins(env: Env): Set<string> {
  const custom = String(env.CORS_ALLOWED_ORIGINS ?? '').trim();
  if (custom) {
    const origins = custom.split(',').map((o) => o.trim()).filter(Boolean);
    return new Set([...DEFAULT_ALLOWED_ORIGINS, ...origins]);
  }
  return new Set(DEFAULT_ALLOWED_ORIGINS);
}

export function isOriginAllowed(env: Env, origin: string): boolean {
  if (!origin) return true; // No origin header = same-origin or non-browser
  const allowed = getAllowedOrigins(env);
  if (allowed.has(origin)) return true;
  // Allow Cloudflare Pages preview subdomains
  if (/^https:\/\/[a-z0-9-]+\.proceedgate\.pages\.dev$/.test(origin)) return true;
  return false;
}
