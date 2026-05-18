# Native n8n guard vs ProceedGate-powered guard

Two-workflow pattern: a **shared Guard Sub-workflow** called from a **Main AI Agent** flow via **Call n8n Workflow Tool**. n8n handles orchestration; ProceedGate holds shared policy, loop state, credits, and audit across workflows.

> **Disclaimer:** Import the JSON exports below, then adapt credentials and workflow IDs. Test in your n8n instance before production.

## Source workflow files

| Workflow | File | Status in repo |
|----------|------|----------------|
| Guard Sub-workflow (native) | `examples/n8n/guard-sub-workflow.json` | Present |
| ProceedGate Guard Sub-workflow | `examples/n8n/proceedgate-guard-sub-workflow.json` | Present |
| Main AI Agent Flow | `examples/n8n/main-ai-agent-flow.json` | Present |

Re-import in n8n and follow the steps below.

---

## ProceedGate-powered importable workflow

Import [`examples/n8n/proceedgate-guard-sub-workflow.json`](./proceedgate-guard-sub-workflow.json) when you want **ProceedGate** (`POST /v1/check`) to make the allow/deny decision instead of a native Code node.

1. Import [`guard-sub-workflow.json`](./guard-sub-workflow.json) first to see the native pattern (Execute Workflow Trigger → mock budget → IF → costly tool / deny).
2. Import [`proceedgate-guard-sub-workflow.json`](./proceedgate-guard-sub-workflow.json) when you want `/v1/check` to decide: same orchestration shape, but **ProceedGate Check** replaces **Evaluate Budget Limits**.
3. In the **ProceedGate Check** HTTP Request node, replace `REPLACE_WITH_PG_WORKSPACE_KEY` with your workspace API key (`pg_ws_...`).
4. **n8n** still handles orchestration, sub-workflow calls, IF branching, and the **Deny Message** text returned to the parent agent.
5. **ProceedGate** holds the shared guard decision (loop detection, credits, `allowed`, audit) across workflows and agents.

Wire your main flow’s **Call n8n Workflow Tool** to this sub-workflow the same way as the native guard.

---

## Architecture

```text
Main AI Agent Flow
  → AI Agent (tools)
  → Call n8n Workflow Tool  ──calls──▶  Guard Sub-workflow
                                              → [native: Evaluate Budget Limits]
                                              → [ProceedGate: HTTP Request POST /v1/check]
                                              → IF on allowed / zone
                                              → Costly API Exec (SerpAPI, HTTP, …)
```

| Layer | Responsibility |
|-------|----------------|
| **n8n** | Triggers, AI agent, sub-workflow calls, branching, human review nodes, tool execution |
| **ProceedGate** | Loop detection, credits, `allowed` / `zone`, `proceed_token`, workspace audit |

---

## Workflow 1: Guard Sub-workflow (native)

Typical native pattern (from n8n AI-agent guard examples):

1. **Execute Workflow Trigger** — receives inputs from the parent (e.g. `query`, `agent_id`, spend counters).
2. **Evaluate Budget Limits** (Code node) — mock or custom logic: read/write Redis/Postgres, compare spend vs cap, return `allowed` / `denied`.
3. **IF** — branch on mock result.
4. **Costly API Exec** — HTTP Request / SerpAPI / similar (only on allow).
5. **Respond to Workflow** — return tool output or denial message to the parent.

Native downsides you own: policy code, state store, rotation, cross-workflow consistency, audit exports.

---

## Workflow 2: Main AI Agent Flow

1. **Chat Trigger** or **Webhook** — user message / API payload.
2. **AI Agent** — model + tools.
3. **Call n8n Workflow Tool** — points at the Guard Sub-workflow; passes through fields needed for `task_hash` (e.g. `query`, lead id).
4. Agent uses sub-workflow output as the guarded tool result.

The main flow should **not** duplicate budget logic — it delegates to the sub-workflow.

---

## Import instructions (step by step)

1. In n8n: **Workflows → Import from File** (or paste JSON).
2. Import **Guard Sub-workflow** first. Note the workflow ID (Settings → URL or workflow list).
3. Import **Main AI Agent Flow**.
4. Open the **Call n8n Workflow Tool** node in the main flow; set **Workflow** to the Guard Sub-workflow.
5. Map inputs, e.g. `query` → sub-workflow trigger field used in `task_hash` expressions.
6. Activate both workflows (sub-workflow can stay inactive if only called via tool — follow your n8n version’s rules for sub-workflow execution).
7. Run a test chat; confirm the guard runs before the costly HTTP node.

---

## Replace “Evaluate Budget Limits” with ProceedGate

