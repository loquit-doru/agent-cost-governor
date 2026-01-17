import { createRemoteJWKSet, jwtVerify } from 'jose';

export type VerifyProceedTokenParams = {
  issuer: string;
  actorId: string;
  decisionId: string;

  taskHash?: string;
  stepHash?: string;
  ctxHash?: string;

  audience?: string;
};

export async function verifyProceedToken(token: string, params: VerifyProceedTokenParams): Promise<void> {
  const jwksUrl = new URL('/.well-known/jwks.json', params.issuer);
  const JWKS = createRemoteJWKSet(jwksUrl);

  const { payload } = await jwtVerify(token, JWKS, {
    issuer: params.issuer,
    audience: params.audience ?? 'agent-cost-governor',
  });

  if (String(payload.sub ?? '') !== params.actorId) throw new Error('proceed_token sub mismatch');
  if (String(payload.jti ?? '') !== params.decisionId) throw new Error('proceed_token jti mismatch');

  if (params.taskHash !== undefined && String(payload.task ?? '') !== String(params.taskHash)) {
    throw new Error('proceed_token task mismatch');
  }
  if (params.stepHash !== undefined && String(payload.step ?? '') !== String(params.stepHash)) {
    throw new Error('proceed_token step mismatch');
  }
  if (params.ctxHash !== undefined && String((payload as any).ctx ?? '') !== String(params.ctxHash)) {
    throw new Error('proceed_token ctx mismatch');
  }
}
