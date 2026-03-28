# ProceedGate Integration Guide

One HTTP call before each agent action. Detects retry storms, enforces budgets, returns a signed token.

**API base:** `https://governor.proceedgate.dev`
**Docs:** https://proceedgate.dev/docs.html
**Free API key:** https://proceedgate.dev/pay.html

---

## Core concept

```
agent action → POST /v1/check → { allowed, zone, proceed_token }
                                       ↓
                            allowed=true  → run the action
                            allowed=false → stop (loop detected or no credits)
```

`task_hash` is the key: hash the input/URL/prompt that identifies this task. Identical hashes in a 60-second window trigger loop detection after 10 repeats.

---

## curl

```bash
export PG_KEY=pg_ws_...

curl -X POST https://governor.proceedgate.dev/v1/check \
  -H "Authorization: Bearer $PG_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id":  "my-agent",
    "task_hash": "sha256-of-current-task",
    "action":    "tool_call"
  }'
```

**200 allowed:**
```json
{ "allowed": true, "zone": "safe", "iteration_count": 3, "proceed_token": "eyJ...", "credits_remaining": 1997 }
```

**429 blocked:**
```json
{ "allowed": false, "zone": "storm", "iteration_count": 11, "error": "loop_detected" }
```

---

## Node.js / TypeScript

```typescript
// pg.ts
const PG_KEY = process.env.PG_KEY!;

export async function pgCheck(
  agentId: string,
  taskHash: string,
  action: 'tool_call' | 'model_call' | 'retry' = 'tool_call'
) {
  const res = await fetch('https://governor.proceedgate.dev/v1/check', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${PG_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, task_hash: taskHash, action }),
  });
  const data = await res.json();
  if (res.status === 429) throw new Error(`loop_detected: ${data.reason}`);
  if (res.status === 402) throw new Error('insufficient_credits');
  if (!res.ok) throw new Error(`pg_error: ${data.error}`);
  return data; // { allowed, zone, proceed_token, credits_remaining }
}
```

### Apify actor

```typescript
import { createHash } from 'crypto';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

for (const url of urlQueue) {
  await pgCheck('apify-scraper', sha256(url), 'tool_call');
  const html = await fetch(url).then(r => r.text());
  await processPage(html);
}
```

### LangChain tool wrapper

```typescript
import { Tool } from 'langchain/tools';
import { pgCheck } from './pg';
import { createHash } from 'crypto';

class GatedSearchTool extends Tool {
  name = 'web_search';
  description = 'Search the web';

  async _call(query: string) {
    const hash = createHash('sha256').update(query).digest('hex');
    await pgCheck('langchain-agent', hash, 'tool_call');
    return await this.doSearch(query);
  }
}
```

### Multi-agent (shared workspace)

```typescript
// Each agent has its own agent_id — loop detection is per agent_id+task_hash combo.
// Budget is shared across the whole workspace.

await pgCheck('researcher', sha256(query),  'model_call');
await pgCheck('analyst',    sha256(data),   'model_call');
await pgCheck('writer',     sha256(draft),  'model_call');
```

### Batch check (multiple agents, one call)

```typescript
const res = await fetch('https://governor.proceedgate.dev/v1/check/batch', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${PG_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    checks: [
      { agent_id: 'researcher', task_hash: sha256(query), action: 'model_call' },
      { agent_id: 'scraper',    task_hash: sha256(url),   action: 'tool_call' },
    ],
  }),
});
const { results } = await res.json();
// results[0] = { allowed: true/false, zone, proceed_token? }
// results[1] = { allowed: true/false, zone, proceed_token? }
```

---

## Session-based budgets

Open a session with a budget cap, make checks within it, and close when done. Cumulative spend is tracked automatically.

```typescript
const PG_KEY = process.env.PG_KEY!;
const WORKSPACE = 'my-workspace-id';

// 1. Open a session ($50 budget, 24h duration)
const session = await fetch('https://governor.proceedgate.dev/v1/governor/session', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${PG_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ agent_id: 'my-scraper', budget_usd: '50.00', duration_hours: 24 }),
}).then(r => r.json());

const sessionId = session.session_id;

// 2. Make checks with session tracking
for (const url of urls) {
  const check = await fetch('https://governor.proceedgate.dev/v1/governor/check', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${PG_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      policy_id: 'retry_friction_v1',
      action: 'tool_call',
      actor: { id: 'my-scraper', project: WORKSPACE },
      context: {
        attempt_in_window: 1,
        window_seconds: 60,
        tool: 'web_scrape',
        session_id: sessionId,  // ← tracks cumulative spend
      },
    }),
  }).then(r => r.json());

  if (!check.allowed) {
    console.log('Budget exceeded or blocked:', check.reason_code);
    break;
  }
  await scrape(url);
}

// 3. Check session status
const status = await fetch(
  `https://governor.proceedgate.dev/v1/governor/session/${sessionId}`,
  { headers: { 'Authorization': `Bearer ${PG_KEY}` } },
).then(r => r.json());
console.log(`Spent: $${status.total_spent_usd} / $${status.budget_usd}`);

