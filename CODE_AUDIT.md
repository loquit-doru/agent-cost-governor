# ProceedGate — Comprehensive Code Audit

> Generated: 2026-02-17 | Auditor: GitHub Copilot  
> Scope: All packages — worker, sdk-node, mcp-server, runner, site

---

## 1. SDK (`sdk-node/src/`) — Exports & Capabilities

### Exported Functions

| Export | File | Purpose |
|--------|------|---------|
| `createProceedGateClient()` | `client.ts` | Factory that creates the main API client. Returns `ProceedGateClient` with `.check()` and `.redeem()` methods. Supports `failMode: 'open' \| 'closed'` for network errors/5xx. |
| `gateStep()` | `gate.ts` | High-level one-call function: check → 402? auto-redeem (if txHash given or env var) → call `onFriction` hook → return `'ok'` or `'friction'`. |
| `gateStepWithRaw()` | `gate.ts` | Same as `gateStep()` but includes raw HTTP response bodies for debugging. |
| `requireGateStepOk()` | `gate.ts` | Wrapper: calls `gateStep()`, throws `ProceedGateFrictionError` if friction returned. |
| `requireGateStepOkWithRaw()` | `gate.ts` | Same with raw bodies. |
| `withProceedGateGate()` | `withGate.ts` | HOF decorator: wraps any `async fn` with automatic gate check. Returns `{ result, gate }`. |
| `verifyProceedToken()` | `jwks.ts` | Verify a proceed JWT against the JWKS endpoint. Checks `sub`, `jti`, `task`, `step`, `ctx` claims. Uses `jose` library. |
| `sha256Hex()` | `hash.ts` | SHA-256 hex digest of a string. |
| `sha256CanonicalJsonHex()` | `hash.ts` | SHA-256 of canonical JSON (sorted keys). |
| `canonicalizeJson()` | `canonicalJson.ts` | Recursively sort object keys, strip `undefined`. |
| `canonicalJsonStringify()` | `canonicalJson.ts` | `JSON.stringify(canonicalizeJson(value))`. |
| `ProceedGateFrictionError` | `errors.ts` | Custom error class with `code: 'PROCEEDGATE_FRICTION'`, carries `decisionId`, `policyId`, `action`, `friction` info. |

### Exported Types

`Action`, `Actor`, `CheckContext`, `GateStepFriction`, `GateStepFrictionWithRaw`, `GateStepInput`, `GateStepOk`, `GateStepOkWithRaw`, `GateStepResult`, `GateStepResultWithRaw`, `GovernorCheck402`, `GovernorCheckOk`, `GovernorCheckRequest`, `GovernorRedeemOk`, `PolicyId`, `ProceedGateClient`, `ProceedGateClientOptions`, `WithProceedGateGateOptions`, `X402Headers`, `ProceedGateFrictionErrorParams`, `ProceedGateFrictionInfo`.

### SDK Sophistication Rating: **HIGH**
- Full fail-open / fail-closed resilience
- Automatic tx hash from env var (`PROCEEDGATE_TX_HASH`)
- `onFriction` hook for wallet/UI integration
- HOF wrapper for zero-friction integration
- JWKS-based JWT verification
- Raw response debugging variants
- Canonical JSON for deterministic hashing

---

## 2. MCP Server (`mcp-server/src/`) — Tools Exposed

Uses `@modelcontextprotocol/sdk` with stdio transport. Connects via CLI args:
`--api-key`, `--base-url`, `--workspace-id`.

### MCP Tools

| Tool | Description | Params |
|------|-------------|--------|
| `gate_check` | Check if action is allowed. Call BEFORE any costly action. | `action` (required, enum), `policy_id`, `tool`, `cost_estimate`, `attempt_number`, `confidence`, `context` |
| `gate_redeem` | Resolve friction after payment. | `decision_id` (required), `tx_hash` (required) |
| `get_balance` | Get credit balance + usage stats. | none |
| `set_budget` | Set daily/weekly/monthly limits + alert threshold. | `daily_limit`, `weekly_limit`, `monthly_limit`, `alert_threshold` |
| `get_usage_report` | Get usage breakdown by action/tool/time. | `period` (today/week/month/all) |

### MCP Client

Separate `ProceedGateClient` class (not the SDK one — parallel implementation) with methods:
- `check(request)` — POST /v1/governor/check
- `redeem(decisionId, txHash)` — POST /v1/governor/redeem
- `getBalance()` — GET /v1/billing/balance
- `setBudget(config)` — POST /v1/billing/budget
- `getUsageReport(period)` — GET /v1/billing/usage

