import type { DecisionRecord } from './decisionStoreDO.js';
import { facilitatorVerifyPayment } from './facilitator.js';

type Env = {
  PAYMENT_VERIFY_MODE?: string;
  FACILITATOR_URL?: string;
  FACILITATOR_KEY?: string;

  // Used by the built-in in-worker facilitator verifier
  BASE_RPC_URL?: string;
  BASE_USDC_ADDRESS?: string;
};

type VerifyErrorStatus = 400 | 401 | 402 | 404 | 422 | 500 | 501 | 502;

export type PaymentReceipt = {
  tx_hash: string;
  paid_price: string;
  paid_chain: string;
  paid_at: string;
};

export type PaymentVerifyResult =
  | { ok: true; receipt: PaymentReceipt }
  | { ok: false; status: VerifyErrorStatus; error: string };

function nowIso(): string {
  return new Date().toISOString();
}

export async function verifyPayment(env: Env, txHash: string, record: DecisionRecord): Promise<PaymentVerifyResult> {
  const mode = String(env.PAYMENT_VERIFY_MODE ?? 'stub').trim().toLowerCase();

  if (mode === 'stub') {
    return {
      ok: true,
      receipt: {
        tx_hash: txHash,
        paid_price: record.price,
        paid_chain: String(record.chain || 'bsc').toLowerCase(),
        paid_at: nowIso(),
      },
    };
  }

  if (mode === 'facilitator') {
    const url = String(env.FACILITATOR_URL ?? '').trim();
    const urlLower = url.toLowerCase();

    // Preferred for this repo: keep the verifier inside the same worker.
    // This avoids edge self-calls and allows running without an indexer.
    if (!url || urlLower === 'internal') {
      const verified = await facilitatorVerifyPayment(env, {
        tx_hash: txHash,
        decision_id: record.decisionId,
        required_price: record.price,
        required_chain: record.chain,
        required_recipient: record.recipient,
      });

      if (verified.ok) return { ok: true, receipt: verified.receipt };
      return { ok: false, status: verified.status, error: verified.error };
    }

    const key = String(env.FACILITATOR_KEY ?? '').trim();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (key) headers.authorization = `Bearer ${key}`;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tx_hash: txHash,
        decision_id: record.decisionId,
        required_price: record.price,
        required_chain: record.chain,
        required_recipient: record.recipient,
      }),
    }).catch(() => null);

    if (!res) return { ok: false, status: 502, error: 'facilitator_unreachable' };
    const status = res.status;

    const body = (await res.json().catch(() => null)) as unknown;
    if (status >= 200 && status < 300) {
      const maybe = body as { ok?: unknown; receipt?: unknown } | null;
      if (maybe && maybe.ok === true && typeof maybe.receipt === 'object' && maybe.receipt) {
        return { ok: true, receipt: maybe.receipt as PaymentReceipt };
      }
      return { ok: false, status: 502, error: 'facilitator_invalid_response' };
    }

    const err = (body as { error?: unknown } | null)?.error;
    const safeStatus: VerifyErrorStatus =
      status === 400 ||
      status === 401 ||
      status === 402 ||
      status === 404 ||
      status === 422 ||
      status === 500 ||
      status === 501 ||
      status === 502
        ? status
        : 502;

    return { ok: false, status: safeStatus, error: typeof err === 'string' && err ? err : 'facilitator_rejected' };
  }

  return { ok: false, status: 501, error: 'payment_verification_not_implemented' };
}
