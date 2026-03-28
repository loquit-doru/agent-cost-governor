/**
 * Tool wrapper for ProceedGate cost governance.
 *
 * Wraps Vercel AI SDK tools with governance checks.
 */

import type { ProceedGateOptions } from './types.js';
import { ProceedGateClient } from './client.js';
import { ProceedGateFrictionError } from './errors.js';

export interface GatedToolOptions {
  /** Override action type (default: 'tool_call') */
  action?: string;
  /** Custom cost estimate per call in USD */
  costEstimate?: number;
}

/**
 * Wraps a Vercel AI SDK tool definition with ProceedGate governance.
 *
 * Usage:
 * ```ts
 * import { tool } from 'ai';
 * import { z } from 'zod';
 * import { gatedTool } from '@proceedgate/vercel-ai';
 *
 * const gate = gatedTool({
 *   apiKey: process.env.PG_KEY!,
 *   workspaceId: 'my-workspace',
 * });
 *
 * const searchTool = gate(
 *   tool({
 *     description: 'Search the web',
 *     parameters: z.object({ query: z.string() }),
 *     execute: async ({ query }) => {
 *       return await fetch(`https://api.example.com/search?q=${query}`);
 *     },
 *   }),
 *   { action: 'tool_call', costEstimate: 0.01 }
 * );
 * ```
 */
export function gatedTool(options: ProceedGateOptions) {
  const client = new ProceedGateClient(options);
  const onFriction = options.onFriction ?? 'block';

  return function wrapTool<T extends { execute?: (...args: unknown[]) => unknown }>(
    toolDef: T,
    toolOptions: GatedToolOptions = {},
  ): T {
    const originalExecute = toolDef.execute;
    if (!originalExecute) return toolDef;

    const action = toolOptions.action ?? 'tool_call';

    const wrappedExecute = async (...args: unknown[]) => {
      const toolName =
        (toolDef as Record<string, unknown>).name ??
        (toolDef as Record<string, unknown>).description ??
        'unknown_tool';

      const result = await client.check(action, {
        tool: String(toolName),
        cost_estimate: toolOptions.costEstimate,
      });

      if (!result.allowed) {
        if (onFriction === 'block') {
          throw new ProceedGateFrictionError(
            `Tool '${String(toolName)}' blocked: ${result.friction?.reason ?? 'friction required'}`,
            result.decisionId,
            result.friction,
          );
        }
        console.warn(
          `[ProceedGate] Warning: Tool '${String(toolName)}' friction: ${result.friction?.reason}`,
        );
      }

      // Reset attempt count on success
      client.resetAttempt(`${action}:${String(toolName)}`);
      return originalExecute(...args);
    };

    return { ...toolDef, execute: wrappedExecute } as T;
  };
}

/**
 * Creates a gated tool executor function for use with `generateText` toolChoice.
 *
 * Usage:
 * ```ts
 * const executor = createGatedExecutor({
 *   apiKey: process.env.PG_KEY!,
 *   workspaceId: 'ws-id',
 * });
 *
 * const result = await generateText({
 *   model: openai('gpt-4o'),
 *   tools: {
 *     search: executor(searchTool),
 *     scrape: executor(scrapeTool),
 *   },
 * });
 * ```
 */
export function createGatedExecutor(options: ProceedGateOptions) {
  return gatedTool(options);
}