### Remove or bypass

- Disable or delete the native **Evaluate Budget Limits** Code node (mock budget / Redis counters).

### Add HTTP Request node

| Setting | Value |
|---------|--------|
| Method | `POST` |
| URL | `https://governor.proceedgate.dev/v1/check` |
| Authentication | Header `Authorization: Bearer pg_ws_...` |
| Body | JSON (see below) |
| Options | **Never Error** on (`options.response.response.neverError: true`) — ProceedGate returns HTTP 429 with `{ allowed: false, ... }` on loop blocks; without this, n8n may error before the IF node runs |

**Verified body fields** (`easyCheckSchema` in `worker/src/routes/check.ts`): `agent_id`, `task_hash`, optional `action`, optional `step_hash`.

`action` must be one of: `tool_call`, `model_call`, `retry`, `override`, `plan_execute` (default `tool_call`). Custom strings such as `costly_tool_lookup` are **rejected** with `400 invalid_request`.

### Example payload (ProceedGate)

Use `step_hash` to name the guarded step; use `tool_call` for external paid tools:

```json
{
  "agent_id": "n8n-main-agent",
  "task_hash": "={{ $json.query || 'default-search' }}",
  "action": "tool_call",
  "step_hash": "guarded_costly_tool"
}
```

Stable `task_hash` per unit of work (same search / lead / ticket) is required for loop detection. Vary it when the work unit changes.

### HTTP 429 and Never Error

When loop detection blocks a call, `/v1/check` returns **HTTP 429** with a JSON body that still includes `allowed: false` (verified in `worker/src/routes/check.ts`). By default, n8n’s HTTP Request node treats non-2xx as a failure and can stop the workflow before **Allowed?** runs.

In `proceedgate-guard-sub-workflow.json`, **ProceedGate Check** sets `options.response.response.neverError: true` so 200 and 429 both emit items. Route on `$json.allowed` — do **not** rely on node failure for deny.

### Wire IF after HTTP Request

Use the **parsed JSON body** from the HTTP Request node (with Never Error, body fields are at the item root — not under `$json.body` unless you also enable full response):

| Condition | Route |
|-----------|--------|
| `{{ $json.allowed === true }}` | **Costly API Exec** (continue guarded tool) |
| `{{ $json.allowed === false }}` | Deny branch (see below) |
| `{{ $json.zone === 'gray' }}` | Optional human review **or** continue with logging (gray may still return `allowed: true` on HTTP 200 after AI review) |

**Deny branch (allowed === false):** **Respond to Workflow** (or Set) with:

```text
Tool execution denied: budget or repetition policy hit.
```

Map API `reason` / `hint` into Slack or internal logs if needed (`loop_detected`, `insufficient_credits`, etc.).

### Zone reference (API)

| `zone` | Meaning | Suggested n8n handling |
|--------|---------|-------------------------|
| `safe` | Normal | Proceed to costly tool |
| `gray` | Elevated repetition; may be AI-reviewed | Warn + optional Human Review, or proceed with audit log |
| `storm` | Hard loop block (HTTP 429) | Deny message; skip costly tool |

Production mapping to allow / warn / block:

- **allow** — `allowed === true` and `zone` is `safe` or approved `gray`
- **warn** — `zone === 'gray'` while still allowed
- **block** — `allowed === false` (429 loop, gray AI block, or 402 credits)

---

## ProceedGate-powered Guard Sub-workflow (target layout)

```text
Execute Workflow Trigger
  → HTTP Request (POST /v1/check)
  → IF allowed
       → true: Costly API Exec → Respond to Workflow (success)
       → false: Respond to Workflow ("Tool execution denied: …")
  → (optional) IF zone === 'gray' → Human Review → merge back
```

---

## Main flow (unchanged orchestration)

Keep **Call n8n Workflow Tool** pointing at this sub-workflow. Only the guard internals switch from Code/DB to ProceedGate.

---

## How to verify

1. **Docs:** [proceedgate.dev/docs.html#check](https://proceedgate.dev/docs.html#check)
2. **curl** with the same four fields and a workspace API key.
3. **Dashboard:** decisions after checks from your n8n `agent_id`.
4. Repeat the same `task_hash` quickly in n8n to see `zone` move toward `gray` / `storm` (simulated policy in [workflow-simulator.html](../../site/workflow-simulator.html) is illustrative only).

---

## Related

- [proceedgate-pre-call-guard.md](./proceedgate-pre-call-guard.md) — single-workflow HTTP + IF pattern
- [n8n.html](../../site/n8n.html) — site guide
- Repo: `examples/n8n/` — importable JSON exports listed above
