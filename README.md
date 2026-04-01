# ProceedGate — Gate Any Expensive AI Agent Action, Onchain

> **Good Vibes Only: OpenClaw Edition** | Track: **Agent** (AI Agent × Onchain Actions)

ProceedGate gates **any expensive AI agent action** — LLM calls, paid APIs, browser automation, scraping, onchain transactions — with hard enforcement.

ProceedGate sits **outside** the agent loop and blocks costly steps unless the agent has a valid short-lived `proceed_token`. If an agent enters a retry storm, ProceedGate automatically gates it with escalating micropayments verified on BSC.

## Hackathon Quick Links

| Resource | Link |
|---|---|
| Live endpoint | `https://governor.proceedgate.dev` |
| Proof tx (BSC) | [`0xd97039...b548`](https://bscscan.com/tx/0xd97039268c048cafd45c0f3b870111b1dcd22f3fdfd62a47e75ae843eb13b548) |
| Contract (BSC Mainnet, BscScan ✓) | [`0x161D74...C97`](https://bscscan.com/address/0x161D749892a23AC8792eE7fD37f0F423E0b69C97) |
| Contract (opBNB Mainnet, opBNBScan ✓) | [`0xAd8Da0...8dA`](https://opbnbscan.com/address/0xAd8Da0Af368804e47bcdA8217b4e24F4cEb058dA) |
| Address index | [`bsc.address`](bsc.address) |
| Demo video | [YouTube](https://youtu.be/3oCwey4RXG8) |
| Full setup guide | [`docs/TECHNICAL.md`](docs/TECHNICAL.md) |
| Project overview | [`docs/PROJECT.md`](docs/PROJECT.md) |
| AI build log | [`AI_BUILD_LOG.md`](AI_BUILD_LOG.md) |
| OpenClaw setup | [`OPENCLAW_SETUP.md`](OPENCLAW_SETUP.md) |
| Competition runbook | [`HACKATHON.md`](HACKATHON.md) |

### Reproduce in 3 commands

```bash
npm install
npm --workspaces run check   # typecheck all packages
npm run smoke                # full local flow: check → 402 → redeem → proceed
```

### Run the AI agent demos

```bash
npm run demo:guardian        # 🛡️ TreasuryGuardian — onchain AI agent
                             #    14 BSC transfers · LLM decisions · storm detection
npm run demo:agent           # 🤖 CryptoScraper — scraping agent gated by ProceedGate
```

**TreasuryGuardian** plans 14 treasury micro-transfers on BSC Testnet, gated by ProceedGate. The first 3 are approved, attempts 4–10 require friction (agent pays onchain), and at attempt 11 ProceedGate detects a storm and the LLM autonomously decides to halt. 10 real BSC transactions total.

**CryptoScraper** scrapes crypto prices from 5 exchanges. When one exchange is down, the agent retries — ProceedGate detects the loop, applies escalating friction, and the agent’s LLM decides to stop.

See [`docs/TECHNICAL.md`](docs/TECHNICAL.md) for the complete step-by-step guide (8 validation commands).

---

## Integrate in 30 minutes

The quickest path is to adopt ProceedGate as a **runner/middleware gate**:

1. Before each step (tool call / retry / browser action / paid API call), call `POST /v1/governor/check`.
2. If you get `200`, proceed.
3. If you get `402`, your system must resolve friction (payment is one option) then call `POST /v1/governor/redeem` and proceed.

This repo includes a reference runner to demonstrate *hard enforcement*.
## 🦞 OpenClaw Integration

ProceedGate ships as a native [OpenClaw skill](https://docs.openclaw.ai/tools/skills). Install it and your AI assistant autonomously gates expensive actions through onchain verification on BNB Chain.

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
cp openclaw/openclaw.json.example ~/.openclaw/openclaw.json
openclaw agent --message "Gate my next API call"
```

Key files:

| File | Purpose |
|------|---------|
| `skills/onchain-cost-governor/SKILL.md` | AgentSkills-compatible skill definition |
| `openclaw/SOUL.md` | Agent identity and safety policies |
| `openclaw/AGENTS.md` | Multi-agent coordination (Governor ↔ Coordinator ↔ Executor) |
| `openclaw/openclaw.json.example` | Configuration template |

See [`OPENCLAW_SETUP.md`](OPENCLAW_SETUP.md) for the full integration guide.
## What “costly steps” means (canonical v1 examples)

- LLM retries / regeneration loops
- Browser / web automation actions (Playwright-style)
- External paid API calls (scraping, SerpAPI, Firecrawl, Apify)
- Onchain transactions and smart contract calls
- Any tool invocation with a cost attached

> ProceedGate doesn't care *what* the action is — it gates anything you declare as expensive. The `action` field in `/v1/governor/check` is a free string.

## How it works (two outcomes)

Every decision check returns only:

- `200` (allowed) + `proceed_token`, or
- `402` (friction required) + `x402-*` pricing headers + `decision_id`

Friction is a mechanism to make enforcement real.

Payment (x402-style) is **one possible** way to resolve friction. In later phases, friction can also be resolved via budgets, rate limits, or manual approvals.

## Smart governance (beyond simple counting)

ProceedGate doesn't just count requests — it analyzes agent behavior with 7 signals:

| Signal | What it detects |
|--------|----------------|
| **3-zone model** | safe (≤5) → gray (6-10, AI decides) → storm (>10, hard block) |
| **AI decision zone** | In gray zone, Llama 3.1 8B DECIDES allow/block based on behavioral signals |
| **Interval CV** | Coefficient of variation — bot-like regularity (CV<0.15) vs human-like irregularity (CV>0.4) |
| **Backoff detection** | Intervals growing? Agent is backing off responsibly → more lenient threshold |
| **Cost accumulation** | Tracks USD spent per window — higher cost = more reason to protect |
| **Similarity grouping** | Groups parameter variants (page=1, page=2, page=3) as same pattern |
| **Heuristic fallback** | v2 scoring with 7 factors when AI is unavailable |

Response headers expose governance state: `X-Proceedgate-Zone`, `X-Proceedgate-AI-Decided`, `X-Proceedgate-AI-Model`.

## Session-based budget tracking

Open a session with a budget cap → make checks → cumulative spend tracked → close session.

```bash
# Open session ($100 budget, 24h duration)
curl -X POST https://governor.proceedgate.dev/v1/governor/session \
  -H "Authorization: Bearer $PG_KEY" -H "Content-Type: application/json" \
  -d '{"agent_id":"my-agent","budget_usd":"100.00","duration_hours":24}'

# Check status (remaining budget, request count)
curl https://governor.proceedgate.dev/v1/governor/session/ses_... \
  -H "Authorization: Bearer $PG_KEY"

# Close session (finalize spend)
curl -X DELETE https://governor.proceedgate.dev/v1/governor/session/ses_... \
  -H "Authorization: Bearer $PG_KEY"
```

Pass `session_id` in check context for cumulative tracking:

```json
{ "context": { "session_id": "ses_...", "tool": "web_scrape" } }
```

## Agent Identity & Reputation

Every `actor.id` in a check request is treated as a first-class identity — each agent accumulates its own trust profile independently of the workspace.

**What's tracked per agent:**
- First/last seen timestamps
- Workspaces where the agent has operated (up to 50, most recent)
- Reputation score: same 5-component model as workspace reputation (compliance rate, pattern regularity, backoff cooperation, etc.)
- Optional ERC-8004 wallet address via `actor.wallet`

**How it works**: on every `/v1/governor/check` call the system fire-and-forgets two background updates — a profile upsert and a reputation event — with zero latency impact on the primary response.

```json
{
  "policy_id": "scraping_v1",
  "action": "fetch_url",
  "actor": {
    "id": "my-scraper-v2",
    "project": "my-workspace",
    "wallet": "0xOptionalERC8004AgentWallet"
  },
  "context": { "attempt_in_window": 1 }
}
```

**Query agent identity** (admin key required):

```bash
# Get profile + reputation
curl https://governor.proceedgate.dev/v1/agents/my-scraper-v2 \
  -H "Authorization: Bearer $PG_ADMIN_KEY"

# List all agents (paginated)
curl https://governor.proceedgate.dev/v1/agents \
  -H "Authorization: Bearer $PG_ADMIN_KEY"
```

Response example:
```json
{
  "profile": {
    "agent_id": "my-scraper-v2",
    "first_seen_ms": 1743500000000,
    "last_seen_ms": 1743550000000,
    "workspace_ids": ["my-workspace", "other-project"],
    "payment_count": 0
  },
  "reputation": {
    "score": 82,
    "tier": "trusted",
    "thresholds": { "loop_max_count_multiplier": 1.2, "gray_zone_offset": 1 }
  }
}
```

## OpenAPI discovery

AI agents auto-discover ProceedGate capabilities via `GET /openapi.json` with machine-readable extensions:
- `x-service-info`: realm, categories, supported protocols (x402, mpp)
- `x-cost-info`: per-endpoint credit cost, loop detection config, session support

## Payments

ProceedGate suportă plăți x402 pe două rețele BNB Chain. Agenții pot alege rețeaua — opBNB are taxe de gas de ~$0.0001, ideal pentru agenți cu volum mare de request-uri.

### BNB Smart Chain (BSC) — recomandat pentru compatibilitate maximă
- **Token**: USDC (`0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`, 18 decimale)
- **Chain ID**: 56
- **Contract guvernanță**: [`0x161D749892a23AC8792eE7fD37f0F423E0b69C97`](https://bscscan.com/address/0x161D749892a23AC8792eE7fD37f0F423E0b69C97) ✓ verificat
- **Gas fee mediu**: ~$0.05–0.20 per tranzacție

### opBNB Mainnet — recomandat pentru agenți cu volum mare
- **Token**: USDT (`0x9e5AAC1Ba1a2e6aEd6b32689DFcF62A509Ca96f3`, 18 decimale)
- **Chain ID**: 204
- **Contract guvernanță**: [`0xAd8Da0Af368804e47bcdA8217b4e24F4cEb058dA`](https://opbnbscan.com/address/0xAd8Da0Af368804e47bcdA8217b4e24F4cEb058dA) ✓ verificat
- **Gas fee mediu**: ~$0.0001 per tranzacție (de ~1000× mai ieftin decât BSC)

### Cum funcționează plata (protocol x402)

```
1. Agent → POST /v1/governor/check → 402 Payment Required
                                       + x402-price: 0.004 USDC
                                       + x402-chain: BSC  (sau opBNB)
                                       + x402-recipient: 0x607F...
                                       + x402-decision-id: dec_...

2. Agent trimite USDT/USDC on-chain către recipientul din header

3. Agent → POST /v1/governor/redeem
           + x402-tx-hash: 0xabc...
           + x402-decision-id: dec_...

4. Worker verifică tx on-chain (RPC call: eth_getTransactionReceipt)
   → confirmă Transfer(from, recipient, amount) în logs

5. Worker returnează → proceed_token (JWT, TTL 45s)

6. Agent atașează proceed_token la request-ul protejat → executat
```

Pentru a selecta rețeaua opBNB în loc de BSC, setează în `wrangler.toml` (sau ca variabilă de mediu):
```toml
X402_CHAIN = "opBNB"
```

## What’s in this repo

- **Worker** (Cloudflare Workers + TypeScript + Hono): Governor API with loop detection, session budgets, and OpenAPI discovery.
- **SDK** (`@proceedgate/node`): Framework-agnostic Node.js SDK — gateStep, requireGateStepOk, withProceedGateGate, JWT verification.
- **Vercel AI SDK** (`@proceedgate/vercel-ai`): Middleware + tool wrapper for the Vercel AI SDK.
- **LangChain** (`@proceedgate/langchain`): Callback handler, tool wrapper, and agent executor for LangChain.
- **CrewAI** (`proceedgate-crewai`, Python): Callback, tool decorator, and BudgetAwareCrew for CrewAI agents.
- **MCP Server** (`@proceedgate/mcp-server`): Model Context Protocol server — 5 tools for Claude Code, Cursor, etc.
- **Runner** (Node.js + TypeScript CLI): reference enforcement implementation.
- **Site** (`site/`): Static site on Cloudflare Pages with live dashboard.

## Quickstart

### Prereqs

- Node.js 20+ recommended (Node 18+ OK)

### Install

```bash
npm install
```

### Run end-to-end locally (recommended)

```bash
npm run smoke
```

### Run Worker locally

```bash
npm run dev:worker
```

### Run runner demo

```bash
npm run build
node runner/dist/cli.js run examples/demo-task.json --governor http://127.0.0.1:8787 --tx-hash 0xstub
```

## Deploy

Chosen v1 hostname:

- `governor.proceedgate.dev`

Routes are configured in `worker/wrangler.toml`.

### DNS

In Cloudflare DNS for `proceedgate.dev`, create `governor` as a proxied record.

### Secrets (prod)

Recommended:

- `GOVERNOR_SIGNING_JWK` (stable ES256 private JWK JSON)

Auth (recommended):

- `API_ADMIN_KEY` (required when `API_AUTH_MODE=workspace` in prod)

```bash
cd worker
npx wrangler secret put GOVERNOR_SIGNING_JWK
```

Set the admin key (used to provision per-workspace API keys):

```bash
cd worker
npx wrangler secret put API_ADMIN_KEY
```

Notes:

- Production is configured for `API_AUTH_MODE=workspace` in `worker/wrangler.toml`.
- All billing endpoints and credit-based `/v1/governor/check` require `Authorization: Bearer <workspace_api_key>`.
- Create workspace keys via `POST /v1/workspaces/create` with header `x-admin-key: <API_ADMIN_KEY>`.

Example (create a workspace key):

```bash
curl -sS -X POST https://governor.proceedgate.dev/v1/workspaces/create \
  -H "content-type: application/json" \
  -H "x-admin-key: $API_ADMIN_KEY" \
  -d '{"workspace_id":"acme"}'
```

Then use it:

```bash
export PROCEEDGATE_API_KEY="<workspace_api_key>"
node runner/dist/cli.js run examples/demo-task.json \
  --governor https://governor.proceedgate.dev \
  --tx-hash 0xstub \
  --api-key "$PROCEEDGATE_API_KEY"
```

### Deploy Worker

```bash
npm run deploy:worker
```

## Website (static)

The landing page lives in `site/`.

### Deploy to `https://proceedgate.dev` (Cloudflare Pages)

This repo includes a GitHub Actions workflow that deploys `site/` to **Cloudflare Pages**.

One-time setup:

1. In Cloudflare Pages, create a project (no build step) and connect it to this repo, or create an empty project with the same name.
2. Add the custom domain `proceedgate.dev` to that Pages project.
3. In GitHub repo settings:
   - Secrets:
     - `CLOUDFLARE_API_TOKEN`
     - `CLOUDFLARE_ACCOUNT_ID`
   - Variables:
     - `CLOUDFLARE_PAGES_PROJECT` (the Pages project name)

Deploy:

- Push changes to `site/` on `main`, or run the workflow manually.

Local deploy (if you are logged in via `wrangler`):

```bash
npm run deploy:site
```

Note: There is also an optional manual-only GitHub Pages workflow for previewing, but the production domain should be Cloudflare Pages.

## Docs

- Spec (frozen v1 contract): `SPEC.md`
- Changelog: `CHANGELOG.md`
- API docs: https://proceedgate.dev/docs.html
- Framework-agnostic integration guide (Node SDK): `INTEGRATION.md` (`@proceedgate/node`)
- Smoke test: `SMOKE_TEST.md`
- Payment verification modes: `PAYMENT_VERIFICATION.md`
- Observability (logs/headers/metrics): `OBSERVABILITY.md`
- Operations (tail + metrics queries): `OPERATIONS.md`
- Buyer-friendly technical summary: `ONE_PAGER.md`
- Competition runbook: `HACKATHON.md`
- Submission checklist: `HACKATHON_SUBMISSION_CHECKLIST.md`
- AI usage log: `AI_BUILD_LOG.md`
- OpenClaw setup: `OPENCLAW_SETUP.md`
- Judge package (starter-kit style):
  - `docs/PROJECT.md`
  - `docs/TECHNICAL.md`
  - `docs/EXTRAS.md`
  - `bsc.address`

## OpenClaw Competition Mode

ProceedGate is adapted for OpenClaw as an **Onchain Cost Governor Agent**.

- Primary track: `Agent`
- Non-stub proof flow: `npm run demo:hackathon:proof`
- OpenClaw assets: `openclaw/`
- OpenClaw skill package: `skills/onchain-cost-governor/`
- Onchain contract package: `contracts/`

Required env for proof command:

- `HACKATHON_API_ADMIN_KEY`
- Optional overrides: `HACKATHON_BASE_URL`, `HACKATHON_TX_HASH`, `HACKATHON_WORKSPACE_ID`

## Licensing

This repository is intentionally **split-licensed**:

- SDK, runner, and examples are Apache-2.0:
  - `sdk-node/`
  - `runner/`
  - `examples/`
  (see each directory's `LICENSE` file)
- The Governor server implementation is proprietary / closed source:
  - `worker/` (see `worker/LICENSE`)

See the repository-level `LICENSE` for the summary.

## Hosted Service Terms

For the hosted ProceedGate service, see `TERMS_OF_SERVICE.md`.
