import type {
  GateStepInput,
  GateStepResult,
  GateStepResultWithRaw,
  GovernorCheckRequest,
  ProceedGateClient,
} from './types.js';
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
  return gateStepInternal(client, input, { withRaw: false }) as Promise<GateStepResult>;
}

export async function gateStepWithRaw(client: ProceedGateClient, input: GateStepInput): Promise<GateStepResultWithRaw> {
  return gateStepInternal(client, input, { withRaw: true }) as Promise<GateStepResultWithRaw>;
}

async function gateStepInternal(
  client: ProceedGateClient,
  input: GateStepInput,
  opts: { withRaw: boolean },
): Promise<GateStepResult | GateStepResultWithRaw> {
  const req: GovernorCheckRequest = {
    policy_id: input.policyId,
    action: input.action,
    actor: client.actor,
    context: input.context,
    idempotency_key: input.idempotencyKey,
  };

  const check = await client.check(req, { signal: input.signal });

  if (check.kind === 'ok') {
    const normalized = {
      kind: 'ok' as const,
      decisionId: check.value.decision_id,
      proceedToken: check.value.proceed_token,
      expiresInSeconds: check.value.expires_in_seconds,
      reasonCode: check.value.reason_code,
      policyId: check.value.policy.policy_id,
      frictionRequired: check.value.policy.friction_required,
    };

    if (!opts.withRaw) return normalized;
    return { ...normalized, raw: { check: check.value } };
  }

  const friction = {
    kind: 'friction' as const,
    decisionId: check.value.decision_id,
    reasonCode: check.value.reason_code,
    policyId: check.value.policy.policy_id,
    x402: check.x402,
    redeemUrl: check.value.redeem.url,
  };

  const rawCheck402 = check.value;

  const txHashFromEnv = input.txHash ?? envTxHash(input.txHashEnvVar ?? 'PROCEEDGATE_TX_HASH');
  if (txHashFromEnv) {
    const redeemed = await client.redeem(friction.decisionId, txHashFromEnv, { signal: input.signal });
    const normalized = {
      kind: 'ok' as const,
      decisionId: redeemed.decision_id,
      proceedToken: redeemed.proceed_token,
      expiresInSeconds: redeemed.expires_in_seconds,
      reasonCode: friction.reasonCode,
      policyId: friction.policyId,
      frictionRequired: true,
      redeemed: true,
      receipt: redeemed.receipt,
    };

    if (!opts.withRaw) return normalized;
    return { ...normalized, raw: { check402: rawCheck402, redeem: redeemed } };
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
      if (!opts.withRaw) return friction;
      return { ...friction, raw: { check402: rawCheck402 } };
    }

    const hookTxHash = hookResult && 'txHash' in hookResult ? hookResult.txHash : undefined;
    if (hookTxHash) {
      const redeemed = await client.redeem(friction.decisionId, hookTxHash, { signal: input.signal });
      const normalized = {
        kind: 'ok' as const,
        decisionId: redeemed.decision_id,
        proceedToken: redeemed.proceed_token,
        expiresInSeconds: redeemed.expires_in_seconds,
        reasonCode: friction.reasonCode,
        policyId: friction.policyId,
        frictionRequired: true,
        redeemed: true,
        receipt: redeemed.receipt,
      };

      if (!opts.withRaw) return normalized;
      return { ...normalized, raw: { check402: rawCheck402, redeem: redeemed } };
    }
  }

  if (!opts.withRaw) return friction;
  return { ...friction, raw: { check402: rawCheck402 } };
}

export async function requireGateStepOk(client: ProceedGateClient, input: GateStepInput) {
  const res = await gateStep(client, input);
  if (res.kind === 'ok') return res;
  throw new ProceedGateFrictionError({
    decisionId: res.decisionId,
    policyId: input.policyId,
    action: input.action,
    reason: res.reasonCode,
    x402: res.x402,
  });
}

export async function requireGateStepOkWithRaw(client: ProceedGateClient, input: GateStepInput) {
  const res = await gateStepWithRaw(client, input);
  if (res.kind === 'ok') return res;
  // Explicit raw is returned only from the `*WithRaw` helpers, not through the error.
  throw new ProceedGateFrictionError({
    decisionId: res.decisionId,
    policyId: input.policyId,
    action: input.action,
    reason: res.reasonCode,
    x402: res.x402,
  });
}
