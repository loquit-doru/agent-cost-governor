import type { Action, PolicyId, X402Headers } from './types.js';

export type ProceedGateFrictionInfo = {
  price?: string;
  recipient?: string;
  chain?: string;
  reason: string;
};

export type ProceedGateFrictionErrorParams = {
  decisionId: string;
  policyId: PolicyId;
  action: Action;
  reason: string;
  x402?: Partial<X402Headers>;
};

export class ProceedGateFrictionError extends Error {
  public readonly code = 'PROCEEDGATE_FRICTION' as const;

  public readonly decisionId: string;
  public readonly policyId: PolicyId;
  public readonly action: Action;
  public readonly friction: ProceedGateFrictionInfo;

  constructor(params: ProceedGateFrictionErrorParams) {
    super(`ProceedGate friction required (decision_id=${params.decisionId})`);
    this.name = 'ProceedGateFrictionError';

    this.decisionId = params.decisionId;
    this.policyId = params.policyId;
    this.action = params.action;
    this.friction = {
      price: params.x402?.price,
      recipient: params.x402?.recipient,
      chain: params.x402?.chain,
      reason: params.reason,
    };
  }
}
