# @proceedgate/vercel-ai

Vercel AI SDK integration for ProceedGate cost governance. Gates LLM calls and tool invocations with retry storm detection and budget enforcement on BNB Chain.

## Install

```bash
npm i @proceedgate/vercel-ai
```

## Middleware (recommended)

Wrap your language model with ProceedGate governance:

```ts
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { proceedGateMiddleware } from '@proceedgate/vercel-ai';
import { wrapLanguageModel } from 'ai';

const model = wrapLanguageModel({
  model: openai('gpt-4o'),
  middleware: proceedGateMiddleware({
    apiKey: process.env.PG_KEY!,
    workspaceId: 'my-workspace',
  }),
});

// Every call is now gated
const result = await generateText({
  model,
  prompt: 'Analyze this data...',
});
```

## Tool gating

Gate individual tools:

```ts
import { tool } from 'ai';
import { z } from 'zod';
import { gatedTool } from '@proceedgate/vercel-ai';

const gate = gatedTool({
  apiKey: process.env.PG_KEY!,
  workspaceId: 'my-workspace',
});

const searchTool = gate(
  tool({
    description: 'Search the web',
    parameters: z.object({ query: z.string() }),
    execute: async ({ query }) => {
      return await fetch(`https://api.example.com/search?q=${query}`).then(r => r.json());
    },
  }),
  { costEstimate: 0.01 }
);
```

## Higher-order wrapper

Wrap any async function:

```ts
import { generateText } from 'ai';
import { withProceedGate } from '@proceedgate/vercel-ai';

const gate = withProceedGate({
  apiKey: process.env.PG_KEY!,
  workspaceId: 'my-workspace',
  maxBudget: 5.00, // $5 max
});

const result = await gate(
  () => generateText({ model: openai('gpt-4o'), prompt: 'Hello' })
);
// result._proceedgate.cost — cumulative cost tracked
```

## Configuration

```ts
proceedGateMiddleware({
  apiKey: 'pg_ws_...',           // Required: API key
  workspaceId: 'my-workspace',    // Required: workspace ID
  baseUrl: 'https://governor.proceedgate.dev', // Optional: API endpoint
  policyId: 'retry_friction_v1', // Optional: governance policy
  agentId: 'my-agent',           // Optional: agent identifier
  onFriction: 'block',           // 'block' (throw) or 'warn' (log + continue)
  maxBudget: 10.00,              // Optional: max USD budget
});
```

## Error handling

```ts
import { ProceedGateFrictionError } from '@proceedgate/vercel-ai';

try {
  await generateText({ model, prompt: '...' });
} catch (e) {
  if (e instanceof ProceedGateFrictionError) {
    console.log('Blocked:', e.decisionId);
    console.log('Friction:', e.friction); // { price, reason, chain }
  }
}
```

## Related packages

- `@proceedgate/node` — Framework-agnostic Node.js SDK
- `@proceedgate/langchain` — LangChain integration
- `@proceedgate/mcp-server` — MCP server for Claude Code

## Links

- Docs: https://proceedgate.dev/docs.html
- API: https://governor.proceedgate.dev
- Dashboard: https://proceedgate.dev/dashboard.html
