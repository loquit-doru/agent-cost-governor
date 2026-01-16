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

This repo is designed to be deployed to a separate domain (e.g. `governor.<yourdomain>`). You’ll configure routes in `worker/wrangler.toml`.

## Spec

See `SPEC.md` for the frozen v1 contract.
