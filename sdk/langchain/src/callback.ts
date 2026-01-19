/**
 * ProceedGate Callback Handler for LangChain
 * 
 * Intercepts LLM calls and tool invocations to enforce cost governance.
 */

import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { Serialized } from '@langchain/core/load/serializable';
import type { LLMResult } from '@langchain/core/outputs';
import type {
  ProceedGateCallbackHandlerOptions,
  CheckRequest,
  CheckResponse,
  FrictionInfo,
  GateCheckResult,
} from './types.js';

export class ProceedGateCallbackHandler extends BaseCallbackHandler {
  name = 'ProceedGateCallbackHandler';
  
  private apiKey: string;
  private workspaceId: string;
  private baseUrl: string;
  private policyId: string;
  private onFriction: 'block' | 'warn' | ((info: FrictionInfo) => Promise<boolean>);
  private trackTokens: boolean;

  private attemptCounts: Map<string, number> = new Map();
  private totalCost = 0;
  private eventListeners: Map<string, Array<(data: unknown) => void>> = new Map();

  constructor(options: ProceedGateCallbackHandlerOptions) {
    super();
    this.apiKey = options.apiKey;
    this.workspaceId = options.workspaceId;
    this.baseUrl = options.baseUrl ?? 'https://governor.proceedgate.dev';
    this.policyId = options.policyId ?? 'retry_friction_v1';
    this.onFriction = options.onFriction ?? 'warn';
    this.trackTokens = options.trackTokens ?? true;
  }

  /**
   * Register event listener
   */
  on(event: 'gate_check' | 'friction' | 'cost', callback: (data: unknown) => void): void {
    const listeners = this.eventListeners.get(event) ?? [];
    listeners.push(callback);
    this.eventListeners.set(event, listeners);
  }

  private emit(event: string, data: unknown): void {
    const listeners = this.eventListeners.get(event) ?? [];
    for (const listener of listeners) {
      try {
        listener(data);
      } catch {
        // Ignore listener errors
      }
    }
  }

  /**
   * Get total accumulated cost
   */
  getTotalCost(): number {
    return this.totalCost;
  }

  /**
   * Reset cost tracking
   */
  resetCost(): void {
    this.totalCost = 0;
    this.attemptCounts.clear();
  }

  private async gateCheck(action: string, context: Record<string, unknown>): Promise<GateCheckResult> {
    const attemptKey = `${action}:${context.tool ?? 'default'}`;
    const attempt = (this.attemptCounts.get(attemptKey) ?? 0) + 1;
    this.attemptCounts.set(attemptKey, attempt);

    const request: CheckRequest = {
      policy_id: this.policyId,
      action,
      actor: {
        id: `langchain-agent:${this.workspaceId}`,
        project: this.workspaceId,
      },
      context: {
        attempt_in_window: attempt,
        window_seconds: 30,
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

    const result: GateCheckResult = {
      allowed: data.allowed,
      decisionId: data.decision_id,
      proceedToken: data.allowed ? data.proceed_token : undefined,
      reasonCode: data.reason_code,
      frictionPrice: data.policy.friction_price,
    };

    this.emit('gate_check', result);
    return result;
  }

  private async handleFriction(info: FrictionInfo): Promise<boolean> {
    this.emit('friction', info);

    if (this.onFriction === 'block') {
      throw new Error(`ProceedGate: Action blocked. Friction required: ${info.price}`);
    }

    if (this.onFriction === 'warn') {
      console.warn(`[ProceedGate] Friction required for ${info.action}: ${info.price}`);
      return true; // Continue anyway
    }

    // Custom handler
    return this.onFriction(info);
  }

  /**
   * Called before LLM starts
   */
  async handleLLMStart(
    llm: Serialized,
    prompts: string[],
    _runId: string,
    _parentRunId?: string,
    extraParams?: Record<string, unknown>,
  ): Promise<void> {
    // Extract model name from serialized LLM or extraParams
    let model = 'unknown';
    if (extraParams?.invocation_params) {
      const params = extraParams.invocation_params as Record<string, unknown>;
      model = String(params.model_name ?? params.model ?? 'unknown');
    } else if ('kwargs' in llm && llm.kwargs) {
      const kwargs = llm.kwargs as Record<string, unknown>;
      model = String(kwargs.model_name ?? kwargs.model ?? 'unknown');
    }

    // Estimate input tokens (rough: 4 chars per token)
    const inputTokens = prompts.reduce((sum, p) => sum + Math.ceil(p.length / 4), 0);

    const result = await this.gateCheck('llm_call', {
      model: String(model),
      input_tokens: inputTokens,
      confidence: 0.8,
    });

    if (!result.allowed) {
      const shouldContinue = await this.handleFriction({
        decisionId: result.decisionId,
        reasonCode: result.reasonCode ?? 'friction',
        price: result.frictionPrice ?? 'unknown',
        action: 'llm_call',
      });

      if (!shouldContinue) {
        throw new Error(`ProceedGate: LLM call blocked`);
      }
    }
  }

  /**
   * Called after LLM ends
   */
  async handleLLMEnd(output: LLMResult): Promise<void> {
    if (this.trackTokens && output.llmOutput) {
      const usage = output.llmOutput.tokenUsage as {
        promptTokens?: number;
        completionTokens?: number;
      } | undefined;

      if (usage) {
        // Rough cost estimate (using GPT-4o pricing as baseline)
        const inputCost = ((usage.promptTokens ?? 0) / 1000) * 0.0025;
        const outputCost = ((usage.completionTokens ?? 0) / 1000) * 0.01;
        this.totalCost += inputCost + outputCost;
        this.emit('cost', this.totalCost);
      }
    }
  }

  /**
   * Called before tool starts
   */
  async handleToolStart(
    tool: Serialized,
    input: string,
    _runId: string,
  ): Promise<void> {
    const toolName = tool.id?.[tool.id.length - 1] ?? 'unknown';

    const result = await this.gateCheck('tool_call', {
      tool: toolName,
      confidence: 0.9,
    });

    if (!result.allowed) {
      const shouldContinue = await this.handleFriction({
        decisionId: result.decisionId,
        reasonCode: result.reasonCode ?? 'friction',
        price: result.frictionPrice ?? 'unknown',
        action: 'tool_call',
        tool: toolName,
      });

      if (!shouldContinue) {
        throw new Error(`ProceedGate: Tool ${toolName} blocked`);
      }
    }
  }
}
