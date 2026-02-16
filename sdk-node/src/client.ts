import type {
  GovernorCheck402,
  GovernorCheckOk,
  GovernorCheckRequest,
  GovernorRedeemOk,
  ProceedGateClient,
  ProceedGateClientOptions,
  X402Headers,
} from './types.js';

function normalizeBaseUrl(baseUrl: string): string {
  // Keep existing path, but ensure no trailing slash.
  return baseUrl.replace(/\/+$/, '');
}

function readX402Headers(headers: Headers): X402Headers {
  const price = String(headers.get('x402-price') ?? '').trim();
  const recipient = String(headers.get('x402-recipient') ?? '').trim();
  const chain = String(headers.get('x402-chain') ?? '').trim();
  return { price, recipient, chain };
}

export function createProceedGateClient(opts: ProceedGateClientOptions): ProceedGateClient {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const defaultHeaders = opts.defaultHeaders ?? {};
  const failMode = opts.failMode ?? 'closed';

  const apiKey = String(opts.apiKey ?? '').trim();
  const apiKeyHeader = (opts.apiKeyHeader ?? 'authorization') as 'authorization' | 'x-api-key';
  const authHeaders: Record<string, string> = apiKey
    ? apiKeyHeader === 'x-api-key'
      ? { 'x-api-key': apiKey }
      : { authorization: `Bearer ${apiKey}` }
    : {};

  return {
    baseUrl,
    actor: opts.actor,

    async check(req: GovernorCheckRequest, checkOpts?: { signal?: AbortSignal }) {
      try {
      const url = new URL('/v1/governor/check', baseUrl);
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          ...defaultHeaders,
          ...authHeaders,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(req),
        signal: checkOpts?.signal,
      });

      if (res.status === 402) {
        const x402 = readX402Headers(res.headers);
        const body = (await res.json().catch(() => null)) as GovernorCheck402 | null;
        if (!body) throw new Error('invalid 402 body');
        return { kind: '402' as const, value: body, x402 };
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // 5xx = governor failure — apply failMode
        if (res.status >= 500) {
          if (failMode === 'open') {
            return {
              kind: 'ok' as const,
              value: {
                allowed: true,
                decision_id: `fail-open-${Date.now()}`,
                proceed_token: '',
                expires_in_seconds: 0,
                reason_code: 'governor_unreachable_fail_open',
                policy: { policy_id: 'fail_open', friction_required: false, friction_price: '0 USDC' },
              } as GovernorCheckOk,
            };
          }
          throw new Error(`ProceedGate governor unreachable (fail-closed): HTTP ${res.status} ${text}`);
        }
        throw new Error(`ProceedGate check failed: HTTP ${res.status} ${text}`);
      }

      const body = (await res.json()) as GovernorCheckOk;
      return { kind: 'ok' as const, value: body };
      } catch (err) {
        // Network errors (DNS, timeout, connection refused) — apply failMode
        if (err instanceof TypeError || (err instanceof Error && err.message.includes('fetch'))) {
          if (failMode === 'open') {
            return {
              kind: 'ok' as const,
              value: {
                allowed: true,
                decision_id: `fail-open-${Date.now()}`,
                proceed_token: '',
                expires_in_seconds: 0,
                reason_code: 'governor_unreachable_fail_open',
                policy: { policy_id: 'fail_open', friction_required: false, friction_price: '0 USDC' },
              } as GovernorCheckOk,
            };
          }
          throw new Error(`ProceedGate governor unreachable (fail-closed): ${(err as Error).message}`);
        }
        throw err;
      }
    },

    async redeem(decisionId: string, txHash: string, redeemOpts?: { signal?: AbortSignal }): Promise<GovernorRedeemOk> {
      const url = new URL('/v1/governor/redeem', baseUrl);
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          ...defaultHeaders,
          ...authHeaders,
          'content-type': 'application/json',
          accept: 'application/json',
          'x402-tx-hash': txHash,
        },
        body: JSON.stringify({ decision_id: decisionId }),
        signal: redeemOpts?.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`ProceedGate redeem failed: HTTP ${res.status} ${text}`);
      }

      return (await res.json()) as GovernorRedeemOk;
    },
  };
}
