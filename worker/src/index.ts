import { Hono } from 'hono';
import { z } from 'zod';
import { exportJWK, importJWK, SignJWT } from 'jose';

type Env = {
  // x402-style pricing headers
  X402_PRICE_DEFAULT?: string;
  X402_CHAIN?: string;
  X402_RECIPIENT?: string;

  // JWT
  PROCEED_TOKEN_TTL_SECONDS?: string;

  // Payment verification (MVP)
  PAYMENT_VERIFY_MODE?: string; // "stub" | "facilitator" | "onchain"

  // Signing key: P-256 private JWK JSON string (stored as secret in prod)
  GOVERNOR_SIGNING_JWK?: string;
};

type Vars = {};

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

type DecisionRecord = {
  decisionId: string;
  createdAtMs: number;
  expiresAtMs: number;
  actorId: string;
  policyId: string;
  action: string;
  taskHash?: string;
  stepHash?: string;
  contextHash?: string;
  price: string;
  chain: string;
  recipient: string;
};

// MVP persistence: in-memory only (per isolate). Good enough for local dev and early demos.
// For production-grade behavior, move this to a Durable Object or KV.
const decisionStore = new Map<string, DecisionRecord>();

let cachedSigningKey:
  | { source: 'env'; envJwk: string; privateKey: CryptoKey; publicJwk: any; kid: string }
  | { source: 'generated'; privateKey: CryptoKey; publicJwk: any; kid: string }
  | null = null;

function pruneDecisionStore(nowMs: number): void {
  for (const [k, v] of decisionStore.entries()) {
    if (nowMs >= v.expiresAtMs) decisionStore.delete(k);
  }
}

const checkSchema = z.object({
  policy_id: z.enum(['retry_friction_v1', 'low_confidence_loop_v1']),
  action: z.enum(['model_call', 'tool_call', 'retry', 'override', 'plan_execute']),
  actor: z.object({
    id: z.string().min(1).max(200),
    project: z.string().min(0).max(200).optional(),
  }),
  context: z
    .object({
      attempt_in_window: z.number().int().min(1).max(1_000_000),
      window_seconds: z.number().int().min(1).max(86_400).optional(),
      confidence: z.number().min(0).max(1).optional(),
      tool: z.string().max(200).optional(),
      task_hash: z.string().max(200).optional(),
      step_hash: z.string().max(200).optional(),
      context_hash: z.string().max(200).optional(),
    })
    .passthrough(),
  idempotency_key: z.string().max(200).optional(),
});

const redeemSchema = z.object({
  decision_id: z.string().min(1).max(200),
});

function nowIso(): string {
  return new Date().toISOString();
}

function getTtlSeconds(env: Env): number {
  const n = Number(env.PROCEED_TOKEN_TTL_SECONDS ?? '45');
  if (!Number.isFinite(n)) return 45;
  return Math.max(10, Math.min(300, Math.floor(n)));
}

function getX402Price(env: Env, price: string): string {
  // Keep as "<amount> USDC" string.
  const p = String(price || env.X402_PRICE_DEFAULT || '0.004 USDC').trim();
  return p || '0.004 USDC';
}

function getX402Chain(env: Env): string {
  return String(env.X402_CHAIN ?? 'Base').trim() || 'Base';
}

function getX402Recipient(env: Env): string {
  return String(env.X402_RECIPIENT ?? '').trim() || '0x0000000000000000000000000000000000000000';
}

function computeRetryFrictionPrice(attemptInWindow: number): { price: string; required: boolean; explain: string } {
  const freeAttempts = 3;
  const base = 0.001;
  const growth = 1.8;
  const maxPrice = 0.02;

  if (attemptInWindow <= freeAttempts) {
    return { price: '0 USDC', required: false, explain: `attempt ${attemptInWindow}; free<=${freeAttempts}` };
  }

  const exponent = attemptInWindow - freeAttempts;
  const raw = base * Math.pow(growth, exponent);
  const v = Math.min(maxPrice, raw);
  const formatted = `${v.toFixed(6).replace(/0+$/, '').replace(/[.]$/, '')} USDC`;
  return { price: formatted, required: true, explain: `attempt ${attemptInWindow}; free<=${freeAttempts}; curve base=${base} growth=${growth} max=${maxPrice}` };
}

