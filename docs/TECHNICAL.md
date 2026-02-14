# Technical Documentation

## Architecture

ProceedGate is a monorepo with five packages:

```
worker/       → Cloudflare Worker API (Hono + Durable Objects)
runner/       → CLI reference runner for hard enforcement
sdk-node/     → Node.js SDK (@proceedgate/node)
mcp-server/   → MCP server for AI tool access
sdk/langchain → LangChain integration (experimental)
```

### Core Flow

```
Agent ──► POST /v1/governor/check ──► 200 (proceed_token) → continue
                                  └─► 402 (friction) → pay → POST /v1/governor/redeem → proceed_token → continue
```

1. Before each expensive action, agent calls `POST /v1/governor/check` with policy, action type, and context.
2. If allowed: response `200` contains a short-lived `proceed_token` (ES256 JWT, 45s TTL).
3. If friction required: response `402` with `x402-*` headers (price, chain, recipient) and `decision_id`.
4. Agent resolves friction (payment or budget deduction), then calls `POST /v1/governor/redeem` with `decision_id` + tx hash.
5. Worker verifies on-chain, returns `proceed_token`.

### Key Components

- **DecisionStoreDO** (Durable Object): tracks per-actor decision windows, retry counts, loop detection.
- **BillingStoreDO** (Durable Object): workspace credits, quotes, billing redemption, tx replay prevention.
- **Facilitator** (internal): multi-chain payment verification (BSC, opBNB, Base) via JSON-RPC receipt inspection.
- **ES256 signing**: `proceed_token` is a JWT signed with P-256 key, verifiable via `/.well-known/jwks.json`.

## Reproducible Setup (Step by Step)

### Prerequisites

- Node.js 20+ (Node 18+ works)
- npm 9+
- Git

### 1. Clone and install

```bash
git clone https://github.com/loquit-doru/agent-cost-governor.git
cd agent-cost-governor
npm install
```

### 2. Build all packages

```bash
npm run build
```

### 3. Type-check all packages

```bash
npm --workspaces run check
```

Expected: all 5 workspaces pass with no errors.

### 4. Run unit tests

```bash
npm --workspace worker run test
```

Expected: 88 tests pass across 4 test files.

### 5. Run smoke test (full local flow)

This starts a local Wrangler worker, runs the runner against it, and validates the check→402→redeem→proceed flow:

```bash
npm run smoke
```

Expected output includes:
- `[OK]` for initial allowed checks
- `[402]` when friction triggers
- `[REDEEMED]` confirming proceed token issuance
- Summary line: `friction_events=N` and `friction_paid_usdc~=X.XX`

### 6. Run storm demos

**Block mode** (agent aborts on friction):
```bash
npm run demo:storm:block
```
Expected: `[BLOCKED] hard gate engaged (abort-on-402)` after repeated attempts.

**Redeem mode** (agent pays through friction):
```bash
npm run demo:storm:redeem
```
Expected: multiple `[REDEEMED]` lines showing escalating friction prices.

### 7. Run billing demo

```bash
npm run demo:billing
```
Expected: `[BILLING] ok` with credit balance updates.

### 8. Run hackathon proof (live endpoint)

Requires the admin key for the hackathon worker:

```bash
# Set the admin key (provided separately)
export HACKATHON_API_ADMIN_KEY="<key>"
npm run demo:hackathon:proof
```

Expected: JSON output with `ok: true`, `paid_chain: bsc`, `has_proceed_token: true`.

## Live Hackathon Endpoint

- URL: `https://agent-cost-governor-hackathon.apiworkersdev.workers.dev`
- Health: `GET /health` → `200`
- JWKS: `GET /.well-known/jwks.json`
- Configuration: `ALLOW_STUB_TX=false`, `X402_CHAIN=BSC`, `PAYMENT_VERIFY_MODE=facilitator`

## Onchain Proof Artifacts

| Artifact | Value |
|---|---|
| Governor proof tx (BSC mainnet) | [`0xd97039...b548`](https://bscscan.com/tx/0xd97039268c048cafd45c0f3b870111b1dcd22f3fdfd62a47e75ae843eb13b548) |
| Contract (BSC Testnet) | [`0xAd8Da0...58dA`](https://testnet.bscscan.com/address/0xAd8Da0Af368804e47bcdA8217b4e24F4cEb058dA) |
| Contract deploy tx | [`0x0c6956...91a7`](https://testnet.bscscan.com/tx/0x0c695608865e5cad89d9b86d0041c3ca1caf142da77cbcb08febc682567c91a7) |
| Address index | `bsc.address` (repo root) |

## API Reference (key endpoints)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/governor/check` | Decision check (200 or 402) |
| POST | `/v1/governor/redeem` | Redeem friction with tx proof |
| GET | `/health` | Healthcheck |
| GET | `/.well-known/jwks.json` | Public keys for token verification |
| POST | `/v1/workspaces/create` | Create workspace + API key (admin) |
| GET | `/v1/billing/balance` | Check workspace credit balance |
| POST | `/v1/billing/quote` | Get payment quote for credits |
| POST | `/v1/billing/redeem` | Redeem payment for credits |

## Security Notes

- Competition flow uses `ALLOW_STUB_TX=false` — real on-chain verification required.
- Workspace auth mode: API keys scoped per workspace.
- Signing uses ES256 key material stored as Cloudflare secret.
- Replay prevention: tx hashes are stored and checked for duplicates.
- Contract uses OpenZeppelin `Ownable` for admin-only `setMinStake`.

## Tech Stack

- **Runtime**: Cloudflare Workers (V8 isolates)
- **Framework**: Hono
- **State**: Durable Objects (transactional, strongly consistent)
- **Language**: TypeScript (strict mode)
- **Tests**: Vitest (88 tests)
- **Smart Contract**: Solidity 0.8.20, OpenZeppelin (IERC20, Ownable)
- **Signing**: ES256 (P-256) via `jose` library
