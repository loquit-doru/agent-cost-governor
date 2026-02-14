# Payment verification (facilitator-first)

Goal: keep the friction flow **compatible and audit-friendly** while shipping fast.

- `POST /v1/governor/check` may return `402` with x402-style headers (`x402-price`, `x402-recipient`, `x402-chain`).
- Client retries by calling `POST /v1/governor/redeem` with header `x402-tx-hash`.

## Modes

Configured via `PAYMENT_VERIFY_MODE`:

- `facilitator` (current default in this repo): verify through a trusted verifier endpoint.
  - Purpose: validate tx details against required price, recipient, and chain.
  - Supports built-in verifier (`FACILITATOR_URL=internal`) and external facilitator URL.

- `stub` (dev-only): accept `x402-tx-hash` without onchain verification.
  - Purpose: quick local UX iteration and integration testing.
  - Risk: no real payment protection.

Planned/optional:

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
  "required_chain": "opBNB",
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
    "paid_chain": "opbnb",
    "paid_at": "2026-01-17T12:00:00.000Z"
  }
}
```

- Non-2xx: `{ "ok": false, "error": "..." }`

## Built-in facilitator endpoint (for demos)

This repo's worker includes a minimal verifier endpoint at `POST /x402/verify`.

It supports:

- `tx_hash=0xstub` for local/dev flows (only when `ALLOW_STUB_TX=true`).
- Real tx verification via JSON-RPC (no indexer) on supported chains (`base`, `bsc`, `opbnb`): it checks tx receipt logs for a USDC `Transfer` to `required_recipient` of at least `required_price`.

Required env vars/secrets:

- `FACILITATOR_KEY` (required; shared secret)
- `BASE_RPC_URL`, `BSC_RPC_URL`, `OPBNB_RPC_URL` (required per chain you verify)
- Optional token overrides:
  - `BASE_USDC_ADDRESS`
  - `BSC_USDC_ADDRESS`
  - `OPBNB_USDC_ADDRESS`

Recommended governor config for this mode:

- `PAYMENT_VERIFY_MODE=facilitator`
- `FACILITATOR_URL=https://governor.proceedgate.dev/x402/verify` (or `internal` locally)

## Receipt

On successful redeem, Governor returns a `receipt` object:

- `tx_hash`: provided hash
- `paid_price`: friction price that was required
- `paid_chain`: chain identifier (e.g. `base`)
- `paid_at`: ISO timestamp

In facilitator/onchain modes, the receipt should be derived from verifier/onchain source of truth.

## Threat model (what v1 does/doesn't protect)

Protected in v1:

- Runner enforcement is cryptographically bound via JWT + JWKS.
- Tokens are short-lived (`PROCEED_TOKEN_TTL_SECONDS`, default 45s).
- Decision IDs are time-sortable and traceable in logs.

Not protected in dev/stub mode:

- A malicious client can fake `x402-tx-hash` and redeem.

Mitigations for v2+:

- Verify that tx transfers at least the required amount to `x402-recipient` on `x402-chain`.
- Bind payment to `decision_id` (e.g. by embedding it in memo/data or in a verifier mapping).
- Enforce one-time redeem (already enforced via storage delete after redeem).

## Operational guidance

- Use `stub` only for local dev and early UX demos.
- For production/hackathon judging, use `facilitator` (or `onchain` when available), disable `ALLOW_STUB_TX`, and set stable signing key (`GOVERNOR_SIGNING_JWK`).