function computeLowConfidencePrice(params: { confidence: number | undefined; attemptInWindow: number }): { price: string; required: boolean; explain: string } {
  const threshold = 0.45;
  const base = 0.002;
  const maxPrice = 0.05;
  const mult = 2.0;

  const c = params.confidence;
  if (c === undefined || c === null) {
    return { price: '0 USDC', required: false, explain: 'confidence missing; no friction' };
  }

  if (c >= threshold) {
    return { price: '0 USDC', required: false, explain: `confidence ${c.toFixed(2)} >= ${threshold}` };
  }

  const severity = (threshold - c) / threshold;
  const attemptsFactor = Math.max(1, params.attemptInWindow - 1);
  const raw = base * (1 + mult * severity) * attemptsFactor;
  const v = Math.min(maxPrice, raw);
  const formatted = `${v.toFixed(6).replace(/0+$/, '').replace(/[.]$/, '')} USDC`;
  return {
    price: formatted,
    required: true,
    explain: `confidence ${c.toFixed(2)} < ${threshold}; severity=${severity.toFixed(2)} attemptsFactor=${attemptsFactor} base=${base} mult=${mult} max=${maxPrice}`,
  };
}

async function getOrCreateSigningKey(env: Env): Promise<{ privateKey: CryptoKey; publicJwk: any; kid: string }> {
  // MVP: If a private JWK is provided via env secret, use it.
  // Else generate an ephemeral key per runtime (acceptable for local dev).
  if (env.GOVERNOR_SIGNING_JWK) {
    if (cachedSigningKey?.source === 'env' && cachedSigningKey.envJwk === env.GOVERNOR_SIGNING_JWK) {
      return { privateKey: cachedSigningKey.privateKey, publicJwk: cachedSigningKey.publicJwk, kid: cachedSigningKey.kid };
    }

    const jwk = JSON.parse(env.GOVERNOR_SIGNING_JWK);
    const privateKey = (await importJWK(jwk, 'ES256')) as CryptoKey;

    // For EC keys, the private JWK usually contains public coordinates (x,y).
    // Derive the public JWK directly to avoid Node-specific helpers.
    const publicJwk = {
      kty: jwk.kty,
      crv: jwk.crv,
      x: jwk.x,
      y: jwk.y,
      use: 'sig',
      alg: 'ES256',
      kid: String(jwk.kid || 'k1'),
    };

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

  if (cachedSigningKey?.source === 'generated') {
    return { privateKey: cachedSigningKey.privateKey, publicJwk: cachedSigningKey.publicJwk, kid: cachedSigningKey.kid };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const generated: any = await crypto.subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    true,
    ['sign', 'verify'],
  );

  const publicJwk = await exportJWK(generated.publicKey);
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

function makeDecisionId(): string {
  // ULID (time-sortable) without external deps.
  // 26 chars Crockford base32: 48-bit timestamp (ms) + 80-bit randomness.
  const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

  const now = Date.now();
  let time = now;
  const timeChars: string[] = new Array(10);
  for (let i = 9; i >= 0; i--) {
    timeChars[i] = ENCODING[time % 32]!;
    time = Math.floor(time / 32);
  }

  const rand = crypto.getRandomValues(new Uint8Array(16));
  let acc = 0;
  let bits = 0;
  const randChars: string[] = [];
  for (const b of rand) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      const idx = (acc >>> (bits - 5)) & 31;
      randChars.push(ENCODING[idx]!);
      bits -= 5;
    }
  }

  // ULID randomness component is 16 chars.
  const ulid = `${timeChars.join('')}${randChars.join('').slice(0, 16)}`;
  return `dec_${ulid}`;
}

