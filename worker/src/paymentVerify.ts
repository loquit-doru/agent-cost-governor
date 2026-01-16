import type { DecisionRecord } from './decisionStoreDO.js';

type Env = {
  PAYMENT_VERIFY_MODE?: string;
};

export type PaymentReceipt = {
  tx_hash: string;
  paid_price: string;
  paid_chain: string;
  paid_at: string;
};

export type PaymentVerifyResult =
  | { ok: true; receipt: PaymentReceipt }
  | { ok: false; status: 501; error: string };

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
        paid_chain: String(record.chain || 'base').toLowerCase(),
        paid_at: nowIso(),
      },
    };
  }

  return { ok: false, status: 501, error: 'payment_verification_not_implemented' };
}
