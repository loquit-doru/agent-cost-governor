# Agent Cost Governor – Spec v1 (frozen for MVP)

## Goals

- Enforce **economic friction** inside an agent execution loop via an external service.
- Allow a runner to **refuse execution** unless it has a valid `proceed_token`.
- Use an x402-style paywall for friction payments (HTTP 402 + retry with `x402-tx-hash`).

## Core invariants

- A decision check returns either:
  - `200` (allowed) + `proceed_token`, or
  - `402` (friction required) + x402 pricing headers + `decision_id`.
- Redeem returns `200` + `proceed_token` when payment is accepted.
- Tokens are signed with an asymmetric key; public keys are exposed via JWKS.

> Note: Implementation uses `ES256` (P-256) for broad runtime compatibility.
> Clients must not hardcode the algorithm; they verify via JWKS + JWT headers.

### Crypto versioning

- v1 is frozen on **ES256 (P-256)**.
- v2 plans to add **Ed25519 (EdDSA)** as a separate, deliberate upgrade once we have traction.

### Canonical context hashing (recommended)

`context_hash` is an optional field that binds a decision/token to a canonicalized view of `context`.

- Canonicalization rules:
  - recursively sort object keys
  - omit keys with `undefined` values
  - preserve array order
- Hash:
  - `context_hash = "sha256:" + sha256_hex(canonical_json(context_without_context_hash))`

When provided, the Governor MUST copy it into the token claim `ctx`, and the runner SHOULD verify it.

---

## Endpoints

### `POST /v1/governor/check`

#### Request (JSON)

```json
{
  "policy_id": "retry_friction_v1",
  "action": "tool_call",
  "actor": {
    "id": "agent:demo-bot-1",
    "project": "demo"
  },
  "context": {
    "attempt_in_window": 7,
    "window_seconds": 30,
    "confidence": 0.32,
    "tool": "example_tool",
    "task_hash": "sha256:...",
    "step_hash": "sha256:...",
    "context_hash": "sha256:..."
  },
  "idempotency_key": "<string>"
}
```

#### Response `200` (allowed)

```json
{
  "allowed": true,
  "decision_id": "dec_...",
  "proceed_token": "<jwt>",
  "expires_in_seconds": 45,
  "reason_code": "none",
  "policy": {
    "policy_id": "retry_friction_v1",
    "friction_required": false,
    "friction_price": "0 USDC"
  }
}
```

#### Response `402` (friction required)

Headers:

- `x402-price: <amount> USDC`
- `x402-recipient: 0x...`
- `x402-chain: BSC` (BNB Smart Chain, or `Any EVM`)

Body:

```json
{
  "allowed": false,
  "decision_id": "dec_...",
  "reason_code": "retry_friction",
  "policy": {
    "policy_id": "retry_friction_v1",
    "friction_required": true,
    "friction_price": "0.004 USDC",
    "explain": "attempt 7 in 30s window; free<=3"
  },
  "redeem": {
    "method": "POST",
    "url": "/v1/governor/redeem",
    "requires_header": "x402-tx-hash"
  }
}
```

---

### `POST /v1/governor/redeem`

Headers:

- `x402-tx-hash: 0x...`

Body:

```json
{
  "decision_id": "dec_..."
}
```

Response `200`:

```json
{
  "ok": true,
  "decision_id": "dec_...",
  "proceed_token": "<jwt>",
  "expires_in_seconds": 45,
  "receipt": {
    "tx_hash": "0x...",
    "paid_price": "0.004 USDC",
    "paid_chain": "bsc",
    "paid_at": "2026-01-16T12:34:56.000Z"
  }
}
```

---

### `GET /.well-known/jwks.json`

Response:

- Standard JWKS containing the active public key(s).

---

## `proceed_token` (JWT)

JWT header:

- `kid`: key id
- `alg`: as indicated by JWKS key type (implementation uses ES256)

Claims:

- `iss`: origin
- `aud`: `agent-cost-governor`
- `sub`: `actor.id`
- `jti`: `decision_id`
- `pol`: `policy_id`
- `act`: `action`
- `task`: `context.task_hash`
- `step`: `context.step_hash`
- `ctx`: `context.context_hash` (when provided)
- `iat`, `exp`

