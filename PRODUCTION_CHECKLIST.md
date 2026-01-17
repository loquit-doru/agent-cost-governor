# Production checklist (ProceedGate Governor)

## 1) Domain + routing

- Site: `proceedgate.dev` (Cloudflare Pages)
- API (Governor Worker): `governor.proceedgate.dev/*` (Cloudflare Worker route)

## 2) Secrets (must-have)

- `GOVERNOR_SIGNING_JWK` (secret): stable ES256 (P-256) private JWK
  - Goal: JWKS stays stable across deploys so existing verifiers keep working.
- `FACILITATOR_KEY` (secret): shared secret used by governor to call the verifier

## 3) Payment verification (switch off stub)

- Set `PAYMENT_VERIFY_MODE=facilitator`
- Set `FACILITATOR_URL=https://governor.proceedgate.dev/x402/verify`
- For real tx verification on Base (no indexer): set `BASE_RPC_URL` (secret)
- Optional: set `BASE_USDC_ADDRESS` if you need a non-default USDC contract

Notes:
- Local/dev shortcut: `tx_hash=0xstub` is accepted by the built-in facilitator.
- Spec/details: see PAYMENT_VERIFICATION.md

## 4) Pricing + recipient

- Set these to real values in Worker vars:
  - `X402_RECIPIENT` (your wallet)
  - `X402_CHAIN` (e.g. `Base`)
  - `X402_PRICE_DEFAULT` (e.g. `0.004 USDC`)

## 5) Observability

- Tail logs:
  - `npm run tail:prod`
- Metrics: Analytics Engine dataset `proceedgate_metrics`
  - Query examples in OPERATIONS.md

## 6) Rollout sanity

- `GET /health` returns 200
- `GET /.well-known/jwks.json` returns a stable `kid`
- `POST /v1/governor/check` returns 200 for allowed and 402 + x402 headers for friction
- `POST /v1/governor/redeem` succeeds only with a verifiable tx hash
