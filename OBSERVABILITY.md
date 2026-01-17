# Observability (v1)

v1 focuses on **audit-friendly** and **low-PII** visibility.

## Structured logs

The Worker emits one JSON log line per significant event.

Common fields:

- `ts`: ISO timestamp
- `event`: event name
- `decision_id`: decision id (ULID-like)
- `policy_id`, `action`
- `reason_code`
- `actor_key`: stable hash prefix of `actor.id` (not the raw id)
- `task_hash`, `step_hash`, `context_hash` (already hashed values)
- `friction_price`, `chain`, `recipient` when applicable

Events:

- `governor_check_ok`
- `governor_check_402`
- `governor_redeem_ok`
- `governor_redeem_fail`

## Response headers (optional UX/debug)

The Worker adds lightweight headers that make it easy to debug flows without parsing JSON:

- `X-Proceedgate-Decision-Id`
- `X-Proceedgate-Policy-Id`
- `X-Proceedgate-Reason`
- `X-Proceedgate-Friction-Price` (on 402)

These are safe to surface in developer tooling and logs.
