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
