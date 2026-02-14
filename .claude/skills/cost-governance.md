# Cost Governance Development Skill

## Purpose
Guide Claude through developing, testing, and operating the Agent Cost Governor system.

## Context
- **Project**: Agent Cost Governor - A payment/cost control system for AI agents
- **Stack**: TypeScript, Cloudflare Workers, Node.js SDK, MCP Server
- **Architecture**: Monorepo with worker, sdk-node, mcp-server, runner packages

## Packages Overview

| Package | Purpose |
|---------|---------|
| `worker/` | Cloudflare Worker API backend |
| `sdk-node/` | Node.js SDK for integration |
| `mcp-server/` | MCP server for AI tool access |
| `runner/` | CLI runner for tasks |

## Workflow Steps

### 1. Understand the Request
- Identify which package(s) are involved
- Check if it's API, SDK, MCP, or runner related
- Review existing patterns in that package

### 2. Implementation Guidelines
- Follow existing code patterns per package
- Use TypeScript strict mode
- Handle errors consistently across packages
- Maintain API compatibility

### 3. Testing Requirements
- Run `npm --workspaces run check` for all packages
- Test SDK changes against worker
- Use requests.http for API testing

### 4. Documentation
- Update package-specific README
- Update main README for major features
- Keep SPEC.md in sync with API changes

---

## Learnings Log

### 2026-01-22 — Functional Audit & Webhook Fix

#### ✅ What Worked Well

1. **Systematic Feature Audit**
   - Create mapping: Feature → Implementation → Actually Called
   - Grep for function definitions vs usages to find disconnected code

