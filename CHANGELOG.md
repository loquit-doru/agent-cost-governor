# Changelog

## [Unreleased] — 2026-03-26

### Added — MPP (Machine Payments Protocol) Integration

**Purpose:** Enable AI agents to pay for governance checks directly in-request via HTTP 402, using the Tempo method from the MPP open standard (Stripe + Tempo Labs, March 2026).

**New files:**
- `worker/src/mpp.ts` — `createMppx(env)` factory (Hono-aware), `createMppxServer(env)` factory (programmatic), `computeCost(operationType, iterationCount)` pricing helper, and `OPERATION_PRICING` table.
- `worker/src/durable-objects/CostLedger.ts` — Durable Object providing a verifiable on-chain audit trail for MPP payments. Endpoints: `POST /record`, `GET /summary`, `GET /history`.
- `worker/src/routes/costs.ts` — `GET /costs/:agentId` (aggregate summary) and `GET /costs/:agentId/history` (paginated entries).

**Modified files:**
- `worker/src/routes/check.ts` — Added MPP payment gate before existing loop-detection logic. Charges per operation type + iteration count; gracefully degrades (non-fatal) if MPP is not configured. Records cost entry fire-and-forget via `CostLedger` DO on the allow path. Wraps success response with `Payment-Receipt` header.
- `worker/src/types.ts` — Added `MPP_SECRET_KEY`, `TREASURY_WALLET_ADDRESS`, `TEMPO_CURRENCY_ADDRESS`, `TEMPO_TESTNET`, `COST_LEDGER` to `Env`. Added `CostEntry` and `CostSummary` interfaces.
- `worker/src/index.ts` — Exports `CostLedger`, mounts `/costs` routes.
- `worker/wrangler.toml` — Added `COST_LEDGER` DO binding + `v-mpp` migration to all environments; added `TEMPO_TESTNET` and `TEMPO_CURRENCY_ADDRESS` default vars.
- `worker/package.json` — Added `mppx ^0.4.10` dependency.

**Pricing table (USD per operation):**

| Operation | Price |
|-----------|-------|
| `llm_inference` | $0.005 |
| `web_search` | $0.001 |
| `file_read` | $0.001 |
| `file_write` | $0.002 |
| `external_api` | $0.010 |
| `loop_tier_1` (< 5 iterations) | $0.001 |
| `loop_tier_2` (5–9 iterations) | $0.005 |
| `loop_tier_3` (≥ 10 iterations) | $0.050 |

**Env vars to configure:**
- `TEMPO_CURRENCY_ADDRESS` — ERC-20 token address (default: Tempo testnet USDC)
- `TREASURY_WALLET_ADDRESS` — recipient wallet (set via `wrangler secret`)
- `TEMPO_TESTNET` — `"true"` for testnet (default), `"false"` for mainnet
- `MPP_SECRET_KEY` — optional signing key (set via `wrangler secret`)
