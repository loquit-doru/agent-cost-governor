/**
 * Vercel AI SDK middleware for ProceedGate cost governance.
 *
 * Wraps language model calls with governance checks.
 * Compatible with Vercel AI SDK v3+ `wrapLanguageModel` / middleware API.
 */

import type { ProceedGateOptions } from './types.js';
import { ProceedGateClient } from './client.js';
import { ProceedGateFrictionError } from './errors.js';

/**
 * Creates a Vercel AI SDK-compatible middleware that gates every
 * `doGenerate` and `doStream` call through ProceedGate.
 *
 * Usage:
 * ```ts
 * import { wrapLanguageModel } from 'ai';
 * import { proceedGateMiddleware } from '@proceedgate/vercel-ai';
 *
 * const model = wrapLanguageModel({
 *   model: openai('gpt-4o'),
 *   middleware: proceedGateMiddleware({
 *     apiKey: process.env.PG_KEY!,
 *     workspaceId: 'my-workspace',
 *   }),
 * });
 * ```
 */
export function proceedGateMiddleware(options: ProceedGateOptions) {
  const client = new ProceedGateClient(options);
  const onFriction = options.onFriction ?? 'block';

  async function gateCall(action: string, params: Record<string, unknown>) {
    const result = await client.check(action, {
      tool: 'llm',
      input_length: JSON.stringify(params.prompt ?? '').length,
    });

    if (!result.allowed) {
      if (onFriction === 'block') {
        throw new ProceedGateFrictionError(
          `LLM call blocked by ProceedGate: ${result.friction?.reason ?? 'friction required'}`,
          result.decisionId,
          result.friction,
        );
      }
      console.warn(
        `[ProceedGate] Warning: LLM call friction: ${result.friction?.reason ?? 'unknown'}`,
      );
    }

    return result;
  }

  return {
    // Middleware ID for debugging
    middlewareId: 'proceedgate-cost-governor',

    // Gate text generation
    transformParams: async ({ params }: { params: Record<string, unknown> }) => {
      await gateCall('model_call', params);
      return params;
    },

    // Expose client for inspection
    _client: client,
  };
}

/**
 * Higher-level helper: wraps `generateText` / `streamText` calls.
 *
 * Usage:
 * ```ts
 * import { generateText } from 'ai';
 * import { withProceedGate } from '@proceedgate/vercel-ai';
 *
 * const gate = withProceedGate({
 *   apiKey: process.env.PG_KEY!,
 *   workspaceId: 'my-workspace',
 * });
 *
 * const result = await gate(
 *   () => generateText({ model: openai('gpt-4o'), prompt: 'Hello' })
 * );
 * ```
 */
export function withProceedGate(options: ProceedGateOptions) {
  const client = new ProceedGateClient(options);
  const onFriction = options.onFriction ?? 'block';

  return async function gatedCall<T>(
    fn: () => Promise<T>,
    context: { action?: string; tool?: string } = {},
  ): Promise<T & { _proceedgate?: { allowed: boolean; cost: number } }> {
    const action = context.action ?? 'model_call';
    const result = await client.check(action, {
      tool: context.tool ?? 'llm',
    });

    if (!result.allowed) {
      if (onFriction === 'block') {
        throw new ProceedGateFrictionError(
          `Action '${action}' blocked: ${result.friction?.reason ?? 'friction required'}`,
          result.decisionId,
          result.friction,
        );
      }
      console.warn(`[ProceedGate] Warning: ${result.friction?.reason}`);
    }

    const output = await fn();
    return Object.assign(output as object, {
      _proceedgate: {
        allowed: result.allowed,
        cost: client.tracker.totalCost,
      },
    }) as T & { _proceedgate: { allowed: boolean; cost: number } };
  };
}
