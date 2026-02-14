# Copilot Instructions (Agent Cost Governor)

## Communication
- Discuss in Romanian.
- Keep code, identifiers, and user-facing API strings in English (match existing repo style).

## Big Picture
- **Project**: Agent Cost Governor — a payment/cost control system for AI agents.
- **Stack**: TypeScript, Cloudflare Workers, Node.js SDK, MCP Server.
- **Architecture**: Monorepo with `worker/`, `sdk-node/`, `mcp-server/`, `runner/` packages.

| Package | Purpose |
|---------|---------|
| `worker/` | Cloudflare Worker API backend |
| `sdk-node/` | Node.js SDK for integration |
| `mcp-server/` | MCP server for AI tool access |
| `runner/` | CLI runner for tasks |

## Implementation Guidelines
- Follow existing code patterns per package.
- Use TypeScript strict mode.
- Handle errors consistently across packages.
- Maintain API compatibility (v1 frozen on ES256 — don't change crypto).
- Run `npm --workspaces run check` for all packages before committing.
- Use `requests.http` for API testing.

## Key Patterns

### Code Audit Checklist
Before considering a feature "done", verify the full chain:
1. **Definition** — Does the code exist?
2. **Import** — Is it imported where needed?
3. **Call Site** — Is it actually called?
4. **Integration** — Is it connected to the event/trigger?

> Code can be fully implemented but completely disconnected from the system.

### Fire-and-Forget
```typescript
// Webhook: don't await, catch errors
sendWebhook(url, payload, secret)
  .catch(err => console.error('Webhook failed:', err));

// Probabilistic cleanup: 1% chance per request
if (Math.random() < 0.01) {
  cleanupOldData().catch(() => {});
}
```

### Durable Object / Storage
- **Key index pattern**: `keyidx:{hash}` → `primaryId` for O(1) secondary lookups.
- **Date-keyed data**: `usage:{id}:{YYYY-MM-DD}` with retention cleanup.
- **DO alarms** for guaranteed daily cleanup (reschedule in `alarm()`).
- **One-time notification**: Store `notified:{key}` flag, reset when condition clears.

### Rate Limiting
- Public/billing endpoints: 30/min per IP (lenient).
- Admin/sensitive endpoints: 10/min per IP (strict).
- Always return `Retry-After` header on 429.

### Security
- **Replay prevention**: Check `tx:{txHash}` before processing, mark after success.
- **HMAC webhook signing**: `crypto.subtle` with SHA-256, prefix `sha256=`.
- **Idempotency keys**: Prevent duplicate charges.
- **Proceed tokens**: JWT with TTL, include `ctx` (context hash) claim.

### TypeScript
```typescript
// ✅ Optional env variables with proper typing
const val = (env as Env & { OPTIONAL_VAR?: string }).OPTIONAL_VAR;

// ✅ Graceful degradation — don't fail, just skip
if (!apiKey) { return { ok: true }; }
```

### SDK Exports
- Clean barrel exports from `src/index.ts`.
- Separate concerns: `client.js`, `gate.js`, `jwks.js`, `hash.js`.
- Export both functions AND types.
- Use `import type` for type-only imports.

## Route Handler Ordering
**Critical**: Handler ordering matters — specific routes must come BEFORE generic catch-all returns:
```typescript
// ✅ Specific handlers INSIDE the block, before the return
if (parts[0] === 'workspaces') {
  if (parts[2] === 'analytics') { /* handle */ }
  return new Response('method_not_allowed', { status: 405 });
}
```

## Dev Workflows
- Install: `npm install`
- Typecheck all: `npm --workspaces run check`
- Deploy worker: `npm run deploy:worker`

## Core Protocol
- **x402-style paywall**: HTTP 402 + retry with `x402-tx-hash` header.
- **Decision flow**: Check → 402 (friction) → Pay → Redeem → `proceed_token`.
- **Tokens signed with ES256 (P-256)** — frozen for v1 compatibility.
- **JWKS exposed** at `/.well-known/jwks.json`.
- **Context hashing**: Canonical JSON (sort keys recursively), format `sha256:` + hex.

## Documentation
- Update package-specific README for changes.
- Update main README for major features.
- Keep SPEC.md in sync with API changes.
