import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';

export type VerifyProceedTokenParams = {
  issuer: string;
  actorId: string;
  decisionId: string;

  taskHash?: string;
  stepHash?: string;
  ctxHash?: string;

  audience?: string;

  /**
   * If true, verify the `prf` (proof) claim matches the expected binding.
   * Requires action + taskHash + stepHash + ctxHash to be provided.
   * Default: false (backwards compatible).
   */
  verifyProof?: boolean;
};

/**
 * Build the same proof hash used at signing time.
 * SHA-256(action:taskHash:stepHash:ctxHash) — must match worker's buildProof().
 */
async function computeProofHash(
  action: string,
  taskHash: string,
  stepHash: string,
  ctxHash: string,
): Promise<string> {
  const input = `${action}:${taskHash}:${stepHash}:${ctxHash}`;
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function verifyProceedToken(token: string, params: VerifyProceedTokenParams): Promise<void> {
  const jwksUrl = new URL('/.well-known/jwks.json', params.issuer);
  const JWKS = createRemoteJWKSet(jwksUrl);

  // Fix 1: Algorithm whitelist — reject 'none', 'HS256', etc.
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: params.issuer,
    audience: params.audience ?? 'agent-cost-governor',
    algorithms: ['ES256'],
  });

  if (String(payload.sub ?? '') !== params.actorId) throw new Error('proceed_token sub mismatch');
  if (String(payload.jti ?? '') !== params.decisionId) throw new Error('proceed_token jti mismatch');

  if (params.taskHash !== undefined && String(payload.task ?? '') !== String(params.taskHash)) {
    throw new Error('proceed_token task mismatch');
  }
  if (params.stepHash !== undefined && String(payload.step ?? '') !== String(params.stepHash)) {
    throw new Error('proceed_token step mismatch');
  }
  if (params.ctxHash !== undefined && String((payload as Record<string, unknown>).ctx ?? '') !== String(params.ctxHash)) {
    throw new Error('proceed_token ctx mismatch');
  }

  // Fix 3: Proof binding verification
  if (params.verifyProof) {
    const p = payload as JWTPayload & { act?: string; prf?: string };
    const tokenProof = String(p.prf ?? '');
    if (!tokenProof) throw new Error('proceed_token missing prf claim');

    const expectedProof = await computeProofHash(
      String(p.act ?? ''),
      params.taskHash ?? String(payload.task ?? ''),
      params.stepHash ?? String(payload.step ?? ''),
      params.ctxHash ?? String((payload as Record<string, unknown>).ctx ?? ''),
    );

    if (tokenProof !== expectedProof) {
      throw new Error('proceed_token proof mismatch — possible rebinding attack');
    }
  }
}
