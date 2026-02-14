# General Development Patterns

## Purpose
Universal patterns and lessons learned that apply across all projects.

---

## Code Audit Patterns

### Feature → Implementation Audit
When auditing if features actually work:

| Step | What to Check |
|------|---------------|
| 1. Definition | Does the code exist? |
| 2. Import | Is it imported where needed? |
| 3. Call Site | Is it actually called? |
| 4. Integration | Is it connected to the event/trigger? |

**Lesson**: Code can be fully implemented but completely disconnected from the system.

### Quick Audit with grep
```bash
# Find definition
grep -r "function webhookSubscriptionCreated" .

# Find imports (if 0 results = dead code)
grep -r "import.*webhookSubscriptionCreated" .

# Find call sites
grep -r "webhookSubscriptionCreated(" .
```

---

## Fire-and-Forget Patterns

### Webhook/Notification Pattern
When you need to send notifications without blocking:

```typescript
// Don't await - fire and forget with error catch
sendWebhook(url, payload, secret)
  .catch(err => console.error('Webhook failed:', err));
```

### Background Cleanup Pattern
For maintenance tasks that shouldn't slow down requests:

```typescript
// Probabilistic execution - 1% chance per request
if (Math.random() < 0.01) {
  cleanupOldData().catch(() => {}); // fire-and-forget
}
```

**When to use probabilistic:**
- Low-overhead eventual consistency is OK
- Task is idempotent (safe to run multiple times)
- ~100 requests will statistically guarantee execution

**When to use guaranteed (cron/alarm):**
- Must run at specific times
- Critical cleanup that can't be missed
- Compliance/audit requirements

---

## Durable Object / Storage Patterns

### Key Index Pattern
For O(1) lookups by secondary key:

```typescript
// On create - store index
await storage.put(`keyidx:${hash}`, primaryId);

// On lookup - find by secondary key
const primaryId = await storage.get<string>(`keyidx:${hash}`);
```

### Date-Keyed Data with Retention
```typescript
// Store with date key
const dateKey = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
await storage.put(`usage:${id}:${dateKey}`, data);

// Cleanup old data
for (let i = retentionDays + 1; i <= maxDays; i++) {
  const date = new Date();
  date.setDate(date.getDate() - i);
  keysToDelete.push(`usage:${id}:${date.toISOString().split('T')[0]}`);
}
await storage.delete(keysToDelete);
```

---

## Rate Limiting Patterns

### Tiered Rate Limits
Different limits for different endpoint types:

```typescript
// Public/billing: more lenient
const publicLimiter = createRateLimiter({ limit: 30, windowMs: 60_000 });

// Admin/sensitive: stricter
const adminLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });
```

### Rate Limit Response
```typescript
if (exceeded) {
  return Response.json({
    ok: false,
    error: 'rate_limit_exceeded',
    retry_after_seconds: resetSeconds
  }, { 
    status: 429,
    headers: { 'Retry-After': String(resetSeconds) }
  });
}
```

---

## Security Patterns

### Replay Attack Prevention
Before processing payment/transaction:

```typescript
// Check if tx already used
const existing = await storage.get(`tx:${txHash}`);
if (existing) {
  return { error: 'tx_already_used', status: 409 };
}

// After successful processing - mark as used
await storage.put(`tx:${txHash}`, { usedAt: Date.now(), workspaceId });
```

### HMAC Webhook Signing
```typescript
const key = await crypto.subtle.importKey(
  'raw',
  new TextEncoder().encode(secret),
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['sign']
);
const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
return 'sha256=' + Array.from(new Uint8Array(signature))
  .map(b => b.toString(16).padStart(2, '0'))
  .join('');
```

---

## TypeScript Patterns

### Optional Env Variables
```typescript
// ❌ Won't type-check
const val = (env as Record<string, string>).OPTIONAL_VAR;

// ✅ Works with proper typing
const val = (env as Env & { OPTIONAL_VAR?: string }).OPTIONAL_VAR;
```

### Graceful Degradation
```typescript
async function sendEmail(env: Env, params: EmailParams) {
  const apiKey = (env as Env & { API_KEY?: string }).API_KEY;
  
  if (!apiKey) {
    console.log('Email API not configured, skipping');
    return { ok: true }; // Don't fail, just skip
  }
  
  // ... send email
}
```

---

## Debugging Patterns

### Finding Dead Code
1. Search for function definition
2. Search for imports of that function
3. If import count = 0 → dead code
4. If import count > 0 → search for call sites

### Verifying Feature Works
1. Find where feature flag is checked
2. Find where feature behavior is implemented
3. Trace from trigger to behavior
4. Test with both enabled and disabled states

---

## Learnings Log

### 2026-01-23 — Code Organization & DO Alarms

**Key Discovery**: Handler ordering matters in route files!

```typescript
// ❌ BUG: Analytics unreachable - return before handler
if (parts[0] === 'workspaces') {
  // ... other handlers ...
  return new Response('method_not_allowed', { status: 405 }); // <-- BLOCKS EVERYTHING BELOW
}

if (parts[0] === 'workspaces' && parts[2] === 'analytics') { // NEVER REACHED!
  // ...
}

// ✅ FIX: Move specific handlers INSIDE the block, before the return
if (parts[0] === 'workspaces') {
  // ... other handlers ...
  if (parts[2] === 'analytics') { /* ... */ }  // <-- INSIDE
  return new Response('method_not_allowed', { status: 405 });
}
```

**DO Alarm Pattern** - Guaranteed daily cleanup:
```typescript
export class MyDurableObject {
  constructor(state: DurableObjectState) {
    this.state = state;
    this.ensureAlarmScheduled();
  }

  private async ensureAlarmScheduled(): Promise<void> {
    const existing = await this.state.storage.getAlarm();
    if (!existing) {
      const nextMidnight = new Date();
      nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);
      nextMidnight.setUTCHours(0, 0, 0, 0);
      await this.state.storage.setAlarm(nextMidnight.getTime());
    }
  }

  async alarm(): Promise<void> {
    // Do cleanup work
    await this.cleanupOldData();
    
    // Reschedule for tomorrow
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    await this.state.storage.setAlarm(tomorrow.getTime());
  }
}
```

**One-time notification pattern** - Prevent spam:
```typescript
// Only notify ONCE when crossing threshold
const notifiedKey = `credits_low_notified:${workspaceId}`;
const alreadyNotified = await storage.get<boolean>(notifiedKey);

if (shouldNotify && !alreadyNotified) {
  await storage.put(notifiedKey, true);
  sendNotification();  // Only fires once
}

// Reset flag when condition clears (e.g., after renewal)
if (!shouldNotify) {
  await storage.delete(notifiedKey);
}
```

---

### 2026-01-22 — Functional Audit Session

**Key Discovery**: Fully implemented webhook system was completely disconnected:
- ✅ Configuration endpoints worked
- ✅ Signing logic was correct
- ✅ Event formatters existed
- ❌ Never imported in main flow
- ❌ Never called when events occurred

**Root Cause**: Feature was built incrementally - config first, implementation later, integration forgotten.

**Prevention**: 
1. Build feature end-to-end in one PR
2. Include integration test that triggers the event
3. Audit: Definition → Import → Call Site → Integration
