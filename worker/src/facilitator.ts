import type { PaymentReceipt } from './paymentVerify.js';

export type FacilitatorVerifyRequest = {
  tx_hash: string;
  required_price: string;
  required_chain: string;
  required_recipient: string;
  decision_id?: string;
};

export type FacilitatorVerifyResponse =
  | { ok: true; receipt: PaymentReceipt }
  | { ok: false; error: string };

type Env = {
  BASE_RPC_URL?: string;
  BASE_USDC_ADDRESS?: string;
  BSC_RPC_URL?: string;
  BSC_USDC_ADDRESS?: string;
  OPBNB_RPC_URL?: string;
  OPBNB_USDC_ADDRESS?: string;

  // Dev-only escape hatch: allow "0xstub" tx hashes.
  // MUST NOT be enabled in production.
  ALLOW_STUB_TX?: string;
};

type VerifyErrorStatus = 400 | 401 | 402 | 404 | 422 | 500 | 501 | 502;

const TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeHex0x(input: string): string {
  const s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  return s.startsWith('0x') ? s : `0x${s}`;
}

function normalizeAddress(input: string): string {
  const s = normalizeHex0x(input);
  if (!/^0x[0-9a-f]{40}$/.test(s)) return '';
  return s;
}

function addressToTopic(address: string): string {
  // topic is 32-byte right-padded hex of the address
  const a = normalizeAddress(address);
  if (!a) return '';
  return `0x${a.slice(2).padStart(64, '0')}`;
}

// USDC decimals per chain:
// - Base: 6 decimals (native Circle USDC)
// - BSC:  18 decimals (Binance-Pegged USD Coin 0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d)
// - opBNB: 18 decimals (bridged from BSC)
function getUsdcDecimals(chain: 'base' | 'bsc' | 'opbnb' | ''): bigint {
  if (chain === 'base') return 6n;
  return 18n; // bsc, opbnb
}

function parseUsdcToUnits(price: string, decimals: bigint = 6n): bigint | null {
  // Expect "<amount> USDC"
  const m = String(price || '')
    .trim()
    .match(/^([0-9]+(?:\.[0-9]+)?)\s*USDC$/i);
  if (!m) return null;

  const multiplier = 10n ** decimals;
  const [whole, frac = ''] = m[1]!.split('.');
  const fracPadded = (frac + '0'.repeat(Number(decimals))).slice(0, Number(decimals));
  if (!/^[0-9]+$/.test(whole) || !/^[0-9]+$/.test(fracPadded)) return null;
  return BigInt(whole) * multiplier + BigInt(fracPadded);
}

function formatUsdcUnits(units: bigint, decimals: bigint = 6n): string {
  const multiplier = 10n ** decimals;
  const sign = units < 0n ? '-' : '';
  const u = units < 0n ? -units : units;
  const whole = u / multiplier;
  const frac = (u % multiplier).toString().padStart(Number(decimals), '0').replace(/0+$/, '');
  return `${sign}${whole.toString()}${frac ? `.${frac}` : ''} USDC`;
}

function normalizeChain(input: string): 'base' | 'bsc' | 'opbnb' | '' {
  const chain = String(input || '').trim().toLowerCase();
  if (!chain) return '';
  if (chain === 'base') return 'base';
  if (chain === 'bsc' || chain === 'bnb' || chain === 'bnbchain' || chain === 'bnb chain') return 'bsc';
  if (chain === 'opbnb' || chain === 'op-bnb' || chain === 'op bnb') return 'opbnb';
  return '';
}


