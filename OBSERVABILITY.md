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

## Metrics (optional)

The Worker has optional support for Cloudflare Analytics Engine metrics. This is **not enabled by default** because accounts must explicitly enable Analytics Engine.

To enable:

- Enable Analytics Engine in the Cloudflare dashboard:
	- https://dash.cloudflare.com/ (Workers → Analytics Engine)
- Add an Analytics Engine dataset binding named `METRICS` in `worker/wrangler.toml` (both default env and `env.prod`).

When enabled, the Worker emits basic counters and latency datapoints.

- Suggested dataset name: `proceedgate_metrics`
- Indexes (strings):
	- `event`: `check_ok` | `check_402` | `check_invalid` | `redeem_ok` | `redeem_fail`
	- `policy_id`: policy id or `unknown`
	- `action`: action or `unknown`
	- `detail`: reason code (check) or error code (redeem)
- Doubles (numbers):
	- `[0] = 1` (counter)
	- `[1] = latency_ms`