async function signProceedToken(params: {
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

app.get('/.well-known/jwks.json', async (c) => {
  const { publicJwk } = await getOrCreateSigningKey(c.env);
  c.header('cache-control', 'public, max-age=300');
  return c.json({ keys: [publicJwk] }, 200);
});

app.post('/v1/governor/check', async (c) => {
  const origin = new URL(c.req.url).origin;
  const body = await c.req.json().catch(() => null);
  const parsed = checkSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const decisionId = makeDecisionId();

  const attempt = parsed.data.context.attempt_in_window;
  const confidence = parsed.data.context.confidence;

  let priceInfo: { price: string; required: boolean; explain: string };
  let reasonCode: string = 'none';

  if (parsed.data.policy_id === 'retry_friction_v1') {
    priceInfo = computeRetryFrictionPrice(attempt);
    reasonCode = priceInfo.required ? 'retry_friction' : 'none';
  } else {
    priceInfo = computeLowConfidencePrice({ confidence, attemptInWindow: attempt });
    reasonCode = priceInfo.required ? 'low_confidence' : 'none';
  }

  if (!priceInfo.required) {
    const signed = await signProceedToken({
      env: c.env,
      origin,
      actorId: parsed.data.actor.id,
      decisionId,
      policyId: parsed.data.policy_id,
      action: parsed.data.action,
      taskHash: parsed.data.context.task_hash,
      stepHash: parsed.data.context.step_hash,
      contextHash: parsed.data.context.context_hash,
    });

    return c.json(
      {
        allowed: true,
        decision_id: decisionId,
        proceed_token: signed.token,
        expires_in_seconds: signed.expiresInSeconds,
        reason_code: 'none',
        policy: {
          policy_id: parsed.data.policy_id,
          friction_required: false,
          friction_price: '0 USDC',
        },
      },
      200,
    );
  }

  const x402Price = getX402Price(c.env, priceInfo.price);
  const recipient = getX402Recipient(c.env);
  const chain = getX402Chain(c.env);

  c.header('x402-price', x402Price);
  c.header('x402-recipient', recipient);
  c.header('x402-chain', chain);
  c.header('cache-control', 'no-store');

  const nowMs = Date.now();
  pruneDecisionStore(nowMs);
  decisionStore.set(decisionId, {
    decisionId,
    createdAtMs: nowMs,
    // Allow enough time for a human to pay and paste a tx hash.
    expiresAtMs: nowMs + 10 * 60 * 1000,
    actorId: parsed.data.actor.id,
    policyId: parsed.data.policy_id,
    action: parsed.data.action,
    taskHash: parsed.data.context.task_hash,
    stepHash: parsed.data.context.step_hash,
    contextHash: parsed.data.context.context_hash,
    price: x402Price,
    chain,
    recipient,
  });

  return c.json(
    {
      allowed: false,
      decision_id: decisionId,
      reason_code: reasonCode,
      policy: {
        policy_id: parsed.data.policy_id,
        friction_required: true,
        friction_price: x402Price,
        explain: priceInfo.explain,
      },
      redeem: {
        method: 'POST',
        url: '/v1/governor/redeem',
        requires_header: 'x402-tx-hash',
      },
    },
    402,
  );
});

app.post('/v1/governor/redeem', async (c) => {
  const origin = new URL(c.req.url).origin;
  const txHash = String(c.req.header('x402-tx-hash') ?? '').trim();
  if (!txHash) return c.json({ error: 'missing_x402_tx_hash' }, 400);

  const body = await c.req.json().catch(() => null);
  const parsed = redeemSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  // MVP: accept any tx hash when PAYMENT_VERIFY_MODE=stub.
  const mode = String(c.env.PAYMENT_VERIFY_MODE ?? 'stub').trim().toLowerCase();
  if (mode !== 'stub') {
    return c.json({ error: 'payment_verification_not_implemented' }, 501);
  }

  const nowMs = Date.now();
  pruneDecisionStore(nowMs);
  const record = decisionStore.get(parsed.data.decision_id);
  if (!record) {
    return c.json({ error: 'unknown_or_expired_decision' }, 404);
  }

  const signed = await signProceedToken({
    env: c.env,
    origin,
    actorId: record.actorId,
    decisionId: record.decisionId,
    policyId: record.policyId,
    action: record.action,
    taskHash: record.taskHash,
    stepHash: record.stepHash,
    contextHash: record.contextHash,
  });

  return c.json(
    {
      ok: true,
      decision_id: parsed.data.decision_id,
      proceed_token: signed.token,
      expires_in_seconds: signed.expiresInSeconds,
      receipt: {
        tx_hash: txHash,
        paid_price: record.price,
        paid_chain: String(record.chain || c.env.X402_CHAIN || 'base').toLowerCase(),
        paid_at: nowIso(),
      },
    },
    200,
  );
});

app.get('/health', (c) => c.json({ ok: true }, 200));

export default app;
