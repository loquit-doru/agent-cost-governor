import { exportJWK, importJWK, SignJWT } from 'jose';
import type { Env, SigningKeyCache } from '../types.js';
import { getTtlSeconds } from '../lib/config.js';

let cachedSigningKey: SigningKeyCache = null;

/**
 * Get or create the signing key for JWT tokens.
 * Uses env secret if available, otherwise generates ephemeral key (dev only).
 */
export async function getOrCreateSigningKey(
  env: Env,
): Promise<{ privateKey: CryptoKey; publicJwk: JsonWebKey & { kid: string }; kid: string }> {
  // If a private JWK is provided via env secret, use it
  if (env.GOVERNOR_SIGNING_JWK) {
    if (cachedSigningKey?.source === 'env' && cachedSigningKey.envJwk === env.GOVERNOR_SIGNING_JWK) {
      return {
        privateKey: cachedSigningKey.privateKey,
        publicJwk: cachedSigningKey.publicJwk,
        kid: cachedSigningKey.kid,
      };
    }

    const jwk = JSON.parse(env.GOVERNOR_SIGNING_JWK);
    const privateKey = (await importJWK(jwk, 'ES256')) as CryptoKey;

    // Derive public JWK from private (EC keys contain x,y coordinates)
    const publicJwk = {
      kty: jwk.kty,
      crv: jwk.crv,
      x: jwk.x,
      y: jwk.y,
      use: 'sig',
      alg: 'ES256',
      kid: String(jwk.kid || 'k1'),
    } as JsonWebKey & { kid: string };

    if (!publicJwk.kty || !publicJwk.crv || !publicJwk.x || !publicJwk.y) {
      throw new Error('GOVERNOR_SIGNING_JWK must be an EC P-256 private JWK containing x/y/d');
    }

    cachedSigningKey = {
      source: 'env',
      envJwk: env.GOVERNOR_SIGNING_JWK,
      privateKey,
      publicJwk,
      kid: publicJwk.kid,
    };

    return { privateKey, publicJwk, kid: publicJwk.kid };
  }

  // Use cached generated key if available
  if (cachedSigningKey?.source === 'generated') {
    return {
      privateKey: cachedSigningKey.privateKey,
      publicJwk: cachedSigningKey.publicJwk,
      kid: cachedSigningKey.kid,
    };
  }

  // Generate ephemeral key for development
  // ⚠️ WARNING: Tokens signed with ephemeral keys become invalid on worker restart
  console.warn('⚠️ SECURITY: Using ephemeral signing key. Set GOVERNOR_SIGNING_JWK for production.');
  
  const generated = await crypto.subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    true,
    ['sign', 'verify'],
  );

  const publicJwk = (await exportJWK(generated.publicKey)) as JsonWebKey & { kid: string };
  publicJwk.use = 'sig';
  publicJwk.alg = 'ES256';
  publicJwk.kid = 'dev-ephemeral';

  cachedSigningKey = {
    source: 'generated',
    privateKey: generated.privateKey,
    publicJwk,
    kid: 'dev-ephemeral',
  };

  return { privateKey: generated.privateKey, publicJwk, kid: 'dev-ephemeral' };
}

/**
 * Sign a proceed token JWT.
 */
export async function signProceedToken(params: {
  env: Env;
  origin: string;
  actorId: string;
  decisionId: string;
  policyId: string;
  action: string;
  taskHash?: string;
  stepHash?: string;
  contextHash?: string;
}): Promise<{ token: string; expiresInSeconds: number }> {
  const ttl = getTtlSeconds(params.env);
  const { privateKey, kid } = await getOrCreateSigningKey(params.env);

  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttl;

  const jwt = await new SignJWT({
    pol: params.policyId,
    act: params.action,
    task: params.taskHash ?? '',
    step: params.stepHash ?? '',
    ctx: params.contextHash ?? '',
  })
    .setProtectedHeader({ alg: 'ES256', kid })
    .setIssuer(params.origin)
    .setAudience('agent-cost-governor')
    .setSubject(params.actorId)
    .setJti(params.decisionId)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(privateKey);

  return { token: jwt, expiresInSeconds: ttl };
}

/**
 * Clear the signing key cache (useful for testing).
 */
export function clearSigningKeyCache(): void {
  cachedSigningKey = null;
}
