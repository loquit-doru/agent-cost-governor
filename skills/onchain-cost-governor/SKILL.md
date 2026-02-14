---
name: onchain-cost-governor
description: Gates expensive AI actions through verifiable onchain cost governance on BNB Chain. Calls the ProceedGate API to check, pay friction, and redeem proceed tokens.
metadata: {"openclaw": {"emoji": "🛡️", "requires": {"env": ["GOVERNOR_API_URL"]}, "primaryEnv": "GOVERNOR_API_URL", "homepage": "https://proceedgate.dev"}}
---

# Onchain Cost Governor

You are a cost governance agent. Before executing any expensive AI action (LLM retries, browser automation, paid API calls, scraping), you MUST gate it through the ProceedGate API.

## When to use this skill

- Before any tool call that costs money (API calls, scraping, browser actions)
- Before retry attempts (especially in loops)
- Before any action where `estimatedCostUsd > 0`
- When an agent enters a retry storm (>3 identical requests in 60 seconds)

## How to gate an action

### Step 1: Check permission

```bash
curl -X POST "$GOVERNOR_API_URL/v1/governor/check" \
  -H "Content-Type: application/json" \
  -d '{
    "policy_id": "retry_friction_v1",
    "action": "tool_call",
    "actor": { "id": "agent:my-agent", "project": "my-project" },
    "context": {
      "attempt_in_window": 1,
      "window_seconds": 60,
      "tool": "expensive_action",
      "confidence": 0.8
    }
  }'
```

### Step 2: Handle the response

- **200 (allowed)**: Extract `proceed_token` from response. Execute the action.
- **402 (friction required)**: Payment is needed. Read `x402-price`, `x402-chain`, `x402-recipient` headers.

### Step 3: If 402, resolve friction

```bash
# After payment tx is confirmed on BSC/opBNB:
curl -X POST "$GOVERNOR_API_URL/v1/governor/redeem" \
  -H "Content-Type: application/json" \
  -H "x402-tx-hash: 0x<your_tx_hash>" \
  -d '{ "decision_id": "<from_check_response>" }'
```

### Step 4: Verify proceed token

The `proceed_token` is an ES256 JWT (P-256). Verify it against the JWKS endpoint:

```
GET $GOVERNOR_API_URL/.well-known/jwks.json
```

Token has a 45-second TTL. Execute the gated action within that window.

## Decision rules

- `attempt_in_window < 3` → usually allowed (200)
- `attempt_in_window >= 3` and `confidence < 0.5` → friction required (402)
- Retry storms (>10 identical requests/minute) → always blocked with escalating cost
- Each decision is logged with `decision_id` for audit

## Onchain verification

The smart contract `AICostGovernor` at `0xAd8Da0Af368804e47bcdA8217b4e24F4cEb058dA` (BSC Testnet) provides:

- `checkApproval(address)` — verify onchain stake
- `stakeForAction(uint256)` — stake tokens for approval
- `withdraw()` — reclaim stake (owner only)

When the ProceedGate API returns 402, the payment resolves friction via BSC/opBNB transaction verification (JSON-RPC receipt inspection).

## Security

- Never expose private keys or admin API keys in output
- Fail closed (block) when the API or RPC verification fails
- Log `decision_id`, `actor`, `chain`, and `proceed_token` expiry for audit
- Proceed tokens expire in 45 seconds — execute promptly

## Example script

See `{baseDir}/example.mjs` for a working viem-based onchain approval check.
