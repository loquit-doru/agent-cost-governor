import type { GovernorCheck402, GovernorCheckOk, GovernorCheckRequest, GovernorRedeemOk } from './types.js';

export type CheckResult =
  | { kind: 'ok'; value: GovernorCheckOk }
  | {
      kind: '402';
      value: GovernorCheck402;
      x402: { price: string; recipient: string; chain: string };
    };

export async function governorCheck(baseUrl: string, req: GovernorCheckRequest): Promise<CheckResult> {
  const url = new URL('/v1/governor/check', baseUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(req),
  });

  if (res.status === 402) {
    const price = String(res.headers.get('x402-price') ?? '').trim();
    const recipient = String(res.headers.get('x402-recipient') ?? '').trim();
    const chain = String(res.headers.get('x402-chain') ?? '').trim();
    const body = (await res.json().catch(() => null)) as GovernorCheck402 | null;
    if (!body) throw new Error('invalid 402 body');
    return { kind: '402', value: body, x402: { price, recipient, chain } };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`governorCheck failed: HTTP ${res.status} ${text}`);
  }

  const body = (await res.json()) as GovernorCheckOk;
  return { kind: 'ok', value: body };
}

export async function governorRedeem(baseUrl: string, decisionId: string, txHash: string): Promise<GovernorRedeemOk> {
  const url = new URL('/v1/governor/redeem', baseUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x402-tx-hash': txHash,
    },
    body: JSON.stringify({ decision_id: decisionId }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`governorRedeem failed: HTTP ${res.status} ${text}`);
  }

  return (await res.json()) as GovernorRedeemOk;
}