Runner must verify signature, `aud`, `exp`, and match `sub/jti/task/step`.

---

## Policy pack v1

### `retry_friction_v1`

- Free attempts per window: `free_attempts = 3`
- Price curve after free attempts:
  - `base_price = 0.001 USDC`
  - `growth = 1.8`
  - `max_price = 0.02 USDC`

If `attempt_in_window <= free_attempts` → `0`.
Else:

$$ price = \min(max\_price, base\_price \cdot growth^{(attempt\_in\_window - free\_attempts)}) $$

Reason code: `retry_friction`

### `low_confidence_loop_v1`

- Threshold: `threshold = 0.45`
- `base_price = 0.002 USDC`, `max_price = 0.05 USDC`, `mult = 2.0`

If `confidence >= threshold` → `0`.
Else:

$$ severity = \frac{threshold - confidence}{threshold} $$
$$ price = \min(max\_price, base\_price \cdot (1 + mult\cdot severity) \cdot \max(1, attempt\_in\_window - 1)) $$

Reason code: `low_confidence`

---

## Loop detection (smart pattern matching)

The Governor tracks request patterns and applies a 3-zone model:

| Zone | Count | Behavior |
|------|-------|----------|
| **safe** | ≤5 | Always allowed |
| **gray** | 6–10 | AI decides allow/block based on behavioral signals |
| **storm** | >10 | Hard block (429) |

### Behavioral signals (gray zone)

When a request enters the gray zone, the following signals are computed and passed to the AI decision engine:

| Signal | Field | Description |
|--------|-------|-------------|
| Timing regularity | `timing.interval_cv` | Coefficient of variation. <0.15 = bot-like. >0.4 = human-like. |
| Request rate | `timing.requests_per_sec` | Requests per second in the window. |
| Average interval | `timing.avg_interval_ms` | Average milliseconds between requests. |
| Window elapsed | `timing.window_elapsed_ms` | Total time since first request in window. |
| Cost accumulated | `cost_window_usd` | Total USD spent in this window. |
| Backoff detected | `backoff_detected` | `true` if intervals are consistently increasing (exponential backoff). Agents backing off get +3 threshold leniency. |
| Similar patterns | `similar_pattern_count` | Number of similar-but-not-identical patterns (e.g., page=1, page=2) grouped under the same action prefix. |

### Response headers

| Header | Description |
|--------|-------------|
| `X-Proceedgate-Zone` | `safe`, `gray`, or `storm` |
| `X-Proceedgate-Loop-Detected` | `true` when storm or AI-blocked |
| `X-Proceedgate-AI-Decided` | `true` if AI made the decision (vs. heuristic) |
| `X-Proceedgate-AI-Model` | Model used (e.g., `llama-3.1-8b-governance`) |

---

## Session-based budget tracking (v1.1)

Sessions provide cumulative budget tracking inspired by MPP voucher accumulation. Open a session with a budget cap, make governance checks within it, and close when done.

### `POST /v1/governor/session`

Request (JSON):

```json
{
  "agent_id": "scraper-bot",
  "budget_usd": "100.00",
  "duration_hours": 24
}
```

Response `201`:

```json
{
  "ok": true,
  "session_id": "ses_m1abc_x7k3f2",
  "budget_usd": "100.00",
  "expires_at": "2026-03-29T10:00:00.000Z"
}
```

### `GET /v1/governor/session/:sessionId`

Response `200`:

```json
{
  "ok": true,
  "session_id": "ses_m1abc_x7k3f2",
  "agent_id": "scraper-bot",
  "status": "open",
  "budget_usd": "100.00",
  "total_spent_usd": "12.350000",
  "remaining_usd": "87.650000",
  "request_count": 247,
  "expires_at": "2026-03-29T10:00:00.000Z",
  "created_at": "2026-03-28T10:00:00.000Z"
}
```

### `DELETE /v1/governor/session/:sessionId`

Response `200`:

```json
{
  "ok": true,
  "session_id": "ses_m1abc_x7k3f2",
  "final_spent_usd": "12.350000",
  "request_count": 247,
  "status": "closed"
}
```

### Session integration with `/v1/governor/check`