### MCP Sophistication: **MEDIUM-HIGH**
- 5 real tools with proper schemas
- Graceful error handling (catches failures, returns helpful messages)
- Separate client class (duplication from sdk-node, but works)

---

## 3. Worker API Surface — Complete Endpoint List

### Core Governance

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/v1/governor/check` | Workspace key (credits mode) | Main decision endpoint. Loop detection → zone (safe/gray/storm) → AI gray-zone decision → credit consumption → policy friction. Returns 200 (allowed) or 402 (friction). |
| POST | `/v1/governor/redeem` | None (decision_id + x402-tx-hash) | Redeem friction decision with payment proof. Verifies on-chain, signs proceed_token JWT. |

### Simplified Check

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/v1/check/simple` | Workspace key (Bearer) | Billing-only check. Auto-discovers workspace from API key. Just consumes credits, no policy/friction. |

### Demo (Public, No Auth)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/v1/demo/check` | None | Public demo of loop detection with real Workers AI reasoning. Uses "demo-public" workspace. |
| GET | `/v1/demo/stats` | None | Real-time dashboard data: decisions, storms, cost saved, storm chart. |

### Billing

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/v1/billing/quote` | Workspace key | Create billing quote (credits → USDC price). |
| POST | `/v1/billing/redeem` | Workspace key | Redeem billing quote with on-chain tx. |
| GET | `/v1/billing/balance` | Workspace key | Get workspace credit balance. |
| PUT | `/v1/billing/budget` | Workspace key | Set budget limits (daily/weekly/monthly) + webhook URL. |
| GET | `/v1/billing/budget` | Workspace key | Get budget configuration. |
| DELETE | `/v1/billing/budget` | Workspace key | Delete budget limits. |
| GET | `/v1/billing/usage` | Workspace key | Usage report by period (today/week/month/all). |
| GET | `/v1/billing/stats` | Workspace key | Blocked requests count + cost saved metric. |

### Subscription (Self-Service, No Auth Needed)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/v1/billing/subscribe` | None | Create subscription invoice (plan + months → USDC amount). Plans: starter/$19, pro/$59, scale/$199. |
| GET | `/v1/billing/subscribe/:id` | None | Poll invoice status. |
| POST | `/v1/billing/subscribe/confirm` | None | Confirm payment → verify on-chain → create workspace → return API key. |
| POST | `/v1/billing/subscribe/renew` | Workspace key | Renew subscription with on-chain payment. |
| GET | `/v1/billing/subscribe/plans` | None | List available plans with features. |
| POST | `/v1/billing/free-signup` | None | Free tier signup (email only) → 2000 checks, 1 project. |

### Admin

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/v1/workspaces/create` | Admin key | Create workspace manually. |
| POST | `/v1/workspaces/rotate_key` | Admin key | Rotate workspace API key. |
| POST | `/v1/workspaces/revoke_key` | Admin key | Revoke workspace API key. |
| GET | `/v1/workspaces/status` | Admin key | Get workspace auth status. |

### Infrastructure

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/.well-known/jwks.json` | None | JWKS public key for proceed_token verification. |
| GET | `/health` | None | Health check. |
| GET | `/v1/status` | None | Status with version + timestamp. |
| GET | `/mcp` | None | MCP discovery: tools, policies, endpoints, SDKs, Claude Desktop config. |
| POST | `/x402/verify` | Facilitator key | Facilitator payment verification proxy. |

### Rate Limiting
- `/v1/billing/*` and `/v1/subscribe/*`: 30 req/min per IP
- `/v1/admin/*`: 10 req/min per IP

**Total: ~25 distinct endpoints**

---

## 4. Durable Object Data Model

### `DecisionStoreDO`
Simple key-value for pending friction decisions (TTL-based).

| Key Pattern | Data | Purpose |
|-------------|------|---------|
| `dec:{decisionId}` | `DecisionRecord` | Pending redeem decisions (10 min TTL). Auto-deleted on expiry or redemption. |

### `BillingStoreDO` (1651 lines — the real brain)