2. **Webhook Integration Pattern**
   ```typescript
   // In subscribe.ts - after subscription confirmed
   const webhookRes = await stub.fetch(`https://do.internal/workspaces/${workspaceId}/webhook`);
   if (webhookRes.ok) {
     const config = await webhookRes.json() as { ok: boolean; webhook_url?: string; webhook_secret?: string };
     if (config.ok && config.webhook_url) {
       webhookSubscriptionCreated(c.env, {
         webhookUrl: config.webhook_url,
         webhookSecret: config.webhook_secret,
         workspaceId,
         plan: invoice.plan,
         // ... etc
       }).catch(err => console.error('Webhook send failed:', err)); // fire-and-forget
     }
   }
   ```

3. **Probabilistic Maintenance**
   ```typescript
   // 1% chance per consume call - avoids overhead but eventually cleans up
   if (Math.random() < 0.01) {
     const sub = await this.state.storage.get<{ features?: { logRetentionDays?: number } }>(`sub:${workspaceId}`);
     const retentionDays = sub?.features?.logRetentionDays ?? 30;
     this.cleanupOldUsageLogs(workspaceId, retentionDays).catch(() => {});
   }
   ```

4. **Log Retention Cleanup**
   ```typescript
   private async cleanupOldUsageLogs(workspaceId: string, retentionDays: number): Promise<void> {
     const today = new Date();
     const keysToDelete: string[] = [];
     
     // Check beyond retention period up to max (90 days)
     for (let i = retentionDays + 1; i <= 90; i++) {
       const date = new Date(today);
       date.setDate(date.getDate() - i);
       const dateKey = date.toISOString().split('T')[0]!;
       keysToDelete.push(`usage:${workspaceId}:${dateKey}`);
     }
     
     if (keysToDelete.length > 0) {
       await this.state.storage.delete(keysToDelete);
     }
   }
   ```

#### ❌ What Failed/Struggled

1. **Webhooks Defined But Never Called**
   - `services/webhook.ts` had complete implementation
   - `subscribe.ts` never imported or called it
   - **Lesson**: Grep for imports, not just definitions

2. **Log Retention Feature Stored But Not Enforced**
   - `logRetentionDays` saved in subscription features
   - No cleanup code existed
   - **Lesson**: Feature flags need enforcement code

3. **File Path Confusion**
   - Searched `worker/src/webhook.ts` (wrong)
   - Actual path: `worker/src/services/webhook.ts`
   - **Lesson**: Use `file_search` with glob patterns first

#### 💡 Key Insights

1. **Code Exists ≠ Code Runs**
   - Fully implemented webhooks with signing, formatting, event types
   - Zero connection to actual events — completely dead code
   - **Audit checklist**: Definition → Import → Call site

2. **Probabilistic vs Guaranteed Cleanup**
   - 1% per request = ~100 requests to guarantee cleanup
   - Good for low-overhead eventual consistency
   - Consider DO alarms for guaranteed daily cleanup

3. **Rate Limiting Config**
   ```typescript
   // Billing endpoints: 30/min per IP
   const billingRateLimiter = createRateLimiter({
     limit: 30, windowMs: 60_000, keyPrefix: 'billing', useWorkspaceId: false
   });
   
   // Admin endpoints: 10/min per IP (stricter)
   const adminRateLimiter = createRateLimiter({
     limit: 10, windowMs: 60_000, keyPrefix: 'admin', useWorkspaceId: false
   });
   ```

---

### 2026-01-22 — Payment System & Customer Portal

#### ✅ What Worked Well

1. **Durable Object API Key Index**
   - Store `keyidx:{hash}` → `workspace_id` for O(1) lookups
   - Allows finding workspace by API key without iterating

2. **Subscription Metadata in DO**
   - Store `sub:{workspaceId}` with plan, credits, expiresAtMs, createdAtMs
   - Separate from balance for clean concerns

3. **Email Service Pattern**
   - Resend API is simple: POST to `api.resend.com/emails`
   - Graceful degradation: return `ok: true` if API key not configured
   - HTML templates inline in service file work well

4. **Renewal Flow Design**
   - Reuse invoice store for renewals with `workspaceId` pre-set
   - `add-credits` handler extends from current expiry or now if expired
   - Same confirm flow, different outcome (add credits vs create workspace)

5. **Webhook HMAC Signing**
   ```typescript
   const key = await crypto.subtle.importKey('raw', encoder.encode(secret), 
     { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
   const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
   return 'sha256=' + Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,'0')).join('');
   ```

#### ❌ What Failed/Struggled

1. **TypeScript Env Casting**
   - ❌ `(env as Record<string, string>).OPTIONAL_VAR` — fails type check
   - ✅ `(env as Env & { OPTIONAL_VAR?: string }).OPTIONAL_VAR` — works

2. **Site Not Updating**
   - Must deploy both worker AND site separately
   - `npx wrangler pages deploy . --project-name=proceedgate` for site

3. **Navigation Links**
   - Easy to forget adding new pages to nav menu
   - Check index.html nav after creating new pages

#### 💡 Key Insights

1. **Dashboard Auth Pattern**
   - Login with API key, store in localStorage
   - Each API call includes `Authorization: Bearer {apiKey}`
   - Workspace lookup via key hash index in DO

2. **URL Params for Mode Switching**
   - `?renew=true&workspace=xxx&current=plan` for renewal
   - `?upgrade=true` for upgrade flow
   - Parse with `new URLSearchParams(window.location.search)`

3. **Extending Subscriptions**
   - If current expiry > now: extend from expiry
   - If expired: extend from now
   - Add credits to existing balance

---

### Historical Learnings (from project history)

#### Core Protocol Understanding ✅
- **x402-style paywall**: HTTP 402 + retry with `x402-tx-hash` header
- **Decision flow**: Check → 402 (friction) → Pay → Redeem → proceed_token
- **Tokens signed with ES256 (P-256)** - frozen for v1 compatibility
- **JWKS exposed** at `/.well-known/jwks.json` for token verification

#### API Design Patterns ✅
- `POST /v1/governor/check` - Returns 200 (allowed) or 402 (friction required)
- `POST /v1/governor/redeem` - Exchange tx hash for proceed_token
- Response always includes `decision_id` for tracking
- `proceed_token` is a JWT with claims including `ctx` (context hash)

#### Context Hashing (Critical) ✅
- Canonical JSON: sort keys recursively, omit undefined, preserve arrays
- Hash format: `sha256:` + hex digest
- **Must copy** `context_hash` into token claim `ctx`
- Runner **should verify** context matches token

#### SDK Exports Pattern ✅
- Clean barrel exports from `src/index.ts`
- Separate concerns: `client.js`, `gate.js`, `jwks.js`, `hash.js`
- Export both functions AND types
- `WithRaw` variants for debugging (return raw response)

#### Things That Worked Well ✅
- **Idempotency keys**: Prevent duplicate charges
- **Policy-based friction**: `policy_id` drives pricing logic
- **Expires timestamps**: Tokens have TTL, prevents replay

#### Things That Failed/Were Tricky ❌
- **RPC receipt lookup**: Needed retry logic for Base RPC
- **Crypto versioning**: v1 frozen on ES256, don't change
- **Facilitator verification**: Use internal verifier in prod

---

## Code Snippets

### SDK Barrel Exports Pattern
```typescript
// src/index.ts
export { createProceedGateClient } from './client.js';
export { gateStep, gateStepWithRaw } from './gate.js';
export { verifyProceedToken } from './jwks.js';
export { sha256Hex, sha256CanonicalJsonHex } from './hash.js';
export { ProceedGateFrictionError } from './errors.js';

