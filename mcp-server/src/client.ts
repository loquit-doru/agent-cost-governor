/**
 * ProceedGate API Client for MCP Server
 */

export interface ProceedGateClientOptions {
  apiKey: string;
  baseUrl: string;
  workspaceId: string;
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
    cost_estimate?: number;
    task_hash?: string;
    step_hash?: string;
  };
  idempotency_key?: string;
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

export interface RedeemResponse {
  decision_id: string;
  proceed_token: string;
  expires_in_seconds: number;
  receipt: {
    tx_hash: string;
    verified_at: string;
  };
}

export interface BalanceResponse {
  workspace_id: string;
  credits: number;
  credits_used_today: number;
  credits_used_this_week: number;
  credits_used_this_month: number;
  budget?: {
    daily_limit?: number;
    weekly_limit?: number;
    monthly_limit?: number;
    alert_threshold?: number;
  };
}

export interface BudgetConfig {
  daily_limit?: number;
  weekly_limit?: number;
  monthly_limit?: number;
  alert_threshold?: number;
}

export interface UsageReport {
  period: string;
  start_date: string;
  end_date: string;
  total_credits_used: number;
  total_cost_usd: number;
  breakdown: {
    by_action: Record<string, number>;
    by_tool: Record<string, number>;
    by_day: Array<{ date: string; credits: number }>;
  };
}

export class ProceedGateClient {
  private apiKey: string;
  private baseUrl: string;
  private workspaceId: string;

  constructor(options: ProceedGateClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.workspaceId = options.workspaceId;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'X-Workspace-Id': this.workspaceId,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await response.json();

    if (!response.ok && response.status !== 402) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    return data as T;
  }

  /**
   * Check if an action is allowed under current policy/budget
   */
  async check(request: CheckRequest): Promise<CheckResponseOk | CheckResponse402> {
    return this.request<CheckResponseOk | CheckResponse402>(
      'POST',
      '/v1/governor/check',
      request
    );
  }

  /**
   * Redeem a decision after payment/friction resolution
   */
  async redeem(decisionId: string, txHash: string): Promise<RedeemResponse> {
    return this.request<RedeemResponse>(
      'POST',
      '/v1/governor/redeem',
      {
        decision_id: decisionId,
        tx_hash: txHash,
      }
    );
  }

  /**
   * Get current balance and usage
   */
  async getBalance(): Promise<BalanceResponse> {
    return this.request<BalanceResponse>(
      'GET',
      `/v1/billing/balance?workspace_id=${encodeURIComponent(this.workspaceId)}`
    );
  }

  /**
   * Set budget limits
   */
  async setBudget(config: BudgetConfig): Promise<BudgetConfig> {
    return this.request<BudgetConfig>(
      'POST',
      '/v1/billing/budget',
      {
        workspace_id: this.workspaceId,
        ...config,
      }
    );
  }

  /**
   * Get usage report
   */
  async getUsageReport(period: 'today' | 'week' | 'month' | 'all' = 'today'): Promise<UsageReport> {
    return this.request<UsageReport>(
      'GET',
      `/v1/billing/usage?workspace_id=${encodeURIComponent(this.workspaceId)}&period=${period}`
    );
  }

  /**
   * Get workspace ID
   */
  getWorkspaceId(): string {
    return this.workspaceId;
  }
}
