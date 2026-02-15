# ProceedGate — 1‑pager (v1)

## Summary

ProceedGate gates **any expensive AI agent action** — LLM calls, paid APIs, browser automation, scraping, onchain transactions — with hard enforcement.

It sits outside the agent loop and enforces a simple invariant:

- an agent step is allowed only if it has a valid short-lived `proceed_token`.

## Problem

Teams running agents in production routinely see:

- runaway LLM retries / regeneration loops
- expensive browser automation loops
- uncontrolled external paid API usage

Best-effort guardrails inside the agent are easy to bypass (intentionally or accidentally). Post-mortems are common; prevention is rare.

## Solution

ProceedGate makes control enforceable by introducing a mandatory gate:

- Before a step, the runner/middleware calls the Governor.
- The Governor returns either `200` (allowed) or `402` (friction).
- The runner refuses to execute unless it has a valid token.

Payment (x402-style) is **one** friction resolution path. The product headline is cost-control; monetization is an expansion path.

## Architecture

- Governor: Cloudflare Worker API
  - `POST /v1/governor/check` → `200` or `402`
  - `POST /v1/governor/redeem` → token after friction resolution
  - `GET /.well-known/jwks.json` → public keys for verification
- Runner: reference implementation that enforces the gate
- Persistence: Durable Object decision store (one-time redeem)

## Security / correctness

- Tokens are asymmetric JWTs verified via JWKS.
- Token binds to:
  - actor (`sub`)
  - decision id (`jti`)
  - policy/action/task/step (claims)
  - optional canonical `context_hash` bound into `ctx`
- Short TTL (default 45s) limits replay.

## What v1 controls (canonical examples)

- LLM retries / regeneration loops
- Browser / web automation actions
- External paid API calls (scraping, SerpAPI, Firecrawl, Apify)
- Onchain transactions and smart contract calls
- Any tool invocation with a cost attached

> The `action` field is a free string — ProceedGate gates whatever you declare expensive.

## Observability

- Structured JSON logs per decision (low-PII; actor id is hashed)
- Optional response headers for debugging
- Optional Analytics Engine metrics: counters + latency

See: `OBSERVABILITY.md` and `OPERATIONS.md`.

## Integration (30 minutes)

1. Add a gate call before every step:
   - call `POST /v1/governor/check`
2. If `200`, run the step.
3. If `402`, resolve friction (payment is one option), then call `POST /v1/governor/redeem` and continue.
4. Verify `proceed_token` via JWKS in the runner/middleware.

Spec: `SPEC.md`.

## Roadmap (product-first)

- Adoptability: small SDKs + middleware adapters + framework examples
- Value: budgets, rate limits, escalation paths (manual approve)
- Expansion: facilitator payments, invoices, org/project billing
