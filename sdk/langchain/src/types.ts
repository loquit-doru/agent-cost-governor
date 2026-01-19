/**
 * Type definitions for ProceedGate LangChain integration
 */

export interface ProceedGateClientOptions {
  apiKey: string;
  workspaceId: string;
  baseUrl?: string;
}

export interface ProceedGateCallbackHandlerOptions extends ProceedGateClientOptions {
  policyId?: string;
  onFriction?: 'block' | 'warn' | ((info: FrictionInfo) => Promise<boolean>);
  trackTokens?: boolean;
}

export interface ProceedGateToolWrapperOptions extends ProceedGateClientOptions {
  policyId?: string;
  onFriction?: 'block' | 'warn' | ((info: FrictionInfo) => Promise<boolean>);
}

export interface ProceedGateAgentExecutorOptions extends ProceedGateClientOptions {
  policyId?: string;
  maxBudget?: number;
  onBudgetExceeded?: () => void;
}

export interface GateCheckResult {
  allowed: boolean;
  decisionId: string;
  proceedToken?: string;
  reasonCode?: string;
  frictionPrice?: string;
}

export interface FrictionInfo {
  decisionId: string;
  reasonCode: string;
  price: string;
  action: string;
  tool?: string;
}

export interface CheckRequest {
  policy_id: string;
  action: string;
  actor: {
    id: string;
    project: string;
  };
  context: {
    attempt_in_window?: number;
    window_seconds?: number;
    confidence?: number;
    tool?: string;
    model?: string;
    input_tokens?: number;
    output_tokens?: number;
  };
}

export interface CheckResponseOk {
  allowed: true;
  decision_id: string;
  proceed_token: string;
  expires_in_seconds: number;
  reason_code: string;
  policy: {
    policy_id: string;
    friction_required: boolean;
    friction_price: string;
  };
}

export interface CheckResponse402 {
  allowed: false;
  decision_id: string;
  reason_code: string;
  policy: {
    policy_id: string;
    friction_required: boolean;
    friction_price: string;
  };
  redeem: {
    url: string;
    method: string;
  };
}

export type CheckResponse = CheckResponseOk | CheckResponse402;
