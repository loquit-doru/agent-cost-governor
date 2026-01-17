export type PolicyId = string;
export type Action = string;

export type Actor = {
  id: string;
  project?: string;
};

export type CheckContext = {
  attempt_in_window: number;
  window_seconds?: number;
  confidence?: number;
  tool?: string;
  task_hash?: string;
  step_hash?: string;
  context_hash?: string;
  [k: string]: unknown;
};

export type GovernorCheckRequest = {
  policy_id: PolicyId;
  action: Action;
  actor: Actor;
  context: CheckContext;
  idempotency_key?: string;
};

export type GovernorCheckOk = {
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
};

export type GovernorCheck402 = {
  allowed: false;
  decision_id: string;
  reason_code: string;
  policy: {
    policy_id: string;
    friction_required: true;
    friction_price: string;
    explain?: string;
  };
  redeem: {
    method: 'POST';
    url: string;
    requires_header: string;
  };
};

export type GovernorRedeemOk = {
  ok: true;
  decision_id: string;
  proceed_token: string;
  expires_in_seconds: number;
  receipt?: {
    tx_hash: string;
    paid_price: string;
    paid_chain: string;
    paid_at: string;
  };
};

export type X402Headers = {
  price: string;
  recipient: string;
  chain: string;
};

export type ProceedGateClientOptions = {
  baseUrl: string;
  actor: Actor;
  fetchImpl?: typeof fetch;
  defaultHeaders?: Record<string, string>;
};

export type GateStepInput = {
  policyId: PolicyId;
  action: Action;
  context: CheckContext;
  idempotencyKey?: string;

  /** Optional non-interactive friction handling. */
  txHash?: string;

  /** Fallback env var for txHash. Defaults to PROCEEDGATE_TX_HASH. */
  txHashEnvVar?: string;

  /** Optional hook for UI/wallet flows. */
  onFriction?: (info: {
    decisionId: string;
    reasonCode: string;
    policyId: string;
    x402: X402Headers;
    redeemUrl: string;
  }) => Promise<{ txHash: string } | { abort: true } | void>;

  signal?: AbortSignal;
};

export type GateStepOk = {
  kind: 'ok';
  decisionId: string;
  proceedToken: string;
  expiresInSeconds: number;
  reasonCode: string;
  policyId: string;
  frictionRequired: boolean;
  redeemed?: boolean;
  receipt?: GovernorRedeemOk['receipt'];
};

export type GateStepFriction = {
  kind: 'friction';
  decisionId: string;
  reasonCode: string;
  policyId: string;
  x402: X402Headers;
  redeemUrl: string;
};

export type GateStepResult = GateStepOk | GateStepFriction;

export type WithProceedGateGateOptions = {
  client: ProceedGateClient;
  policyId: PolicyId;
  action: Action;
  getContext: (...args: any[]) => CheckContext | Promise<CheckContext>;
  idempotencyKey?: (...args: any[]) => string | undefined;
  txHash?: string;
  txHashEnvVar?: string;
  onFriction?: GateStepInput['onFriction'];
};

// Circular-friendly interface type.
export type ProceedGateClient = {
  baseUrl: string;
  actor: Actor;
  check: (req: GovernorCheckRequest, opts?: { signal?: AbortSignal }) => Promise<
    | { kind: 'ok'; value: GovernorCheckOk }
    | { kind: '402'; value: GovernorCheck402; x402: X402Headers }
  >;
  redeem: (decisionId: string, txHash: string, opts?: { signal?: AbortSignal }) => Promise<GovernorRedeemOk>;
};
