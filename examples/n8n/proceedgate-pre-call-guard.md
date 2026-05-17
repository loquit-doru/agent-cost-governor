# ProceedGate pre-call guard in n8n

Place ProceedGate **before** expensive or sensitive nodes. Production check endpoint: `POST https://governor.proceedgate.dev/v1/check`.

## Verified request body (`/v1/check`)

```json
{
  "agent_id": "n8n-lead-enrich",
  "task_hash": "sha256-of-stable-work-unit",
  "action": "tool_call"
}
```

Optional: `step_hash`, `session_id` (see [docs](https://proceedgate.dev/docs.html#check)).

## HTTP Request node

| Setting | Value |
|--------|--------|
| Method | POST |
| URL | `https://governor.proceedgate.dev/v1/check` |
| Authentication | Header: `Authorization: Bearer pg_ws_...` |
| Body | JSON (above) |

Use an expression for `task_hash` from the item (lead id, ticket id, URL hash).

## IF routing

```text
{{ $json.allowed === true }}     → continue to paid tools
{{ $json.allowed === false }}    → alert + stop (HTTP 429 from API)
```

Gray zone (`zone: "gray"`) may still return `allowed: true` on HTTP 200 — treat as warn/review in your flow if needed.

## Example flow

```text
Webhook → ProceedGate check → IF allowed → SerpAPI → Firecrawl → OpenAI → CRM/SAP
                              └ IF blocked → Slack / dead-letter
```

## Illustrative fields (not in API today)

These appear in marketing simulators and future n8n node ideas — **do not** send them expecting a response:

- `reason_code`: `repeated_task`, `budget_threshold`, `too_many_tool_calls`, `sensitive_endpoint_guard`
- `workflow_id`, `node_name`

## Related

- Site guide: `/n8n.html`
- Simulator: `/workflow-simulator.html`
- Pilot: `/pilot.html`
