import type { AppContext } from '../types.js';

/**
 * Generate a cryptographically secure random API key.
 * Returns base64url encoded string without padding.
 */
export function randomApiKey(bytes: number = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  const b64 = btoa(String.fromCharCode(...raw));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * SHA-256 hash of a string, returned as hex.
 */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(String(input));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const arr = Array.from(new Uint8Array(digest));
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a ULID-style decision ID.
 * Format: dec_<ULID> (26 chars Crockford base32: 48-bit timestamp + 80-bit random)
 */
export function makeDecisionId(): string {
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

  const ulid = `${timeChars.join('')}${randChars.join('').slice(0, 16)}`;
  return `dec_${ulid}`;
}

/**
 * Generate a quote ID (same format as decision ID but with q_ prefix).
 */
export function makeQuoteId(): string {
  return makeDecisionId().replace(/^dec_/, 'q_');
}

/**
 * Format microUSDC units to human-readable string.
 * e.g., 1234567n -> "1.234567 USDC"
 */
export function formatUsdcUnits(units: bigint): string {
  const sign = units < 0n ? '-' : '';
  const u = units < 0n ? -units : units;
  const whole = u / 1_000_000n;
  const frac = (u % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${sign}${whole.toString()}${frac ? `.${frac}` : ''} USDC`;
}

/**
 * Calculate quote price from credits.
 */
export function quotePriceFromCredits(
  credits: number,
  microUsdcPerCredit: number,
): { units: bigint; price: string } {
  const units = BigInt(credits) * BigInt(microUsdcPerCredit);
  return { units, price: formatUsdcUnits(units) };
}

/**
 * Set ProceedGate-specific response headers.
 */
export function setProceedgateHeaders(
  c: AppContext,
  params: {
    decisionId: string;
    policyId?: string;
    reasonCode?: string;
    frictionPrice?: string;
  },
): void {
  c.header('X-Proceedgate-Decision-Id', params.decisionId);
  if (params.policyId) c.header('X-Proceedgate-Policy-Id', params.policyId);
  if (params.reasonCode) c.header('X-Proceedgate-Reason', params.reasonCode);
  if (params.frictionPrice) c.header('X-Proceedgate-Friction-Price', params.frictionPrice);
}

/**
 * Extract API key from request headers.
 * Supports both Authorization: Bearer <key> and X-Api-Key: <key>
 */
export function getRequestApiKey(c: AppContext): string {
  const bearer = String(c.req.header('authorization') ?? '').trim();
  if (bearer.toLowerCase().startsWith('bearer ')) return bearer.slice(7).trim();
  return String(c.req.header('x-api-key') ?? '').trim();
}