export type { 
  GateStepResult,
  ProceedGateClient,
  // ... etc
} from './types.js';
```

### Check Request Structure
```typescript
const checkRequest = {
  policy_id: "retry_friction_v1",
  action: "tool_call",
  actor: {
    id: "agent:demo-bot-1",
    project: "demo"
  },
  context: {
    attempt_in_window: 7,
    window_seconds: 30,
    confidence: 0.32,
    tool: "example_tool",
    task_hash: "sha256:...",
    context_hash: "sha256:..."
  },
  idempotency_key: "unique-key-123"
};
```

### Gate Step Helper
```typescript
import { gateStep } from '@proceedgate/node';

const result = await gateStep(client, {
  policyId: 'retry_friction_v1',
  action: 'tool_call',
  actor: { id: 'my-agent', project: 'prod' },
  context: { tool: 'web_search', attempt: 3 }
});

if (result.allowed) {
  // Execute with result.proceedToken
} else {
  // Handle friction: result.price, result.decisionId
}
```

### Canonical JSON for Context Hash
```typescript
import { sha256CanonicalJsonHex } from '@proceedgate/node';

const contextHash = 'sha256:' + await sha256CanonicalJsonHex(context);
```

### Email Service Pattern (Resend)
```typescript
async function sendEmail(env: Env, params: { to: string; subject: string; html: string }) {
  const envWithResend = env as Env & { RESEND_API_KEY?: string };
  const apiKey = envWithResend.RESEND_API_KEY;
  
  if (!apiKey) return { ok: true }; // Graceful degradation
  
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'noreply@proceedgate.dev', ...params }),
  });
  return { ok: res.ok };
}
```

### Durable Object Key Index Pattern
```typescript
// On workspace create - store index
await this.state.storage.put(`keyidx:${apiKeyHash}`, workspaceId);

// On lookup - find workspace by API key hash
const workspaceId = await this.state.storage.get<string>(`keyidx:${apiKeyHash}`);
```

### Subscription Extension Logic
```typescript
const nowMs = Date.now();
const monthsMs = months * 30 * 24 * 60 * 60 * 1000;

// Extend from current expiry if active, otherwise from now
const baseExpiryMs = (existingSub?.expiresAtMs && existingSub.expiresAtMs > nowMs) 
  ? existingSub.expiresAtMs 
  : nowMs;
const newExpiryMs = baseExpiryMs + monthsMs;
```

### Dashboard Auth Pattern (Frontend)
```javascript
const apiKey = localStorage.getItem('pg_dashboard_key');
const res = await fetch(`${API_BASE}/v1/billing/workspace`, {
  headers: { 'Authorization': `Bearer ${apiKey}` }
});
```

---

## References
- [SPEC.md](../../../SPEC.md) - API specification (frozen for v1)
- [worker/src/](../../../worker/src/) - Worker source code
- [worker/src/routes/subscribe.ts](../../../worker/src/routes/subscribe.ts) - Subscription endpoints
- [worker/src/services/email.ts](../../../worker/src/services/email.ts) - Email service
- [worker/src/services/webhook.ts](../../../worker/src/services/webhook.ts) - Webhook service
- [site/dashboard.html](../../../site/dashboard.html) - Customer dashboard
- [site/pay.html](../../../site/pay.html) - Payment page with renewal support
- [sdk-node/src/index.ts](../../../sdk-node/src/index.ts) - SDK exports
- [examples/sdk-demo.mjs](../../../examples/sdk-demo.mjs) - Working example
