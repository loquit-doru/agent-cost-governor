/**
 * Tool wrapper for ProceedGate cost governance
 */

import type { StructuredToolInterface } from '@langchain/core/tools';
import type {
  ProceedGateToolWrapperOptions,
  CheckRequest,
  CheckResponse,
  FrictionInfo,
} from './types.js';

export interface ProceedGateToolWrapper {
  wrap<T extends StructuredToolInterface>(tool: T): T;
}

/**
 * Wrap a LangChain tool with ProceedGate cost governance
 */
export function wrapToolWithGate<T extends StructuredToolInterface>(
  tool: T,
  options: ProceedGateToolWrapperOptions
): T {
  const { apiKey, workspaceId, baseUrl = 'https://governor.proceedgate.dev', policyId = 'retry_friction_v1', onFriction = 'warn' } = options;

  let attemptCount = 0;

  // Store original invoke method
  const originalInvoke = tool.invoke.bind(tool);

  // Override the invoke method
  (tool as unknown as { invoke: typeof originalInvoke }).invoke = async (input: unknown, config?: unknown) => {
    attemptCount++;

    const request: CheckRequest = {
      policy_id: policyId,
      action: 'tool_call',
      actor: {
        id: `langchain-tool:${workspaceId}`,
        project: workspaceId,
      },
      context: {
        attempt_in_window: attemptCount,
        window_seconds: 30,
        tool: tool.name,
        confidence: 0.9,
      },
    };

    const response = await fetch(`${baseUrl}/v1/governor/check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(request),
    });

    const data = (await response.json()) as CheckResponse;

    if (!data.allowed) {
      const info: FrictionInfo = {
        decisionId: data.decision_id,
        reasonCode: data.reason_code,
        price: data.policy.friction_price,
        action: 'tool_call',
        tool: tool.name,
      };

      if (onFriction === 'block') {
        throw new Error(`ProceedGate: Tool ${tool.name} blocked. Friction required: ${info.price}`);
      }

      if (onFriction === 'warn') {
        console.warn(`[ProceedGate] Tool ${tool.name} requires friction: ${info.price}`);
      } else {
        const shouldContinue = await onFriction(info);
        if (!shouldContinue) {
          throw new Error(`ProceedGate: Tool ${tool.name} blocked by custom handler`);
        }
      }
    }

    // Reset attempt count on success path
    if (data.allowed) {
      attemptCount = 0;
    }

    return originalInvoke(input, config as Parameters<typeof originalInvoke>[1]);
  };

  return tool;
}

/**
 * Create a reusable tool wrapper
 */
export function createToolWrapper(options: ProceedGateToolWrapperOptions): ProceedGateToolWrapper {
  return {
    wrap<T extends StructuredToolInterface>(tool: T): T {
      return wrapToolWithGate(tool, options);
    },
  };
}
