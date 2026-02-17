# ProceedGate — Gate Any Expensive AI Agent Action, Onchain

> **Good Vibes Only: OpenClaw Edition** | Track: **Agent** (AI Agent × Onchain Actions)

ProceedGate gates **any expensive AI agent action** — LLM calls, paid APIs, browser automation, scraping, onchain transactions — with hard enforcement.

ProceedGate sits **outside** the agent loop and blocks costly steps unless the agent has a valid short-lived `proceed_token`. If an agent enters a retry storm, ProceedGate automatically gates it with escalating micropayments verified on BSC.

## Hackathon Quick Links

| Resource | Link |
|---|---|
| Live endpoint | `https://agent-cost-governor-hackathon.apiworkersdev.workers.dev` |
| Proof tx (BSC) | [`0xd97039...b548`](https://bscscan.com/tx/0xd97039268c048cafd45c0f3b870111b1dcd22f3fdfd62a47e75ae843eb13b548) |
| Contract (BSC Testnet, Sourcify ✓) | [`0x2054Cc...Ffd5`](https://testnet.bscscan.com/address/0x2054Cc6Fa82e7c64b8226913c3b087CA8F18Ffd5) |
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

## What’s in this repo

- Worker (Cloudflare Workers + TypeScript + Hono): Governor API.
- Runner (Node.js + TypeScript CLI): reference enforcement implementation.

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
