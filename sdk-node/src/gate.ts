import type { GateStepInput, GateStepResult, GovernorCheckRequest, ProceedGateClient } from './types.js';
import { ProceedGateFrictionError } from './errors.js';

function envTxHash(envVar: string): string | undefined {
  // Keep explicit: only read env when user didn't pass txHash.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = (globalThis as any).process as { env?: Record<string, string | undefined> } | undefined;
    return p?.env?.[envVar];
  } catch {
    return undefined;
  }
}

export async function gateStep(client: ProceedGateClient, input: GateStepInput): Promise<GateStepResult> {
  const req: GovernorCheckRequest = {
    policy_id: input.policyId,
    action: input.action,
    actor: client.actor,
    context: input.context,
    idempotency_key: input.idempotencyKey,
  };

  const check = await client.check(req, { signal: input.signal });

  if (check.kind === 'ok') {
    return {
      kind: 'ok',
      decisionId: check.value.decision_id,
      proceedToken: check.value.proceed_token,
      expiresInSeconds: check.value.expires_in_seconds,
      reasonCode: check.value.reason_code,
      policyId: check.value.policy.policy_id,
      frictionRequired: check.value.policy.friction_required,
    };
  }

  const friction = {
    kind: 'friction' as const,
    decisionId: check.value.decision_id,
    reasonCode: check.value.reason_code,
    policyId: check.value.policy.policy_id,
    x402: check.x402,
    redeemUrl: check.value.redeem.url,
  };

  const txHashFromEnv = input.txHash ?? envTxHash(input.txHashEnvVar ?? 'PROCEEDGATE_TX_HASH');
  if (txHashFromEnv) {
    const redeemed = await client.redeem(friction.decisionId, txHashFromEnv, { signal: input.signal });
    return {
      kind: 'ok',
      decisionId: redeemed.decision_id,
      proceedToken: redeemed.proceed_token,
      expiresInSeconds: redeemed.expires_in_seconds,
      reasonCode: friction.reasonCode,
      policyId: friction.policyId,
      frictionRequired: true,
      redeemed: true,
      receipt: redeemed.receipt,
    };
  }

  if (input.onFriction) {
    const hookResult = await input.onFriction({
      decisionId: friction.decisionId,
      reasonCode: friction.reasonCode,
      policyId: friction.policyId,
      x402: friction.x402,
      redeemUrl: friction.redeemUrl,
    });

    if (hookResult && 'abort' in hookResult && hookResult.abort) {
      return friction;
    }

    const hookTxHash = hookResult && 'txHash' in hookResult ? hookResult.txHash : undefined;
    if (hookTxHash) {
      const redeemed = await client.redeem(friction.decisionId, hookTxHash, { signal: input.signal });
      return {
        kind: 'ok',
        decisionId: redeemed.decision_id,
        proceedToken: redeemed.proceed_token,
        expiresInSeconds: redeemed.expires_in_seconds,
        reasonCode: friction.reasonCode,
        policyId: friction.policyId,
        frictionRequired: true,
        redeemed: true,
        receipt: redeemed.receipt,
      };
    }
  }

  return friction;
}

export async function requireGateStepOk(client: ProceedGateClient, input: GateStepInput) {
  const res = await gateStep(client, input);
  if (res.kind === 'ok') return res;
  throw new ProceedGateFrictionError(res);
}
