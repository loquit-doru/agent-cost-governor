# ProceedGate — Onchain Cost Governor for AI Agents

> **Good Vibes Only: OpenClaw Edition** | Track: **Agent** (AI Agent × Onchain Actions)

Stop runaway AI agents. Enforce cost and behavior with onchain-verifiable friction.

ProceedGate sits **outside** the agent loop and blocks expensive/risky steps unless the agent has a valid short-lived `proceed_token`. If an agent enters a retry storm, ProceedGate automatically gates it with escalating micropayments verified on BSC.

## Hackathon Quick Links

| Resource | Link |
|---|---|
| Live endpoint | `https://agent-cost-governor-hackathon.apiworkersdev.workers.dev` |
| Proof tx (BSC) | [`0xd97039...b548`](https://bscscan.com/tx/0xd97039268c048cafd45c0f3b870111b1dcd22f3fdfd62a47e75ae843eb13b548) |
| Contract (BSC Testnet) | [`0xAd8Da0...58dA`](https://testnet.bscscan.com/address/0xAd8Da0Af368804e47bcdA8217b4e24F4cEb058dA) |
| Address index | [`bsc.address`](bsc.address) |
| Full setup guide | [`docs/TECHNICAL.md`](docs/TECHNICAL.md) |
| Project overview | [`docs/PROJECT.md`](docs/PROJECT.md) |
| AI build log | [`AI_BUILD_LOG.md`](AI_BUILD_LOG.md) |
| Competition runbook | [`HACKATHON.md`](HACKATHON.md) |

### Reproduce in 3 commands

```bash
npm install
npm --workspaces run check   # typecheck all packages
npm run smoke                # full local flow: check → 402 → redeem → proceed
```

See [`docs/TECHNICAL.md`](docs/TECHNICAL.md) for the complete step-by-step guide (8 validation commands).

---

## Integrate in 30 minutes

The quickest path is to adopt ProceedGate as a **runner/middleware gate**:

1. Before each step (tool call / retry / browser action / paid API call), call `POST /v1/governor/check`.
2. If you get `200`, proceed.
3. If you get `402`, your system must resolve friction (payment is one option) then call `POST /v1/governor/redeem` and proceed.

This repo includes a reference runner to demonstrate *hard enforcement*.

## What “costly steps” means (canonical v1 examples)

- LLM retries / regeneration loops
- Browser / web automation actions (Playwright-style)
- External paid API calls

## How it works (two outcomes)

Every decision check returns only:

- `200` (allowed) + `proceed_token`, or
- `402` (friction required) + `x402-*` pricing headers + `decision_id`

Friction is a mechanism to make enforcement real.

Payment (x402-style) is **one possible** way to resolve friction. In later phases, friction can also be resolved via budgets, rate limits, or manual approvals.

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
