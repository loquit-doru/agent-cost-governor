/**
 * ProceedGate Agent Executor
 * 
 * Wraps LangChain agent execution with cost governance.
 */

import type { AgentAction, AgentFinish } from '@langchain/core/agents';
import type { ChainValues } from '@langchain/core/utils/types';
import type {
  ProceedGateAgentExecutorOptions,
  CheckRequest,
  CheckResponse,
} from './types.js';

export interface AgentExecutorLike {
  invoke(input: ChainValues): Promise<ChainValues>;
}

export class ProceedGateAgentExecutor {
  private executor: AgentExecutorLike;
  private apiKey: string;
  private workspaceId: string;
  private baseUrl: string;
  private policyId: string;
  private maxBudget?: number;
  private onBudgetExceeded?: () => void;

  private totalCost = 0;
  private stepCount = 0;

  constructor(
    executor: AgentExecutorLike,
    options: ProceedGateAgentExecutorOptions
  ) {
    this.executor = executor;
    this.apiKey = options.apiKey;
    this.workspaceId = options.workspaceId;
    this.baseUrl = options.baseUrl ?? 'https://governor.proceedgate.dev';
    this.policyId = options.policyId ?? 'retry_friction_v1';
    this.maxBudget = options.maxBudget;
    this.onBudgetExceeded = options.onBudgetExceeded;
  }

  /**
   * Get total cost accumulated during execution
   */
  getTotalCost(): number {
    return this.totalCost;
  }

  /**
   * Get number of steps executed
   */
  getStepCount(): number {
    return this.stepCount;
  }

  /**
   * Reset tracking
   */
  reset(): void {
    this.totalCost = 0;
    this.stepCount = 0;
  }

  private async gateCheck(action: string, context: Record<string, unknown>): Promise<boolean> {
    const request: CheckRequest = {
      policy_id: this.policyId,
      action,
      actor: {
        id: `langchain-executor:${this.workspaceId}`,
        project: this.workspaceId,
      },
      context: {
        attempt_in_window: this.stepCount + 1,
        window_seconds: 300, // 5 minute window for agent execution
        ...context,
      },
    };

    const response = await fetch(`${this.baseUrl}/v1/governor/check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(request),
    });

    const data = (await response.json()) as CheckResponse;

    if (data.allowed) {
      // Track estimated cost (rough estimate based on friction price)
      const priceStr = data.policy.friction_price;
      const priceMatch = priceStr.match(/([\d.]+)/);
      if (priceMatch) {
        this.totalCost += parseFloat(priceMatch[1]);
      }
    }

    return data.allowed;
  }

  /**
   * Invoke the agent with cost governance
   */
  async invoke(input: ChainValues): Promise<ChainValues & { _proceedgate: { cost: number; steps: number } }> {
    this.reset();

    // Check budget before starting
    if (this.maxBudget !== undefined && this.totalCost >= this.maxBudget) {
      if (this.onBudgetExceeded) {
        this.onBudgetExceeded();
      }
      throw new Error(`ProceedGate: Budget exceeded before starting (${this.totalCost} >= ${this.maxBudget})`);
    }

    // Pre-execution gate check
    const allowed = await this.gateCheck('agent_execution', {
      input_length: JSON.stringify(input).length,
    });

    if (!allowed) {
      throw new Error('ProceedGate: Agent execution blocked');
    }

    this.stepCount++;

    // Execute the agent
    const result = await this.executor.invoke(input);

    // Post-execution budget check
    if (this.maxBudget !== undefined && this.totalCost > this.maxBudget) {
      console.warn(`[ProceedGate] Budget exceeded after execution: ${this.totalCost} > ${this.maxBudget}`);
      if (this.onBudgetExceeded) {
        this.onBudgetExceeded();
      }
    }

    return {
      ...result,
      _proceedgate: {
        cost: this.totalCost,
        steps: this.stepCount,
      },
    };
  }
}
