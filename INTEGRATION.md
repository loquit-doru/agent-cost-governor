# ProceedGate Integration Guide (framework-agnostic)

Goal: make cost-control enforceable in any agent loop.

ProceedGate’s invariant is simple:
- your code calls `POST /v1/governor/check`
- it gets either `200` (allowed + `proceed_token`) or `402` (friction required)
- **your runner must treat `402` as a hard gate** (no “best effort”)

This doc shows how to do that with `@proceedgate/node` in <30 minutes.

---

## Install

```bash
npm i @proceedgate/node
```

Node 18+ is required (built-in `fetch`).

## Runnable demo

From the repo root:

```bash
npm run demo:sdk
```

With non-interactive friction (stub redeem):

```bash
PROCEEDGATE_TX_HASH=0xstub npm run demo:sdk
```

---

## Minimal wiring

```ts
import {
  createProceedGateClient,
  requireGateStepOk,
  sha256CanonicalJsonHex,
} from '@proceedgate/node';

const client = createProceedGateClient({
  baseUrl: process.env.PROCEEDGATE_URL ?? 'https://governor.proceedgate.dev',
  actor: { id: 'service:my-agent', project: 'prod' },
});

function contextHashForStep(step: unknown): string {
  // Optional, but recommended: bind the decision to a canonical context.
  return sha256CanonicalJsonHex(step);
}

async function gateOnce() {
  await requireGateStepOk(client, {
    policyId: 'retry_friction_v1',
    action: 'tool_call',
    context: {
      attempt_in_window: 1,
      window_seconds: 60,
      tool: 'browser',
      context_hash: contextHashForStep({ tool: 'browser', url: 'https://example.com' }),
    },

    // Non-interactive friction mode (CI / cron / headless workers):
    // - pass txHash explicitly OR set PROCEEDGATE_TX_HASH
    txHashEnvVar: 'PROCEEDGATE_TX_HASH',
  });
}
```

If friction happens and no `txHash` is available, `requireGateStepOk()` throws `ProceedGateFrictionError`.

---

## Non-interactive (txHash / env / flag)

Common pattern:
- your service has a `--tx-hash` CLI flag
- you pass it into `requireGateStepOk({ txHash })`
- or you set `PROCEEDGATE_TX_HASH` in the runtime

This keeps the integration explicit and debuggable.

---

## Hook for future UI/wallet flows (`onFriction`)

If you want a future “approval UI” or wallet integration, you can attach a hook:

```ts
import { gateStep } from '@proceedgate/node';

const res = await gateStep(client, {
  policyId: 'retry_friction_v1',
  action: 'retry',
  context: { attempt_in_window: 3, window_seconds: 60 },
  onFriction: async ({ decisionId, x402 }) => {
    // Later: open a wallet UI / send Slack approval / call facilitator.
    // For now: return nothing to keep the flow explicit.
    console.log('Friction required', { decisionId, x402 });
  },
});

if (res.kind === 'friction') {
  // hard stop (enforce!)
  process.exitCode = 2;
}
```

---

## Canonical examples (3)

### 1) Retry loop

Use ProceedGate to stop runaway retry storms.

```ts
import { requireGateStepOk } from '@proceedgate/node';

async function callWithRetries(prompt: string) {
  for (let attempt = 1; attempt <= 10; attempt++) {
    await requireGateStepOk(client, {
      policyId: 'retry_friction_v1',
      action: 'retry',
      context: {
        attempt_in_window: attempt,
        window_seconds: 60,
        tool: 'model_call',
        task_hash: 'task:abc',
        step_hash: `step:model:${attempt}`,
      },
    });

    // ... call your model here ...
  }
}
```

### 2) Browser / scraping step

Gate expensive or risky browsing (timeouts, CAPTCHAs, long sessions).

```ts
import { requireGateStepOk } from '@proceedgate/node';

async function scrape(url: string) {
  await requireGateStepOk(client, {
    policyId: 'retry_friction_v1',
    action: 'tool_call',
    context: {
      attempt_in_window: 1,
      window_seconds: 60,
      tool: 'browser',
      context_hash: sha256CanonicalJsonHex({ tool: 'browser', url }),
    },
  });

  // ... your browser automation here ...
}
```

### 3) Paid external API

Gate calls that cost real money (SERP, enrichment, OCR, etc.).

```ts
import { requireGateStepOk } from '@proceedgate/node';

async function callPaidApi(input: unknown) {
  await requireGateStepOk(client, {
    policyId: 'retry_friction_v1',
    action: 'tool_call',
    context: {
      attempt_in_window: 1,
      window_seconds: 60,
      tool: 'paid_api',
      context_hash: sha256CanonicalJsonHex({ vendor: 'example', input }),
    },
  });

  // ... fetch vendor API ...
}
```

---

## “No regrets v1” notes

- The SDK intentionally keeps “magic” out: `gateStep()` returns a union, and `requireGateStepOk()` is the explicit “hard gate”.
- `txHash` handling is explicit (`txHash` param), with an optional env fallback.
- `onFriction()` is a single hook point for future wallet/approval UX.
- Optional `context_hash` helps bind decisions/tokens to canonical context and makes debugging safer.
