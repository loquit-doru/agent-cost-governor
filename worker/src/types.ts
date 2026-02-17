import type { Context } from 'hono';

export type Env = {
  // x402-style pricing headers
  X402_PRICE_DEFAULT?: string;
  X402_CHAIN?: string;
  X402_RECIPIENT?: string;

  // JWT
  PROCEED_TOKEN_TTL_SECONDS?: string;

  // Payment verification (MVP)
  PAYMENT_VERIFY_MODE?: string; // "stub" | "facilitator" | "onchain"

  // Facilitator verifier (v2): governor calls this service to validate tx
  FACILITATOR_URL?: string;
  FACILITATOR_KEY?: string;

  // Minimal onchain verifier inputs (used by the built-in facilitator endpoint)
  BASE_RPC_URL?: string;
  BASE_USDC_ADDRESS?: string;
  BSC_RPC_URL?: string;
  BSC_USDC_ADDRESS?: string;
  OPBNB_RPC_URL?: string;
  OPBNB_USDC_ADDRESS?: string;

  // Signing key: P-256 private JWK JSON string (stored as secret in prod)
  GOVERNOR_SIGNING_JWK?: string;

  // Workers AI (optional — used for real LLM-powered reasoning)
  AI?: {
    run(model: string, input: Record<string, unknown>): Promise<{ response?: string }>;
  };

  // Durable Objects
  DECISIONS: DurableObjectNamespace;
  BILLING: DurableObjectNamespace;

  // Billing (credits)
  BILLING_MODE?: string; // "off" | "credits"
  BILLING_CREDIT_COST_MICROUSDC?: string; // integer microUSDC per check (1e-6 USDC)
  BILLING_CHAIN?: string;
  BILLING_RECIPIENT?: string;

  // API auth (optional)
  // - off: no API key required
  // - shared: require a single shared API key (env.API_SHARED_KEY)
  // - workspace: require per-workspace API keys stored (hashed) in BILLING DO
  API_AUTH_MODE?: string; // "off" | "shared" | "workspace"
  API_SHARED_KEY?: string;
  API_ADMIN_KEY?: string;

  // Optional: Cloudflare Analytics Engine dataset binding
  METRICS?: {
    writeDataPoint: (point: { indexes?: string[]; doubles?: number[]; blobs?: string[] }) => void;
  };

  // Rate limiting
  RATE_LIMIT_CHECK_PER_MINUTE?: string;
  RATE_LIMIT_BILLING_PER_MINUTE?: string;

  // Pricing configuration (externalized)
  PRICING_FREE_ATTEMPTS?: string;
  PRICING_BASE?: string;
  PRICING_GROWTH?: string;
  PRICING_MAX?: string;
  PRICING_CONFIDENCE_THRESHOLD?: string;
  PRICING_CONFIDENCE_BASE?: string;
  PRICING_CONFIDENCE_MAX?: string;
  PRICING_CONFIDENCE_MULT?: string;

  // LLM cost pricing configuration
  LLM_COST_MARKUP?: string;
  LLM_COST_FREE_THRESHOLD?: string;
  LLM_COST_MAX?: string;

  // CORS
  CORS_ALLOWED_ORIGINS?: string; // comma-separated list

  // Dev-only escape hatch
  ALLOW_STUB_TX?: string;
};

export type Vars = {
  workspaceId?: string;
  requestId?: string;  // Unique request ID for log correlation
  rateLimit?: {
    remaining: number;
    reset: number;
  };
};

export type AppContext = Context<{ Bindings: Env; Variables: Vars }>;

// Policy and action types as constants
export const POLICY_IDS = ['retry_friction_v1', 'low_confidence_loop_v1'] as const;
export type PolicyId = (typeof POLICY_IDS)[number];

export const ACTIONS = ['model_call', 'tool_call', 'retry', 'override', 'plan_execute'] as const;
export type Action = (typeof ACTIONS)[number];

// Signing key cache type
export type SigningKeyCache =
  | { source: 'env'; envJwk: string; privateKey: CryptoKey; publicJwk: JsonWebKey & { kid: string }; kid: string }
  | { source: 'generated'; privateKey: CryptoKey; publicJwk: JsonWebKey & { kid: string }; kid: string }
  | null;

export type ApiAuthMode = 'off' | 'shared' | 'workspace';

export type BillingMode = 'off' | 'credits';
