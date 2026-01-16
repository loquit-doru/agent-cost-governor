export type GovernorCheckRequest = {
  policy_id: 'retry_friction_v1' | 'low_confidence_loop_v1';
  action: 'model_call' | 'tool_call' | 'retry' | 'override' | 'plan_execute';
  actor: { id: string; project?: string };
  context: {
    attempt_in_window: number;
    window_seconds?: number;
    confidence?: number;
    tool?: string;
    task_hash?: string;
    step_hash?: string;
    context_hash?: string;
    [k: string]: unknown;
  };
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

export type TaskFile = {
  actor_id?: string;
  project?: string;
  steps: Array<{
    name: string;
    policy_id: GovernorCheckRequest['policy_id'];
    action: GovernorCheckRequest['action'];
    tool?: string;
    confidence?: number;
    attempts?: number;
    window_seconds?: number;
  }>;
};
