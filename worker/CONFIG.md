# Worker Configuration Reference

This document describes all environment variables and secrets that can be used to configure the ProceedGate Governor Worker.

## Core Settings

### JWT & Token

| Variable | Default | Description |
|----------|---------|-------------|
| `GOVERNOR_SIGNING_JWK` | *none* | **Secret**. ES256 (P-256) private JWK JSON for signing tokens. Required in production. |
| `PROCEED_TOKEN_TTL_SECONDS` | `45` | Token validity period (10-300 seconds) |

### x402 Payment Headers

| Variable | Default | Description |
|----------|---------|-------------|
| `X402_PRICE_DEFAULT` | `0.004 USDC` | Default friction price |
| `X402_CHAIN` | `Base` | Blockchain for payments |
| `X402_RECIPIENT` | `0x0...0` | Payment recipient address |

## Pricing Configuration

### Retry Friction Policy (`retry_friction_v1`)

| Variable | Default | Description |
|----------|---------|-------------|
| `PRICING_FREE_ATTEMPTS` | `3` | Number of free attempts before friction applies |
| `PRICING_BASE` | `0.001` | Base price in USDC |
| `PRICING_GROWTH` | `1.8` | Exponential growth factor per attempt |
| `PRICING_MAX` | `0.02` | Maximum price cap in USDC |

**Formula**: `price = base * growth^(attempt - freeAttempts)`, capped at `max`

### Low Confidence Policy (`low_confidence_loop_v1`)

| Variable | Default | Description |
|----------|---------|-------------|
| `PRICING_CONFIDENCE_THRESHOLD` | `0.45` | Confidence below this triggers friction |
| `PRICING_CONFIDENCE_BASE` | `0.002` | Base price in USDC |
| `PRICING_CONFIDENCE_MAX` | `0.05` | Maximum price cap in USDC |
| `PRICING_CONFIDENCE_MULT` | `2.0` | Severity multiplier |

**Formula**: `price = base * (1 + mult * severity) * attemptsFactor`, capped at `max`

## Authentication

| Variable | Default | Description |
|----------|---------|-------------|
| `API_AUTH_MODE` | `off` | Auth mode: `off`, `shared`, or `workspace` |
| `API_SHARED_KEY` | *none* | **Secret**. Shared API key (when mode=`shared`) |
| `API_ADMIN_KEY` | *none* | **Secret**. Admin key for workspace management |

### Auth Modes

- **`off`**: No authentication required (dev only)
- **`shared`**: Single shared API key for all requests
- **`workspace`**: Per-workspace API keys with billing integration

## Billing

| Variable | Default | Description |
|----------|---------|-------------|
| `BILLING_MODE` | `off` | Billing mode: `off` or `credits` |
| `BILLING_CREDIT_COST_MICROUSDC` | `10` | Cost per credit in microUSDC (1e-6 USDC) |
| `BILLING_CHAIN` | *from X402_CHAIN* | Blockchain for billing payments |
| `BILLING_RECIPIENT` | *from X402_RECIPIENT* | Billing payment recipient |

## Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_CHECK_PER_MINUTE` | `100` | Max `/check` requests per IP per minute |
| `RATE_LIMIT_BILLING_PER_MINUTE` | `20` | Max billing requests per workspace per minute |

Rate limit headers returned:
- `X-RateLimit-Limit`: Configured limit
- `X-RateLimit-Remaining`: Remaining requests
- `X-RateLimit-Reset`: Seconds until reset
- `Retry-After`: (on 429) Seconds to wait

## CORS

| Variable | Default | Description |
|----------|---------|-------------|
| `CORS_ALLOWED_ORIGINS` | *see below* | Comma-separated additional allowed origins |

**Default allowed origins:**
- `https://proceedgate.dev`
- `https://www.proceedgate.dev`
- `https://governor.proceedgate.dev`
- `http://localhost:8787`
- `http://localhost:8788`
- `http://127.0.0.1:8787`
- `http://127.0.0.1:8788`

**Security note**: No wildcard subdomain matching. Origins must be explicitly listed.

## Payment Verification

| Variable | Default | Description |
|----------|---------|-------------|
| `PAYMENT_VERIFY_MODE` | `stub` | Verification mode: `stub`, `facilitator`, `onchain` |
| `FACILITATOR_URL` | *none* | External facilitator service URL |
| `FACILITATOR_KEY` | *none* | **Secret**. Facilitator service API key |
| `BASE_RPC_URL` | *none* | Base chain RPC URL for onchain verification |
| `BASE_USDC_ADDRESS` | *Circle USDC* | USDC contract address on Base |
| `ALLOW_STUB_TX` | `false` | **Dev only**. Allow `0xstub*` tx hashes |

## Durable Objects

These are configured in `wrangler.toml`:

```toml
[durable_objects]
bindings = [
  { name = "DECISIONS", class_name = "DecisionStoreDO" },
  { name = "BILLING", class_name = "BillingStoreDO" }
]
```

## Analytics

| Variable | Default | Description |
|----------|---------|-------------|
| `METRICS` | *none* | Cloudflare Analytics Engine dataset binding |

## Production Checklist

1. ✅ Set `GOVERNOR_SIGNING_JWK` as a Wrangler secret
2. ✅ Set `API_AUTH_MODE=workspace` and `API_ADMIN_KEY`
3. ✅ Set `BILLING_MODE=credits` if using prepaid billing
4. ✅ Configure `BASE_RPC_URL` for onchain payment verification
5. ✅ Set proper `X402_RECIPIENT` address
6. ✅ Review rate limits for your traffic patterns
7. ✅ Add custom origins to `CORS_ALLOWED_ORIGINS` if needed
8. ⛔ Ensure `ALLOW_STUB_TX` is NOT set or is `false`

## Example wrangler.toml

```toml
[env.prod]
name = "proceedgate-governor"
main = "src/index.ts"

[env.prod.vars]
API_AUTH_MODE = "workspace"
BILLING_MODE = "credits"
BILLING_CREDIT_COST_MICROUSDC = "10"
X402_CHAIN = "Base"
X402_RECIPIENT = "0x..."
PRICING_FREE_ATTEMPTS = "3"
RATE_LIMIT_CHECK_PER_MINUTE = "100"
```