| Key Pattern | Data Type | Purpose |
|-------------|-----------|---------|
| `ws:{workspaceId}` | `WorkspaceBalance` | Credit balance per workspace |
| `auth:{workspaceId}` | `WorkspaceAuth` | API key hash + timestamps |
| `keyidx:{apiKeyHash}` | `string` (workspaceId) | O(1) reverse lookup: key → workspace |
| `quote:{quoteId}` | `BillingQuoteRecord` | Billing quotes (30 min TTL) |
| `tx:{txHash}` | `string` (quoteId) | Replay prevention: one tx = one quote |
| `budget:{workspaceId}` | `BudgetConfig` | Daily/weekly/monthly limits + webhook URL |
| `usage:{workspaceId}:{YYYY-MM-DD}` | `UsageRecord` | Per-day usage (credits, actions, tools breakdown) |
| `blocked:{workspaceId}` | `BlockedStats` | Blocked requests count + cost saved USD |
| `loop:{workspaceId}:{patternHash}` | `LoopPattern` | Loop detection: count, timestamps (last 20), cost, intervals |
| `sim:{workspaceId}:{prefix}` | `{hashes[], lastMs}` | Similarity group tracking (parameter enumeration detection) |
| `sub:{workspaceId}` | Subscription metadata | Plan, credits, expiry, features |
| `webhook:{workspaceId}` | Webhook config | URL, secret, events |
| `credits_low_notified:{workspaceId}` | `boolean` | One-time notification flag (reset on renewal) |
| `dlog:{workspaceId}:{timestamp}:{id}` | `DemoDecisionEntry` | Decision log (last 200 entries, pruned) |
| `dmin:{workspaceId}:{minuteKey}` | `{total, blocked}` | Per-minute counters for storm chart |
| `dcnt:{workspaceId}` | `number` | Total decision counter |
| `invoice:{invoiceId}` | `Invoice` | Subscription invoices |
| `payment:{paymentId}` | `PaymentRecord` | Permanent payment audit log |
| `paytx:{txHash}` | `string` (paymentId) | Payment dedup by tx hash |
| `wspay:{workspaceId}` | `string[]` | Workspace payment list |
| `payments:all` | `string[]` | Global payment list (last 1000) |
| `projects:{workspaceId}` | `string[]` | Project IDs list |
| `project:{workspaceId}:{id}` | Project data | Individual project |
| `custpolicies:{workspaceId}` | `string[]` | Custom policy IDs |
| `custpolicy:{workspaceId}:{id}` | Policy data | Custom policy CRUD |

### DO Internal Endpoints

**Quotes**: PUT/GET/POST (redeem) `/quotes/:id`  
**Workspaces**: GET `/workspaces/:id`, POST `/:id/consume`, PUT/DELETE `/:id/key`, POST `/:id/verify`, GET `/:id/auth`, GET/PUT/DELETE `/:id/budget`, GET `/:id/usage`, GET `/:id/stats`, POST `/:id/block`, POST `/:id/check-loop`, GET `/:id/analytics`, POST `/:id/log-decision`, GET `/:id/decision-log`, GET `/:id/storm-chart`, PUT/GET `/:id/webhook`, POST `/:id/add-credits`, GET `/:id/subscription`  
**Projects**: GET/POST/DELETE `/workspaces/:id/projects[/:projectId]`  
**Policies**: GET/POST/PUT/DELETE `/workspaces/:id/policies[/:policyId]`  
**Keys**: POST `/keys/lookup`  
**Invoices**: PUT/GET/DELETE `/invoices/:id`  
**Payments**: POST/GET `/payments`, GET `/payments/by-tx/:hash`, `/payments/by-workspace/:id`, `/payments/stats`  
**Admin**: GET `/admin/workspaces`  
**Alarm**: Daily cleanup of old usage logs per retention policy.

---

## 5. Runner (`runner/src/`) — CLI Capabilities

**Command**: `agent-runner run <task.json> --governor <url> [--mode fail-open|fail-closed] [--tx-hash <hash>] [--api-key <key>] [--abort-on-402]`

### What it does:
1. Reads a task file (JSON) with `steps[]`
2. For each step, for each attempt:
   - Computes `taskHash`, `stepHash`, `contextHash` (canonical JSON → SHA-256)
   - Calls `/v1/governor/check`
   - If 200: verifies proceed_token via JWKS
   - If 402: either uses provided `--tx-hash`, prompts user interactively, or aborts
   - After redeem: verifies proceed_token again
3. Reports `friction_events` + `friction_paid_usdc` totals

