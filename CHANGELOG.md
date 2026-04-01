# Changelog

## [1.2.0] — 2026-04-01

### Added — Agent Identity & Per-Agent Reputation
**Files**: `worker/src/billingStoreDO.ts`, `worker/src/routes/agents.ts`, `worker/src/routes/check.ts`, `worker/src/lib/schemas.ts`, `worker/src/index.ts`
**Motiv**: `actor.id` era un simplu string de logging — fără profil persistent, fără reputație proprie. Un agent rău nu era penalizat separat de workspace.
**Adăugat**:
- `AgentProfile` type + storage keys `agent:{id}:profile` și `agent:{id}:rep` în `BillingStoreDO`
- DO endpoints: `GET/POST /agents/:id/profile`, `GET/POST /agents/:id/reputation`, `GET /agents` (list paginat)
- `check.ts`: fire-and-forget agent profile upsert + reputation recording la toate cele 3 puncte (storm block, gray block, success)
- `actor.wallet` câmp opțional în schema (ERC-8004 pregătit pentru viitor)
- HTTP routes `GET /v1/agents` și `GET /v1/agents/:id` (autentificate cu admin key)
- `requests.http`: 4 exemple noi pentru Agent Identity endpoints
- `README.md`: secțiune nouă "Agent Identity & Reputation" cu exemple complete



### Added — Session-based Budget Tracking
- `POST /v1/governor/session` — Open a session with budget cap
- `GET /v1/governor/session/:id` — Get session status (remaining budget, request count)
- `DELETE /v1/governor/session/:id` — Close/settle session
- Session tracking integrated into `/v1/governor/check` via `context.session_id`
- Cumulative spend tracking inspired by MPP voucher accumulation pattern

### Added — OpenAPI Discovery
- `GET /openapi.json` — Standard OpenAPI 3.1 spec with custom extensions
- `x-service-info` extension on info block (realm, categories, protocols)
- `x-cost-info` extension on endpoints (credit cost, loop detection config, session support)
- Machine-readable discovery for AI agents to auto-detect capabilities

### Changed — Payment Chain Migration
- Migrated all payments from Base chain to **BNB Chain (BSC)**
- Updated `X402_CHAIN` default from `Base` to `BSC`
- Updated subscription flow to default to BSC (chain ID 56)
- Updated USDC address to BSC: `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`
- Updated pay.html with BNB Chain network selection
- Updated legal pages (privacy, terms) to reference BNB Chain

### Fixed
- DO session routing: extracted to dedicated `handleSession()` method for reliable routing
- Session route workspace fallback when `API_AUTH_MODE=off`

### Docs
- Added session endpoint documentation to docs.html
- Added OpenAPI discovery section to docs.html
- Added session error codes (402, 404, 410) to error table
- Added DELETE method CSS styling to docs
- Updated SPEC.md with sessions, discovery, and BSC references

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
