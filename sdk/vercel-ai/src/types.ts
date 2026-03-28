/**
 * ProceedGate Vercel AI SDK types
 */

export interface ProceedGateOptions {
  /** ProceedGate API key (pg_ws_...) */
  apiKey: string;
  /** Workspace ID */
  workspaceId: string;
  /** Governor API base URL */
  baseUrl?: string;
  /** Policy ID for governance checks */
  policyId?: string;
  /** Agent identifier */
  agentId?: string;
  /** What to do on friction: block (throw), warn (log + continue) */
  onFriction?: 'block' | 'warn';
  /** Maximum budget in USD before blocking */
  maxBudget?: number;
}

export interface CheckRequest {
  policy_id: string;
  action: string;
  actor: { id: string; project: string };
  context: Record<string, unknown>;
}

export interface CheckResponseOk {
  allowed: true;
  decision_id: string;
  proceed_token: string;
  zone: string;
  iteration_count: number;
  credits_remaining: number;
}

export interface CheckResponse402 {
  allowed: false;
  decision_id: string;
  reason_code: string;
  zone: string;
  iteration_count: number;
  policy: {
    friction_price?: string;
    recipient?: string;
    chain?: string;
    reason?: string;
  };
}

export type CheckResponse = CheckResponseOk | CheckResponse402;

export interface GateResult {
  allowed: boolean;
  decisionId?: string;
  proceedToken?: string;
  zone?: string;
  iterationCount?: number;
  friction?: {
    price: string;
    reason: string;
    chain: string;
  };
}

export interface CostTracker {
  totalCost: number;
  stepCount: number;
  blocked: number;
  allowed: number;
}
