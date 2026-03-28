# @proceedgate/node

Framework-agnostic Node.js SDK for integrating ProceedGate (Governor) into any agent loop. Detects retry storms, enforces budgets, returns signed tokens.

## Install

```bash
npm i @proceedgate/node
```

## Quick start

```ts
import { createProceedGateClient, requireGateStepOk } from '@proceedgate/node';

const client = createProceedGateClient({
  baseUrl: 'https://governor.proceedgate.dev',
  actor: { id: 'my-agent', project: 'my-workspace-id' },
  apiKey: process.env.PG_KEY,
});

// Before each action — throws ProceedGateFrictionError if blocked
await requireGateStepOk(client, {
  policyId: 'retry_friction_v1',
  action: 'tool_call',
  context: { attempt_in_window: 1, window_seconds: 60, tool: 'search_api' },
});

// Action is allowed — proceed
```

## Configuration

```ts
const client = createProceedGateClient({
  baseUrl: 'https://governor.proceedgate.dev',  // API endpoint
  actor: { id: 'agent-id', project: 'workspace-id' },  // Actor identity
  apiKey: 'pg_ws_...',  // Workspace API key
  failMode: 'closed',  // 'closed' (default, block on error) or 'open' (allow on error)
});
```

## Gate functions

### `gateStep` — Non-throwing check

```ts
import { gateStep } from '@proceedgate/node';

const result = await gateStep(client, {
  policyId: 'retry_friction_v1',
  action: 'tool_call',
  context: { attempt_in_window: 3, window_seconds: 60, tool: 'web_scrape' },
});

if (result.kind === 'ok') {
  console.log('Allowed! Token:', result.proceedToken);
} else if (result.kind === 'friction') {
  console.log('Blocked:', result.decisionId);
  console.log('Price:', result.x402?.price);  // e.g., "0.004 USDC"
  console.log('Chain:', result.x402?.chain);  // "BSC"
}
```

### `requireGateStepOk` — Throws on friction

```ts
import { requireGateStepOk, ProceedGateFrictionError } from '@proceedgate/node';

try {
  await requireGateStepOk(client, {
    policyId: 'retry_friction_v1',
    action: 'retry',
    context: { attempt_in_window: 7, window_seconds: 60, tool: 'model' },
  });
  // Allowed — run action
} catch (e) {
  if (e instanceof ProceedGateFrictionError) {
    console.log('Blocked:', e.decisionId);
    console.log('Friction:', e.friction);  // { price, recipient, chain, reason }
    console.log('Code:', e.code);  // 'PROCEEDGATE_FRICTION'
  } else {
    throw e;
  }
}
```

### `withProceedGateGate` — Higher-order wrapper

```ts
import { withProceedGateGate } from '@proceedgate/node';

const gatedSearch = withProceedGateGate(
  (query: string) => fetch(`https://api.example.com/search?q=${query}`),
  client,
  { policyId: 'retry_friction_v1', action: 'tool_call' },
);

await gatedSearch('crypto prices');  // Checks governor first, then runs
```

## Token verification

Verify proceed_tokens downstream to prove governance happened:

```ts
import { verifyProceedToken } from '@proceedgate/node';

const payload = await verifyProceedToken(token, {
  jwksUrl: 'https://governor.proceedgate.dev/.well-known/jwks.json',
  issuer: 'https://governor.proceedgate.dev',
  audience: 'agent-cost-governor',
});
// { sub: 'agent-id', act: 'tool_call', jti: 'dec_...', exp: ... }
```

## Error types

| Error | Code | When |
|-------|------|------|
| `ProceedGateFrictionError` | `PROCEEDGATE_FRICTION` | Agent action was blocked (retry storm, budget exceeded) |

## Exports

```ts
export {
  createProceedGateClient,
  gateStep,
  gateStepWithRaw,
  requireGateStepOk,
  requireGateStepOkWithRaw,
  withProceedGateGate,
  verifyProceedToken,
  ProceedGateFrictionError,
  sha256Hex,
  sha256CanonicalJsonHex,
  canonicalizeJson,
  canonicalJsonStringify,
};
```

## Related packages

- `@proceedgate/mcp-server` — MCP server for AI tools (Claude Code, etc.)
- `@proceedgate/langchain` — LangChain tool wrapper with automatic gating

## Links

- Docs: https://proceedgate.dev/docs.html
- API: https://governor.proceedgate.dev
- Integration guide: [INTEGRATION.md](../../INTEGRATION.md)
