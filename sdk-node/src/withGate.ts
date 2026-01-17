import type { WithProceedGateGateOptions } from './types.js';
import { requireGateStepOk } from './gate.js';

export function withProceedGateGate<TArgs extends any[], TResult>(
  opts: WithProceedGateGateOptions,
  fn: (...args: TArgs) => Promise<TResult> | TResult,
) {
  return async (...args: TArgs): Promise<{ result: TResult; gate: Awaited<ReturnType<typeof requireGateStepOk>> }> => {
    const context = await opts.getContext(...args);
    const gate = await requireGateStepOk(opts.client, {
      policyId: opts.policyId,
      action: opts.action,
      context,
      idempotencyKey: opts.idempotencyKey?.(...args),
      txHash: opts.txHash,
      txHashEnvVar: opts.txHashEnvVar,
      onFriction: opts.onFriction,
    });

    const result = await fn(...args);
    return { result, gate };
  };
}