// 4. Close session
await fetch(
  `https://governor.proceedgate.dev/v1/governor/session/${sessionId}`,
  { method: 'DELETE', headers: { 'Authorization': `Bearer ${PG_KEY}` } },
);
```

---

## Python

```python
# pg.py
import os, hashlib, httpx

PG_KEY = os.environ["PG_KEY"]

def pg_check(agent_id: str, task_hash: str, action: str = "tool_call") -> dict:
    res = httpx.post(
        "https://governor.proceedgate.dev/v1/check",
        headers={"Authorization": f"Bearer {PG_KEY}", "Content-Type": "application/json"},
        json={"agent_id": agent_id, "task_hash": task_hash, "action": action},
        timeout=10,
    )
    data = res.json()
    if res.status_code == 429:
        raise RuntimeError(f"loop_detected: {data.get('reason')}")
    if res.status_code == 402:
        raise RuntimeError("insufficient_credits")
    res.raise_for_status()
    return data
```

### Scrapy middleware

```python
# middlewares.py
import hashlib
from pg import pg_check

class ProceedGateMiddleware:
    def process_request(self, request, spider):
        task_hash = hashlib.sha256(request.url.encode()).hexdigest()
        try:
            pg_check("scrapy-spider", task_hash, "tool_call")
        except RuntimeError as e:
            spider.logger.warning(f"ProceedGate blocked: {e}")
            raise IgnoreRequest()
```

### CrewAI agent

```python
from crewai import Agent, Task, Crew
from pg import pg_check
import hashlib

def sha256(s): return hashlib.sha256(s.encode()).hexdigest()

class GatedAgent(Agent):
    def execute_task(self, task, context=None, **kwargs):
        pg_check(self.role, sha256(task.description), "model_call")
        return super().execute_task(task, context, **kwargs)
```

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `PG_KEY` | Your workspace API key (`pg_ws_...`) |

Get your key at https://proceedgate.dev/pay.html — 2,000 free checks/month.

---

## Error handling

| Status | Error | Action |
|--------|-------|--------|
| `429`  | `loop_detected` | Stop retrying. Use a different `task_hash` for genuinely new work, or wait 60s. |
| `402`  | `insufficient_credits` | Top up at proceedgate.dev/pay.html |
| `401`  | `missing_authorization` | Check `PG_KEY` env var is set |
| `5xx`  | server error | Retry with exponential backoff. If critical, use `fail_open` mode. |

### Session errors

| Status | Error | Action |
|--------|-------|--------|
| `402`  | `session_budget_exceeded` | Session budget is exhausted. Close or create a new session. |
| `404`  | `session_not_found` | Session ID doesn't exist. Create a new session. |
| `410`  | `session_expired` | Session duration has elapsed. Create a new session. |

### Fail-open pattern (never block on ProceedGate downtime)

```typescript
async function pgCheckSafe(agentId: string, taskHash: string) {
  try {
    return await pgCheck(agentId, taskHash);
  } catch (err) {
    if (err.message.startsWith('loop_detected') || err.message.startsWith('insufficient_credits')) {
      throw err; // Real blocks — re-throw
    }
    console.warn('ProceedGate unreachable, failing open:', err.message);
    return { allowed: true, zone: 'unknown', proceed_token: null }; // Fail open on network errors
  }
}
```

---

## Verify the proceed_token (optional)

The `proceed_token` is a signed ES256 JWT. Verify it downstream to prove governance happened:

```typescript
import * as jose from 'jose';

const JWKS = jose.createRemoteJWKSet(
  new URL('https://governor.proceedgate.dev/.well-known/jwks.json')
);

async function verifyToken(token: string) {
  const { payload } = await jose.jwtVerify(token, JWKS, {
    issuer:   'https://governor.proceedgate.dev',
    audience: 'agent-cost-governor',
  });
  return payload; // { sub: agentId, act: action, task: taskHash, exp, ... }
}
```

---

## OpenAPI discovery

AI agents can auto-discover ProceedGate capabilities:

```typescript
const spec = await fetch('https://governor.proceedgate.dev/openapi.json').then(r => r.json());

// Service info
console.log(spec.info['x-service-info']);
// { realm: 'cost-governance', protocols: ['x402', 'mpp'], ... }

// Per-endpoint cost info
const checkEndpoint = spec.paths['/v1/governor/check'].post;
console.log(checkEndpoint['x-cost-info']);
// { creditCost: 1, loopDetection: { windowSeconds: 60, ... }, sessionSupport: true }
```

---

## Payments on BNB Chain (BSC)

All payments are processed on **BNB Smart Chain** (chain ID 56) using USDC:
- USDC contract: `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`
- Protocol: x402 (HTTP-native payment settlement)
- Friction payments resolve via `POST /v1/governor/redeem` with `x402-tx-hash` header