### Task File Schema:
```json
{
  "actor_id": "agent:abc",
  "project": "my-project",
  "steps": [{
    "name": "step name",
    "policy_id": "retry_friction_v1",
    "action": "tool_call",
    "tool": "scraper",
    "attempts": 5,
    "window_seconds": 30,
    "confidence": 0.8
  }]
}
```

---

## 6. Analytics / Dashboard

### `site/dashboard.html` — Live Dashboard (Public)
Real-time dashboard powered by Durable Object storage:
- **Total Decisions** counter
- **Storms Blocked** counter
- **Cost Saved USD** running total
- **Decision Log** — last 50 decisions with AI reasoning, zone, latency
- **Storm Chart** — per-minute request rates (last 60 min, total vs blocked)
- **Blocked by Reason** breakdown
- **Interactive demo button**: fires `POST /v1/demo/check` and shows real-time AI reasoning

Data source: `GET /v1/demo/stats` → polls every 10 seconds.

### Per-Workspace Analytics (Authenticated)
- `GET /v1/billing/usage?period=` — usage by day with action/tool breakdown
- `GET /v1/billing/stats` — blocked requests + cost saved
- DO internal: `GET /workspaces/:id/analytics?period=7d|14d|30d|90d` — daily aggregation with summary

### Other Site Pages
- `index.html` — Landing page with pricing, free signup, subscription flow
- `scraping.html` — Scraping vertical landing page
- `pay.html` — On-chain payment UI (USDC on Base/Polygon)
- `demo.html` — Interactive demo

---

## 7. Webhook System

### Webhook Functions & Wiring

| Function | Event | Actually Called? |
|----------|-------|-----------------|
| `sendWebhook()` | Generic sender | ✅ Base function used by all |
| `webhookSubscriptionCreated()` | `subscription.created` | ✅ Called in `subscribe.ts` after confirm |
| `webhookSubscriptionRenewed()` | `subscription.renewed` | ✅ Called in `subscribe.ts` after renew |
| `webhookCreditsLow()` | `credits.low` | ✅ Called in `check.ts` (governor/check + check/simple) |
| `webhookSubscriptionExpiring()` | `subscription.expiring` | ❌ **DEAD CODE** — never called |
| `webhookBudgetExceeded()` | `budget.exceeded` | ❌ **DEAD CODE** — never called |

### Webhook Features
- HMAC-SHA256 signing (`X-ProceedGate-Signature: sha256=...`)
- Per-workspace config (URL + secret + event filter)
- Fallback to budget config webhook_url

---

## 8. Email System

| Function | Purpose | Actually Called? |
|----------|---------|-----------------|
| `sendSubscriptionConfirmation()` | Welcome email with API key | ✅ Yes |
| `sendLowCreditsAlert()` | Credits low alert | ❌ **DEAD CODE** |
| `sendExpiryWarning()` | Subscription expiry warning | ❌ **DEAD CODE** |

Uses Resend API. Gracefully degrades if `RESEND_API_KEY` not configured.

---

## 9. AI Reasoning Engine

### Two Modes
1. **Template-based** (zero latency) — deterministic fallback
2. **Workers AI** (Llama 3.1 8B) — real LLM inference

### Gray Zone AI Decision-Making (NOT cosmetic)
When request count is 6-10, the LLM **ACTUALLY DECIDES** allow/block based on:
- `interval_cv` — low = mechanical bot, high = human-like
- `requests_per_sec` — rate analysis
- `backoff_detected` — agent backing off = good behavior (lenient)
- `similar_pattern_count` — parameter enumeration detection
- `cost_window_usd` — accumulated cost context

Falls back to heuristic if AI unavailable/timeout.

---

## 10. Policies

### Active (in check.ts)

| Policy | Pricing Logic |
|--------|---------------|
| `retry_friction_v1` | Exponential: `base * growth^(attempt - freeAttempts)`, capped |
| `low_confidence_v1` | `base * (1 + mult * severity) * attemptsFactor` |

### Defined But Not Wired

| Policy | Status |
|--------|--------|
| `llm_cost_v1` | `computeLLMCostPrice()` exists with 40+ model pricing DB. **Never called from check.ts**. Only advertised in `/mcp` discovery. |
| Custom Policies | CRUD exists in DO but **never evaluated during checks**. |

---