async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

  if (!res.ok) {
    throw new Error(`rpc_http_error status=${res.status}`);
  }

  const body = (await res.json().catch(() => null)) as { result?: T; error?: { message?: string } } | null;
  if (!body) throw new Error('rpc_invalid_json');
  if (body.error) throw new Error(`rpc_error ${body.error.message || ''}`.trim());
  if (body.result === undefined) throw new Error('rpc_missing_result');
  return body.result;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpcCallWithRetry<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  opts: { attempts: number; baseDelayMs: number },
): Promise<T> {
  let lastErr: unknown = null;
  for (let i = 0; i < opts.attempts; i++) {
    try {
      return await rpcCall<T>(rpcUrl, method, params);
    } catch (e) {
      lastErr = e;
      // small exponential backoff with cap
      const delay = Math.min(1500, opts.baseDelayMs * Math.pow(2, i));
      await sleepMs(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('rpc_call_failed');
}

function getTokenAddressForChain(env: Env, chain: 'base' | 'bsc' | 'opbnb'): string {
  if (chain === 'base') {
    const fallback = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    return normalizeAddress(env.BASE_USDC_ADDRESS ?? fallback) || fallback;
  }

  if (chain === 'bsc') {
    const fallback = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d';
    return normalizeAddress(env.BSC_USDC_ADDRESS ?? fallback) || fallback;
  }

  // USDT (Tether) bridged from BSC — #1 token by liquidity on opBNB
  const fallback = '0x9e5aac1ba1a2e6aed6b32689dfcf62a509ca96f3';
  return normalizeAddress(env.OPBNB_USDC_ADDRESS ?? fallback) || fallback;
}

function getRpcUrlForChain(env: Env, chain: 'base' | 'bsc' | 'opbnb'): string {
  if (chain === 'base') return String(env.BASE_RPC_URL || '').trim();
  if (chain === 'bsc') return String(env.BSC_RPC_URL || '').trim();
  return String(env.OPBNB_RPC_URL || '').trim();
}

export async function facilitatorVerifyPayment(
  env: Env,
  req: FacilitatorVerifyRequest,
): Promise<{ ok: true; receipt: PaymentReceipt } | { ok: false; status: VerifyErrorStatus; error: string }> {
  const txHash = normalizeHex0x(req.tx_hash);
  if (!txHash) return { ok: false, status: 400, error: 'invalid_tx_hash' };

  const chain = normalizeChain(req.required_chain);
  if (!chain) {
    if (!String(req.required_chain || '').trim()) {
      return { ok: false, status: 400, error: 'missing_required_chain' };
    }
    return { ok: false, status: 422, error: 'unsupported_chain' };
  }

  const recipient = normalizeAddress(req.required_recipient);
  if (!recipient) return { ok: false, status: 400, error: 'invalid_required_recipient' };

  const decimals = getUsdcDecimals(chain);
  const requiredUnits = parseUsdcToUnits(req.required_price, decimals);
  if (requiredUnits === null) return { ok: false, status: 400, error: 'invalid_required_price' };

  // Local/dev convenience: allow stub tx hashes when explicitly enabled.
  // Accepts any tx hash that starts with "0xstub" to support idempotent demos.
  const allowStub = String(env.ALLOW_STUB_TX ?? '').trim().toLowerCase() === 'true';
  if (allowStub && txHash.startsWith('0xstub')) {
    return {
      ok: true,
      receipt: {
        tx_hash: txHash,
        paid_price: req.required_price,
        paid_chain: chain,
        paid_at: nowIso(),
      },
    };
  }

  const rpcUrl = getRpcUrlForChain(env, chain);
  if (!rpcUrl) return { ok: false, status: 501, error: 'rpc_not_configured' };

  type RpcReceiptLog = { address: string; topics: string[]; data: string };
  type RpcReceipt = {
    status?: string;
    blockHash?: string;
    logs?: RpcReceiptLog[];
  };

  // Public RPCs can be eventually consistent for a short window. Retry a few times.
  const receipt = await rpcCallWithRetry<RpcReceipt | null>(rpcUrl, 'eth_getTransactionReceipt', [txHash], {
    attempts: 4,
    baseDelayMs: 200,
  }).catch(() => null);
  if (!receipt) return { ok: false, status: 404, error: 'tx_not_found' };
  if (String(receipt.status || '').toLowerCase() !== '0x1') return { ok: false, status: 422, error: 'tx_failed' };

  const usdc = getTokenAddressForChain(env, chain);
  const toTopic = addressToTopic(recipient);
  if (!toTopic) return { ok: false, status: 500, error: 'recipient_topic_failed' };

  let paidUnits = 0n;
  for (const log of receipt.logs || []) {
    const addr = normalizeAddress(log.address);
    if (!addr || addr !== usdc) continue;

    const t0 = normalizeHex0x(log.topics?.[0] || '');
    const t2 = normalizeHex0x(log.topics?.[2] || '');
    if (t0 !== TRANSFER_TOPIC0) continue;
    if (t2 !== toTopic) continue;

    const data = normalizeHex0x(log.data);
    if (!/^0x[0-9a-f]+$/.test(data)) continue;

    try {
      paidUnits += BigInt(data);
    } catch {
      // ignore
    }
  }

  if (paidUnits < requiredUnits) {
    return { ok: false, status: 402, error: 'underpaid' };
  }

  // Optional: if we can fetch block timestamp, use it; else fallback to now.
  let paidAt = nowIso();
  if (receipt.blockHash) {
    type RpcBlock = { timestamp?: string };
    const block = await rpcCallWithRetry<RpcBlock | null>(rpcUrl, 'eth_getBlockByHash', [receipt.blockHash, false], {
      attempts: 3,
      baseDelayMs: 100,
    }).catch(() => null);
    const tsHex = block?.timestamp ? String(block.timestamp) : '';
    if (/^0x[0-9a-f]+$/i.test(tsHex)) {
      const seconds = Number.parseInt(tsHex, 16);
      if (Number.isFinite(seconds) && seconds > 0) paidAt = new Date(seconds * 1000).toISOString();
    }
  }

  return {
    ok: true,
    receipt: {
      tx_hash: txHash,
      paid_price: formatUsdcUnits(paidUnits, decimals),
      paid_chain: chain,
      paid_at: paidAt,
    },
  };
}
