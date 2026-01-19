/**
 * @proceedgate/langchain
 * 
 * LangChain integration for ProceedGate cost governance.
 * Provides callback handlers, tool wrappers, and agent executors
 * with built-in cost control.
 */

export { ProceedGateCallbackHandler } from './callback.js';
export { wrapToolWithGate, ProceedGateToolWrapper } from './tools.js';
export { ProceedGateAgentExecutor } from './executor.js';
export type {
  ProceedGateCallbackHandlerOptions,
  ProceedGateToolWrapperOptions,
  ProceedGateAgentExecutorOptions,
  GateCheckResult,
  FrictionInfo,
} from './types.js';
