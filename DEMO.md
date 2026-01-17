# ProceedGate demo: proving it stops runaway agents

This is a deterministic demo pack you can run locally or against prod.

Goal: prove three claims:

1) **Runaway patterns exist** (retries / tool-call storms / browsing storms).
2) **ProceedGate stops them** via a hard `402` (friction required).
3) **ProceedGate is auditable** (logs + optional metrics show what happened).

---

## What a "runaway" looks like (operational definition)

In practice, a runaway agent is any of:

- **Retry loop**: same step repeated N times in a short window (e.g. `attempt_in_window > 3` in `30s`).
- **Tool-call storm**: unusually high tool-call rate per actor/project.
- **Browsing storm**: repeated browser actions in a short window.

ProceedGate doesn’t need to "understand" the model — you supply a minimal context:
- `attempt_in_window` + `window_seconds`
- `action` and optional `tool`
- stable hashes (`task_hash`, `step_hash`, `context_hash`) for binding/audit

---

## Demo scenario (deterministic)

We use [examples/storm-task.json](examples/storm-task.json).

It intentionally asks the runner to attempt:
- 25 tool calls in 30 seconds
- 40 "browser" tool calls in 60 seconds
- 8 low-confidence model calls

With the default `retry_friction_v1` policy, attempts 1–3 are free and attempt 4 triggers friction.

---

## Run locally (most convincing)

### 1) Prove hard stop (non-interactive)

This is the key proof: the runner hits `402` and exits immediately (no prompt).

```bash
npm run demo:storm:block
```

Expected:
- First 3 attempts: `[OK] ... token=valid`
- Attempt 4: `[402] ... reason=retry_friction` + printed `x402-*` headers
- Then: `[BLOCKED] hard gate engaged (abort-on-402)`

### 2) Prove resume after friction (tx hash)

Non-interactive demo mode:

```bash
npm run demo:storm:redeem
```

Expected:
- Multiple 402 events
- Multiple `[REDEEMED]` events
- End summary prints `friction_events=...`

---

## Run against prod (buyer-friendly)

This proves the same behavior on the hosted service.

```bash
npm run build
node runner/dist/cli.js run examples/storm-task.json --governor https://governor.proceedgate.dev --tx-hash 0xstub
```

> Note: In real payment verification mode you’ll use a real tx hash.

---

## Auditability proof

### Logs

- Local: logs show `governor_check_ok`, `governor_check_402`, `governor_redeem_*`
- Prod tail:

```bash
npm run tail:prod
```

### Metrics (optional, strongest for charts)

If Analytics Engine is enabled and the `METRICS` binding is configured:
- You get counters and latency for `check_ok`, `check_402`, `redeem_ok`, `redeem_fail`.
- See [OPERATIONS.md](OPERATIONS.md) for example queries.

---

## Deliverables you can capture (for a deck)

- Screenshot of runner output: first `[402]` on attempt 4
- Screenshot of Worker logs: `governor_check_402` with `policy_id`, `action`, `reason_code`
- Metrics chart: `check_402` count over time for a known runaway test
