# Payment verification (v1 stub, v2+ real)

v1 goal: keep the friction flow **compatible and audit-friendly** while shipping fast.

- `POST /v1/governor/check` may return `402` with x402-style headers (`x402-price`, `x402-recipient`, `x402-chain`).
- Client retries by calling `POST /v1/governor/redeem` with header `x402-tx-hash`.

## Modes

Configured via `PAYMENT_VERIFY_MODE`:

- `stub` (v1 default): accept any `x402-tx-hash`.
  - Purpose: validate product/UX/integration and enforcement loop.
  - Risk: no real payment protection.

Planned (v2+):

- `facilitator`: call a trusted verifier service that validates tx and returns canonical receipt data.
- `onchain`: directly verify onchain for the configured chain (heavier, more moving parts).

## Facilitator contract (minimal)

Governor (worker) calls a verifier service:

- `POST /x402/verify`
- Header: `Authorization: Bearer <FACILITATOR_KEY>`
- Body:

```json
{
  "tx_hash": "0x...",
  "decision_id": "dec_...",
  "required_price": "0.0018 USDC",
  "required_chain": "Base",
  "required_recipient": "0x..."
}
```

Response:

- `200`:

```json
{
  "ok": true,
  "receipt": {
    "tx_hash": "0x...",
    "paid_price": "0.002 USDC",
    "paid_chain": "base",
    "paid_at": "2026-01-17T12:00:00.000Z"
  }
}
```

- Non-2xx: `{ "ok": false, "error": "..." }`

## Built-in facilitator endpoint (for demos)

This repo's worker includes a minimal verifier endpoint at `POST /x402/verify`.

It supports:

- `tx_hash=0xstub` for local/dev flows.
- Real Base tx verification via JSON-RPC (no indexer): it checks the tx receipt logs for a USDC `Transfer` to `required_recipient` of at least `required_price`.

Required env vars/secrets:

- `FACILITATOR_KEY` (required; shared secret)
- `BASE_RPC_URL` (required for real tx verification)
- Optional: `BASE_USDC_ADDRESS` (defaults to Base USDC)

Recommended governor config for this mode:

- `PAYMENT_VERIFY_MODE=facilitator`
- `FACILITATOR_URL=https://governor.proceedgate.dev/x402/verify` (or `http://127.0.0.1:8787/x402/verify` locally)

## Receipt

On successful redeem, Governor returns a `receipt` object:

- `tx_hash`: provided hash
- `paid_price`: friction price that was required
- `paid_chain`: chain identifier (e.g. `base`)
- `paid_at`: ISO timestamp

In v2+ verification modes, the receipt should be derived from the verifier/onchain source of truth.

## Threat model (what v1 does/doesn't protect)

Protected in v1:

- Runner enforcement is cryptographically bound via JWT + JWKS.
- Tokens are short-lived (`PROCEED_TOKEN_TTL_SECONDS`, default 45s).
- Decision IDs are time-sortable and traceable in logs.

Not protected in v1 (by design):

- A malicious client can fake `x402-tx-hash` and redeem (because `stub`).

Mitigations for v2+:

- Verify that tx transfers at least the required amount to `x402-recipient` on `x402-chain`.
- Bind payment to `decision_id` (e.g. by embedding it in memo/data or in a verifier mapping).
- Enforce one-time redeem (already enforced via storage delete after redeem).

## Operational guidance

- Use `stub` only for local dev and early buyer demos.
- For any production use, switch to `facilitator`/`onchain` and set a stable signing key (`GOVERNOR_SIGNING_JWK`).
