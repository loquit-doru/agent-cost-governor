# ProceedGate (DFaaS v1)

Stop runaway agents. Enforce cost and behavior.

ProceedGate is a **cost-control & governance** primitive for autonomous agents in production.

It sits **outside** the agent loop and blocks expensive/risky steps unless the agent has a valid short-lived `proceed_token`.

Primary audience (v1 headline): **internal teams running agents in prod**.

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

```bash
cd worker
npx wrangler secret put GOVERNOR_SIGNING_JWK
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
