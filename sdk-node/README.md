# @proceedgate/node

Framework-agnostic Node.js SDK for integrating ProceedGate (Governor) into any agent loop.

## Install

```bash
npm i @proceedgate/node
```

## Quick start

```ts
import { createProceedGateClient, requireGateStepOk } from '@proceedgate/node';

const client = createProceedGateClient({
  baseUrl: 'https://governor.proceedgate.dev',
  actor: { id: 'service:agent-runner', project: 'demo' },
});

await requireGateStepOk(client, {
  policyId: 'retry_friction_v1',
  action: 'retry',
  context: { attempt_in_window: 3, window_seconds: 60, tool: 'model' },
  // Non-interactive demo mode:
  txHash: process.env.PROCEEDGATE_TX_HASH,
});

// Typical catch pattern (no regrets v1):
// import { ProceedGateFrictionError } from '@proceedgate/node';
// try { ... } catch (e) {
//   if (e instanceof ProceedGateFrictionError) {
//     console.log('Decision blocked:', e.decisionId);
//     console.log('Friction:', e.friction);
//     console.log('Stable code:', e.code);
//   } else {
//     throw e;
//   }
// }

// If you need raw payloads for debugging/observability:
// import { requireGateStepOkWithRaw } from '@proceedgate/node';
```

See ../../INTEGRATION.md for end-to-end examples.
