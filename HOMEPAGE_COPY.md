# ProceedGate — Homepage Copy (v1)

## Hero

**ProceedGate**

**Stop runaway agents. Enforce cost caps and sane behavior.**

ProceedGate is an **economic governor for AI agents**: a hard gate that blocks expensive steps unless the agent has a short‑lived `proceed_token`.

Primary CTA: **Integrate in 30 minutes**
Secondary CTA: Run a demo

Small print (clarity, not buzz):
- Works with any agent framework (you control the runner/middleware).
- Two outcomes only: `200` (go) or `402` (friction).
- Enforcement sits outside the agent loop.

---

## Problem

If you run agents in production, you’ve seen this:

- **LLM retries / regeneration loops** that quietly burn money.
- **Browser automation loops** (Playwright-style) that stall and rack up runtime.
- **External paid API calls** that get spammed when the agent gets confused.

“Just add guardrails in the prompt” is not enforceable.

ProceedGate makes it enforceable.

---

## What ProceedGate does

ProceedGate introduces a mandatory checkpoint before your agent executes a costly step.

- If the step is within policy/budget: you get a short‑lived token and proceed.
- If not: you get friction (`402`) and the agent cannot continue until friction is resolved.

This is **hard gating**, not “suggested behavior”.

---

## How it works (simple contract)

### 1) Check
Before executing a step, your runner/middleware calls:

- `POST /v1/governor/check`

You get either:

- `200` + `proceed_token` (allowed), or
- `402` + `x402-*` headers + `decision_id` (friction required)

### 2) Resolve friction
If you receive `402`, you decide how to resolve friction.

Payment (x402-style) is **one** resolution mechanism.

Other resolution paths (roadmap): budgets, rate limits, manual approval.

### 3) Redeem
When friction is resolved:

- `POST /v1/governor/redeem` → `200` + `proceed_token`

### 4) Enforce
Your runner verifies the token (JWKS + JWT) and proceeds.

No token, no step.

---

## Integrate in 30 minutes (engineering checklist)

You can integrate ProceedGate without changing your model provider or agent framework.

1. Identify “costly steps” in your loop:
   - retries/regenerations
   - browser actions
   - paid API calls
2. Add a gate call before each step:
   - call `POST /v1/governor/check`
3. Enforce the response:
   - if `200`, execute the step
   - if `402`, stop and resolve friction, then redeem
4. Verify the token:
   - use JWKS (`GET /.well-known/jwks.json`) to verify signature + claims

If you hate it, you can remove it later: it’s a thin middleware boundary.

---

## Why this works (when “policies” don’t)

- **External enforcement**: decisions are enforced in the runner/middleware, not in prompt text.
- **Two-outcome API**: makes agent behavior predictable and integration straightforward.
- **Context binding**: optional canonical `context_hash` can be bound into the token (`ctx`) to prevent token reuse across different steps.
- **Short TTL**: tokens expire quickly (default 45s) to reduce replay.

---

## Observability (built in)

You get visibility without logging raw PII.

- Structured JSON logs per decision
- Optional response headers (`X-Proceedgate-*`) for debugging
- Optional Analytics Engine metrics (counters + latency)

Links:
- `OBSERVABILITY.md`
- `OPERATIONS.md`

---

## Open source reference implementation

This repo ships a working Worker + Runner:

- Cloudflare Worker (Governor API)
- Node.js runner (reference enforcement)

Try it locally:

- `npm install`
- `npm run smoke`

---

## FAQ

### Is this “pay-per-action monetization”?
Not as the headline.

ProceedGate is cost-control first.

Payment is a friction mechanism that makes enforcement real. Monetization is an optional expansion once you have trust and real usage data.

### What’s the failure mode?
If the governor is down, your runner should fail closed for truly expensive steps, or implement a fallback policy (your call). The contract stays simple.

### Does this lock me in?
No. It’s a middleware boundary with a small API surface. You can remove it without rewriting your agent.

---

## Call to action

**Integrate in 30 minutes**

- Read the spec: `SPEC.md`
- Run the demo: `npm run smoke`
- Deploy the governor: `npm run deploy:worker`
