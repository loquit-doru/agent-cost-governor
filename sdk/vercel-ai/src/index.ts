/**
 * @proceedgate/vercel-ai
 *
 * Vercel AI SDK integration for ProceedGate cost governance.
 * Gates LLM calls and tool invocations with retry storm detection and budget enforcement.
 */

export { proceedGateMiddleware, withProceedGate } from './middleware.js';
export { gatedTool, createGatedExecutor } from './tools.js';
export { ProceedGateClient } from './client.js';
export { ProceedGateFrictionError, ProceedGateBudgetError } from './errors.js';
export type {
  ProceedGateOptions,
  CheckResponse,
  CheckResponseOk,
  CheckResponse402,
  GateResult,
  CostTracker,
} from './types.js';
export type { GatedToolOptions } from './tools.js';