## 11. Configuration Options

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `BILLING_MODE` | `credits` or `x402` |
| `BILLING_CHAIN` / `BILLING_RECIPIENT` | On-chain payment config |
| `BILLING_CREDIT_COST_MICRO_USDC` | Credit pricing |
| `X402_PRICE` / `X402_CHAIN` / `X402_RECIPIENT` | x402 paywall config |
| `RETRY_FREE_ATTEMPTS` / `RETRY_BASE_PRICE` / `RETRY_GROWTH` / `RETRY_MAX_PRICE` | retry_friction_v1 tuning |
| `CONFIDENCE_THRESHOLD` / `CONFIDENCE_BASE_PRICE` / `CONFIDENCE_MAX_PRICE` / `CONFIDENCE_MULT` | low_confidence_v1 tuning |
| `LLM_COST_MARKUP` / `LLM_COST_FREE_THRESHOLD` / `LLM_COST_MAX` | llm_cost_v1 tuning (unused) |
| `API_ADMIN_KEY` | Admin endpoint auth |
| `FACILITATOR_KEY` | Facilitator auth |
| `RESEND_API_KEY` | Email sending (optional) |

### Per-Workspace
- Budget: daily/weekly/monthly limits, alert threshold, webhook URL
- Webhook: URL + secret + event filter
- Projects: CRUD
- Custom Policies: CRUD (storage only, not enforced)

---

## 12. Dead Code & Gaps Summary

### ❌ Dead Code (Defined, Never Called)

| Item | Location | Issue |
|------|----------|-------|
| `webhookBudgetExceeded()` | `services/webhook.ts` | Budget blocks return 402 but never fire webhook |
| `webhookSubscriptionExpiring()` | `services/webhook.ts` | No cron/alarm checks expiry |
| `sendLowCreditsAlert()` | `services/email.ts` | Only webhook version fires, not email |
| `sendExpiryWarning()` | `services/email.ts` | Never called |
| `computeLLMCostPrice()` | `lib/pricing.ts` | Full impl with 40+ models, never called |
| `llm_cost_v1` policy | `routes/mcp.ts` | Advertised but not implemented in check flow |
| Custom Policies CRUD | `billingStoreDO.ts` | CRUD exists, never evaluated during checks |

### ⚠️ Gaps

| Gap | Details |
|-----|---------|
| No subscription expiry enforcement | Workspaces don't get blocked when sub expires. No alarm checks expiry dates. |
| No budget.exceeded webhook | Budget limits block (402) but don't notify via webhook. |
| MCP client duplicates SDK | `mcp-server/src/client.ts` is separate from `sdk-node/src/client.ts`. |
| MCP `set_budget` uses POST, worker expects PUT | MCP's `setBudget` will fail at runtime. |
| No authenticated admin dashboard | `dashboard.html` is public demo only. |
| `index.old.ts` exists | Old entry point in `.gitignore` but still in tree. |

### ✅ Working End-to-End

| Feature | Status |
|---------|--------|
| Loop detection (safe/gray/storm zones) | ✅ |
| AI gray-zone decisions (Workers AI / Llama 3.1 8B) | ✅ |
| Credit consumption + budget enforcement | ✅ |
| Subscription flow (invoice → pay → workspace) | ✅ |
| Free tier signup | ✅ |
| Renewal with on-chain verification | ✅ |
| Proceed token signing (ES256) + JWKS | ✅ |
| Live dashboard with real DO data | ✅ |
| Cost saved tracking | ✅ |
| Payment audit log with dedup | ✅ |
| Replay prevention (tx hash) | ✅ |
| Backoff detection + similarity grouping | ✅ |
| Webhook: subscription.created/renewed + credits.low | ✅ |
| Confirmation email with API key | ✅ |
| Rate limiting (billing/admin) | ✅ |
| CORS + security headers | ✅ |

---

## 13. Statistics

| Metric | Value |
|--------|-------|
| API Endpoints | ~25 |
| SDK Exports | 11 functions + 20 types |
| MCP Tools | 5 |
| DO Key Patterns | 24+ |
| DO Internal Endpoints | ~40+ |
| Webhook Events | 4 defined, 3 wired |
| Email Templates | 3 defined, 1 wired |
| Pricing Policies | 3 defined, 2 active |
| BillingStoreDO | 1651 lines |
| check.ts | 965 lines |
| subscribe.ts | 2073 lines |
| LLM models in pricing DB | 40+ |
| Subscription Plans | 4 (free/starter/pro/scale) |