Pass `session_id` in the `context` field of a check request to track cumulative spend:

```json
{
  "context": {
    "session_id": "ses_m1abc_x7k3f2",
    "attempt_in_window": 1,
    "window_seconds": 60,
    "tool": "web_scrape"
  }
}
```

Session response headers on check:

| Header | Description |
|--------|-------------|
| `X-Proceedgate-Session-Id` | Session ID |
| `X-Proceedgate-Session-Spent` | Cumulative spend so far |
| `X-Proceedgate-Session-Remaining` | Budget remaining |

### Session errors

| Status | Error | Description |
|--------|-------|-------------|
| `402` | `session_budget_exceeded` | Cumulative spend has exceeded session budget |
| `404` | `session_not_found` | Session ID does not exist |
| `410` | `session_expired` | Session duration has elapsed |

---

## OpenAPI discovery (v1.1)

`GET /openapi.json` returns a standard OpenAPI 3.1 spec with custom extensions for machine-readable discovery:

### `x-service-info` (on `info`)

```json
{
  "realm": "cost-governance",
  "categories": ["ai-agents", "cost-control", "loop-detection", "budget-management"],
  "supportedIntents": ["check", "budget", "session"],
  "documentation": "https://proceedgate.dev",
  "protocols": ["x402", "mpp"]
}
```

### `x-cost-info` (on endpoints)

```json
{
  "creditCost": 1,
  "loopDetection": {
    "windowSeconds": 60,
    "safeThreshold": 5,
    "stormThreshold": 10
  },
  "sessionSupport": true
}
```

Free endpoints (billing, balance) have `"creditCost": 0`.

---

## MPP cost ledger (v1.1)

- `GET /costs/:agentId` — aggregate cost summary for an agent
- `GET /costs/:agentId/history` — paginated cost entries with timestamps

---

## Agent Identity (v1.2)

Every `actor.id` is a first-class identity. Profiles and reputation scores are persisted independently of the workspace.

### `GET /v1/agents`

Requires `x-admin-key` header.

Response `200`:

```json
{
  "ok": true,
  "agents": [
    {
      "id": "my-scraper-v2",
      "first_seen": "2026-03-01T10:00:00.000Z",
      "last_seen": "2026-04-01T09:30:00.000Z",
      "workspaces": ["ws_abc", "ws_xyz"],
      "reputation_score": 0.87
    }
  ],
  "cursor": null
}
```

### `GET /v1/agents/:agentId`

Requires `x-admin-key` header.

Response `200`:

```json
{
  "ok": true,
  "id": "my-scraper-v2",
  "first_seen": "2026-03-01T10:00:00.000Z",
  "last_seen": "2026-04-01T09:30:00.000Z",
  "workspaces": ["ws_abc", "ws_xyz"],
  "reputation_score": 0.87,
  "wallet": "0x..."
}
```

Optional `actor.wallet` in check request (ERC-8004 compatible):

```json
{
  "actor": {
    "id": "my-scraper-v2",
    "project": "ws_abc",
    "wallet": "0x..."
  }
}
```

---

## Supported payment chains

| Chain | Chain ID | Payment token | Notes |
|-------|----------|---------------|-------|
| **BSC** (BNB Smart Chain) | 56 | USDC (`0x8AC76a51...`) | Default |
| **opBNB** | 204 | USDT bridged from BSC (`0x9e5AAC1B...`) | Low-fee alternative |
| Any EVM | — | Configurable | Via `X402_CHAIN=Any EVM` env var |

Contract addresses:
- BSC Mainnet: [`0x161D749892a23AC8792eE7fD37f0F423E0b69C97`](https://bscscan.com/address/0x161D749892a23AC8792eE7fD37f0F423E0b69C97)
- opBNB Mainnet: [`0xAd8Da0Af368804e47bcdA8217b4e24F4cEb058dA`](https://opbnbscan.com/address/0xAd8Da0Af368804e47bcdA8217b4e24F4cEb058dA)
- On-chain audit trail (ProceedGateLogger, BSC): [`0xA2Fc77c4Db687cea2B30156f769167A10F02C83A`](https://bscscan.com/address/0xA2Fc77c4Db687cea2B30156f769167A10F02C83A)
