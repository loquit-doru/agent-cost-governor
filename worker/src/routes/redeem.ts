import { Hono } from 'hono';
import type { Env, Vars } from '../types.js';
import { redeemSchema } from '../lib/schemas.js';
import { setProceedgateHeaders } from '../lib/utils.js';
import { signProceedToken } from '../services/signing.js';
import { getDecisionRecord, deleteDecisionRecord } from '../services/store.js';
import { verifyPayment } from '../paymentVerify.js';
import { logEvent, actorKey, txKey } from '../observability.js';
import { writeMetric } from '../metrics.js';
import { getBillingStub, doUrl } from '../lib/do.js';
import { getTtlSeconds } from '../lib/config.js';

const redeemRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

redeemRoutes.post('/v1/governor/redeem', async (c) => {
  const startMs = Date.now();
  const origin = new URL(c.req.url).origin;
  const txHash = String(c.req.header('x402-tx-hash') ?? '').trim();

  if (!txHash) {
    writeMetric(c.env, {
      indexes: ['redeem_fail', 'unknown', 'unknown', 'missing_x402_tx_hash'],
      doubles: [1, Date.now() - startMs],
    });
    return c.json({ error: 'missing_x402_tx_hash' }, 400);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = redeemSchema.safeParse(body);

  if (!parsed.success) {
    writeMetric(c.env, {
      indexes: ['redeem_fail', 'unknown', 'unknown', 'invalid_request'],
      doubles: [1, Date.now() - startMs],
    });
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const record = await getDecisionRecord(c.env, parsed.data.decision_id);
  if (!record) {
    logEvent({
      event: 'governor_redeem_fail',
      decision_id: parsed.data.decision_id,
      error: 'unknown_or_expired_decision',
      tx: txKey(txHash),
    });

    writeMetric(c.env, {
      indexes: ['redeem_fail', 'unknown', 'unknown', 'unknown_or_expired_decision'],
      doubles: [1, Date.now() - startMs],
    });
    return c.json({ error: 'unknown_or_expired_decision' }, 404);
  }

  const payment = await verifyPayment(c.env, txHash, record);
  if (!payment.ok) {
    logEvent({
      event: 'governor_redeem_fail',
      decision_id: parsed.data.decision_id,
      error: payment.error,
      tx: txKey(txHash),
    });

    writeMetric(c.env, {
      indexes: ['redeem_fail', record.policyId, record.action, payment.error],
      doubles: [1, Date.now() - startMs],
    });
    return c.json({ error: payment.error }, payment.status);
  }

  // One-time redeem: delete record to prevent reuse
  await deleteDecisionRecord(c.env, parsed.data.decision_id);

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

  // Fire-and-forget: mark JTI (decision_id) in DO blacklist for replay prevention
  const ttlSec = getTtlSeconds(c.env);
  const expiresAtSec = Math.floor(Date.now() / 1000) + ttlSec;
  const billingStub = getBillingStub(c.env);
  billingStub.fetch(doUrl('/jti/mark'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jti: record.decisionId, expires_at: expiresAtSec }),
  }).catch(err => console.error('JTI blacklist mark failed:', err));

  setProceedgateHeaders(c, {
    decisionId: parsed.data.decision_id,
    policyId: record.policyId,
    reasonCode: 'redeemed',
  });

  logEvent({
    event: 'governor_redeem_ok',
    decision_id: parsed.data.decision_id,
    policy_id: record.policyId,
    action: record.action,
    reason_code: 'redeemed',
    actor_key: await actorKey(record.actorId),
    task_hash: record.taskHash ?? '',
    step_hash: record.stepHash ?? '',
    context_hash: record.contextHash ?? '',
    friction_price: record.price,
    chain: record.chain,
    recipient: record.recipient,
    tx: txKey(txHash),
  });

  writeMetric(c.env, {
    indexes: ['redeem_ok', record.policyId, record.action, 'redeemed'],
    doubles: [1, Date.now() - startMs],
  });

  return c.json(
    {
      ok: true,
      decision_id: parsed.data.decision_id,
      proceed_token: signed.token,
      expires_in_seconds: signed.expiresInSeconds,
      receipt: payment.receipt,
    },
    200,
  );
});

export { redeemRoutes };
