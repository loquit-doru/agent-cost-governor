/**
 * MPP (Machine Payments Protocol) integration for ProceedGate.
 *
 * Provides a factory for the Mppx instance (Tempo method) and a dynamic
 * pricing table keyed by operation type + iteration count.
 */

import { Mppx, tempo } from 'mppx/hono';
import { Mppx as MppxServer, tempo as tempoServer } from 'mppx/server';
import type { Env } from './types.js';

// ---------------------------------------------------------------------------
// Pricing table (USD per operation)
// ---------------------------------------------------------------------------

export const OPERATION_PRICING: Record<string, string> = {
  llm_inference:  '0.005',
  web_search:     '0.001',
  file_read:      '0.001',
  file_write:     '0.002',
  external_api:   '0.010',
  loop_tier_1:    '0.001',
  loop_tier_2:    '0.005',
  loop_tier_3:    '0.050',
  default:        '0.001',
};

/**
 * Computes the cost (USD string) for a given operation type and iteration
 * count.  High iteration counts map to the loop-tier pricing bands:
 *   - iterationCount >= 10 → loop_tier_3 ($0.050)
 *   - iterationCount >=  5 → loop_tier_2 ($0.005)
 *   - otherwise            → lookup in OPERATION_PRICING (fallback: 'default')
 */
export function computeCost(operationType: string, iterationCount: number): string {
  if (iterationCount >= 10) return OPERATION_PRICING.loop_tier_3;
  if (iterationCount >= 5)  return OPERATION_PRICING.loop_tier_2;
  return OPERATION_PRICING[operationType] ?? OPERATION_PRICING.default;
}

// ---------------------------------------------------------------------------
// Mppx factory
// ---------------------------------------------------------------------------

/**
 * Creates a Hono-aware Mppx instance configured with the Tempo payment method.
 *
 * Required env vars:
 *   TEMPO_CURRENCY_ADDRESS  – ERC-20 token address accepted by Tempo
 *   TREASURY_WALLET_ADDRESS – recipient wallet address
 *   TEMPO_TESTNET           – "true" | "false" (default false)
 */
export function createMppx(env: Env) {
  const testnet = env.TEMPO_TESTNET === 'true';

  return Mppx.create({
    methods: [
      tempo({
        currency:  env.TEMPO_CURRENCY_ADDRESS,
        recipient: env.TREASURY_WALLET_ADDRESS as `0x${string}`,
        testnet,
      }),
    ],
    realm: 'governor.proceedgate.dev',
  });
}

export type MppxInstance = ReturnType<typeof createMppx>;

// ---------------------------------------------------------------------------
// Server-style factory (for programmatic use with dynamic amounts)
// ---------------------------------------------------------------------------

/**
 * Creates a server-style (non-Hono-wrapped) Mppx instance.
 * Use this when you need to call `mppx.charge({ amount })(request)` directly
 * inside a handler where the amount is computed dynamically.
 */
export function createMppxServer(env: Env) {
  const testnet = env.TEMPO_TESTNET === 'true';

  return MppxServer.create({
    methods: [
      tempoServer({
        currency:  env.TEMPO_CURRENCY_ADDRESS,
        recipient: env.TREASURY_WALLET_ADDRESS as `0x${string}`,
        testnet,
      }),
    ],
    realm: 'governor.proceedgate.dev',
  });
}

export type MppxServerInstance = ReturnType<typeof createMppxServer>;
