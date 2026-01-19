# @proceedgate/langchain

LangChain integration for ProceedGate cost governance.

## Installation

```bash
npm install @proceedgate/langchain
```

## Quick Start

### Callback Handler

```typescript
import { ChatOpenAI } from '@langchain/openai';
import { ProceedGateCallbackHandler } from '@proceedgate/langchain';

const handler = new ProceedGateCallbackHandler({
  apiKey: process.env.PROCEEDGATE_API_KEY,
  workspaceId: 'my-workspace',
  // Optional: Auto-block on friction (default: log warning)
  onFriction: 'block', // or 'warn' or custom function
});

const model = new ChatOpenAI({
  callbacks: [handler],
});

const response = await model.invoke('Hello!');
```

### Tool Wrapper

```typescript
import { DynamicTool } from '@langchain/core/tools';
import { wrapToolWithGate } from '@proceedgate/langchain';

const expensiveTool = new DynamicTool({
  name: 'expensive_api',
  description: 'Calls an expensive external API',
  func: async (input) => {
    // Your expensive logic
    return 'result';
  },
});

const gatedTool = wrapToolWithGate(expensiveTool, {
  apiKey: process.env.PROCEEDGATE_API_KEY,
  workspaceId: 'my-workspace',
  policyId: 'retry_friction_v1',
});
```

### Agent Executor

```typescript
import { createReactAgent, AgentExecutor } from 'langchain/agents';
import { ProceedGateAgentExecutor } from '@proceedgate/langchain';

const agent = await createReactAgent({ ... });

const executor = new ProceedGateAgentExecutor({
  agent,
  tools,
  apiKey: process.env.PROCEEDGATE_API_KEY,
  workspaceId: 'my-workspace',
  maxBudget: 100, // Stop if budget exceeded
});

const result = await executor.invoke({ input: 'Do something' });
console.log(result);
console.log('Cost:', executor.getTotalCost());
```

## Configuration

| Option | Description | Default |
|--------|-------------|---------|
| `apiKey` | ProceedGate API key | Required |
| `workspaceId` | Workspace identifier | Required |
| `baseUrl` | ProceedGate API URL | `https://governor.proceedgate.dev` |
| `policyId` | Default policy | `retry_friction_v1` |
| `onFriction` | Friction handling | `'warn'` |

## Events

The callback handler emits events you can listen to:

```typescript
handler.on('gate_check', (result) => {
  console.log('Gate check:', result.allowed);
});

handler.on('friction', (info) => {
  console.log('Friction required:', info.price);
});

handler.on('cost', (cost) => {
  console.log('Accumulated cost:', cost);
});
```

## License

MIT
