# Agent Cost Governor (DFaaS v1)

Standalone project (separate from TokenSentry) for a pay-per-decision “economic governor” designed for autonomous agents.

- Worker (Cloudflare Workers + TypeScript + Hono): exposes the Governor API.
- Runner (Node.js + TypeScript CLI): reference enforcement implementation.

## High-level

The runner calls the Governor before executing steps (tool calls / retries). The Governor either:

- returns `200` with a short-lived `proceed_token`, or
- returns `402` with `x402-*` pricing headers; runner pays and redeems, then continues.

## Local dev

### Prereqs
- Node.js 20+ recommended (Node 18+ OK)

### Install

```bash
npm install
```

### Run Worker locally

```bash
npm run dev:worker
```

### Run runner demo

```bash
npm run build
node runner/dist/cli.js run examples/demo-task.json --governor http://127.0.0.1:8787
```

## Domain / deploy

This repo is designed to be deployed to a separate domain.

Chosen v1 hostname:

- `governor.proceedgate.dev`

Routes are configured in `worker/wrangler.toml`.

Important: ensure the hostname resolves in DNS.

- In Cloudflare DNS for `proceedgate.dev`, create `governor` as a proxied record (CNAME is fine).
- Point it to your Workers hostname (e.g. `agent-cost-governor.<your-account>.workers.dev`) or any placeholder target while proxied.

### Deploy

Prereqs:

- `wrangler` authenticated (`npx wrangler login`)

Recommended secrets (prod):

- `GOVERNOR_SIGNING_JWK` (stable ES256 private JWK JSON)

Set secrets:

```bash
cd worker
npx wrangler secret put GOVERNOR_SIGNING_JWK
```

Deploy:

```bash
cd worker
npx wrangler deploy
```

## Spec

See `SPEC.md` for the frozen v1 contract.
