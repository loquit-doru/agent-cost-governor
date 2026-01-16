# Smoke test (local)

This validates the **end-to-end** v1 flow:

- `POST /v1/governor/check` returns `200` (allowed) or `402` (friction required)
- x402 headers are present on `402`
- `POST /v1/governor/redeem` returns a `proceed_token`
- runner verifies the JWT via `/.well-known/jwks.json` (ES256 v1)
- `decision_id` is time-sortable (ULID-like prefix)

## One command

From repo root:

- `npm run smoke`

What it does:

1. Builds worker + runner
2. Starts the worker locally (Wrangler on `http://127.0.0.1:8787`)
3. Waits for `GET /health`
4. Runs the runner against the worker using a stub tx hash (`--tx-hash 0xstub`)
5. Shuts down the worker

## Expected output

- Several `[OK] ... token=valid` lines
- Several `[402] ...` lines with x402 headers
- Several `[REDEEMED] ... token=valid` lines
- Summary like:
  - `friction_events=...`
  - `friction_paid_usdc~=...`

## Notes

- This uses `PAYMENT_VERIFY_MODE=stub`, so any `x402-tx-hash` is accepted.
- If port `8787` is already in use, stop the other process first.
