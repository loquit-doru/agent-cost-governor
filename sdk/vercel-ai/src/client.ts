/**
 * ProceedGate API client for Vercel AI SDK integration
 */

import type {
  ProceedGateOptions,
  CheckRequest,
  CheckResponse,
  GateResult,
  CostTracker,
} from './types.js';

const DEFAULT_BASE_URL = 'https://governor.proceedgate.dev';

export class ProceedGateClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly workspaceId: string;
  private readonly policyId: string;
  private readonly agentId: string;
  private readonly onFriction: 'block' | 'warn';
  private readonly maxBudget?: number;

  private attemptCounts = new Map<string, number>();
  public tracker: CostTracker = {
    totalCost: 0,
    stepCount: 0,
    blocked: 0,
    allowed: 0,
  };

  constructor(options: ProceedGateOptions) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.apiKey = options.apiKey;
    this.workspaceId = options.workspaceId;
    this.policyId = options.policyId ?? 'retry_friction_v1';
    this.agentId = options.agentId ?? 'vercel-ai-agent';
    this.onFriction = options.onFriction ?? 'block';
    this.maxBudget = options.maxBudget;
  }

  private getAttempt(key: string): number {
    const count = (this.attemptCounts.get(key) ?? 0) + 1;
    this.attemptCounts.set(key, count);
    return count;
  }

  resetAttempt(key: string): void {
    this.attemptCounts.delete(key);
  }

  async check(
    action: string,
    context: Record<string, unknown> = {},
  ): Promise<GateResult> {
    // Budget check
    if (this.maxBudget && this.tracker.totalCost >= this.maxBudget) {
      return {
        allowed: false,
        zone: 'budget_exceeded',
        friction: {
          price: '0',
          reason: `Budget exceeded: $${this.tracker.totalCost.toFixed(2)} / $${this.maxBudget.toFixed(2)}`,
          chain: 'BSC',
        },
      };
    }

    const attemptKey = `${action}:${context.tool ?? 'default'}`;
    const attempt = this.getAttempt(attemptKey);

    const body: CheckRequest = {
      policy_id: this.policyId,
      action,
      actor: { id: this.agentId, project: this.workspaceId },
      context: {
        attempt_in_window: attempt,
        window_seconds: 60,
        ...context,
      },
    };

    try {
      const res = await fetch(`${this.baseUrl}/v1/governor/check`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'X-Workspace-Id': this.workspaceId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });

      const data = (await res.json()) as CheckResponse;

      if (data.allowed) {
        this.tracker.allowed++;
        this.tracker.stepCount++;
        return {
          allowed: true,
          decisionId: data.decision_id,
          proceedToken: data.proceed_token,
          zone: data.zone,
          iterationCount: data.iteration_count,
        };
      }

      // Friction required
      this.tracker.blocked++;
      const frictionData = data as Extract<CheckResponse, { allowed: false }>;
      return {
        allowed: false,
        decisionId: frictionData.decision_id,
        zone: frictionData.zone,
        iterationCount: frictionData.iteration_count,
        friction: {
          price: frictionData.policy?.friction_price ?? '0',
          reason: frictionData.policy?.reason ?? frictionData.reason_code,
          chain: frictionData.policy?.chain ?? 'BSC',
        },
      };
    } catch (err) {
      // Network error — fail closed by default
      console.warn('[ProceedGate] Check failed:', (err as Error).message);
      return { allowed: false, zone: 'error' };
    }
  }

  /** Reset all tracking state */
  reset(): void {
    this.attemptCounts.clear();
    this.tracker = { totalCost: 0, stepCount: 0, blocked: 0, allowed: 0 };
  }
}
