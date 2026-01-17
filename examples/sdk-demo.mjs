#!/usr/bin/env node

import {
  createProceedGateClient,
  ProceedGateFrictionError,
  requireGateStepOk,
  sha256CanonicalJsonHex,
} from '@proceedgate/node';

function parseArgs(argv) {
  const out = {
    governor: process.env.PROCEEDGATE_URL ?? 'https://governor.proceedgate.dev',
    txHash: process.env.PROCEEDGATE_TX_HASH,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--governor' && argv[i + 1]) {
      out.governor = argv[++i];
      continue;
    }
    if (a === '--tx-hash' && argv[i + 1]) {
      out.txHash = argv[++i];
      continue;
    }
    if (a === '--help' || a === '-h') {
      out.help = true;
      continue;
    }
  }

  return out;
}

const args = parseArgs(process.argv);
if (args.help) {
  console.log(`ProceedGate SDK demo (framework-agnostic)

Usage:
  node examples/sdk-demo.mjs --governor <url> [--tx-hash <hash>]

Env:
  PROCEEDGATE_URL      default governor baseUrl
  PROCEEDGATE_TX_HASH  non-interactive friction redeem

Examples:
  node examples/sdk-demo.mjs --governor http://127.0.0.1:8787
  node examples/sdk-demo.mjs --governor https://governor.proceedgate.dev --tx-hash 0xstub
`);
  process.exit(0);
}

const client = createProceedGateClient({
  baseUrl: args.governor,
  actor: { id: 'service:sdk-demo', project: 'examples' },
});

function stepContext(name, extra = {}) {
  const payload = { step: name, ...extra };
  return {
    attempt_in_window: 1,
    window_seconds: 60,
    tool: name,
    context_hash: sha256CanonicalJsonHex(payload),
  };
}

console.log('ProceedGate SDK demo');
console.log('Governor:', args.governor);
console.log('TxHash:', args.txHash ? '(provided)' : '(missing)');
console.log('---');

// 1) Allowed step
await requireGateStepOk(client, {
  policyId: 'retry_friction_v1',
  action: 'tool_call',
  context: stepContext('paid_api', { vendor: 'example' }),
  txHash: args.txHash,
});
console.log('Step 1 ok: allowed');

// 2) Intentionally trigger friction (attempt 4 > freeAttempts 3)
try {
  await requireGateStepOk(client, {
    policyId: 'retry_friction_v1',
    action: 'retry',
    context: {
      ...stepContext('retry_loop', { attempt: 4 }),
      attempt_in_window: 4,
      window_seconds: 60,
    },
    txHash: args.txHash,
  });

  console.log('Step 2 ok: friction redeemed (txHash present)');
} catch (e) {
  if (e instanceof ProceedGateFrictionError) {
    console.log('Step 2 blocked (friction required)');
    console.log('Decision:', e.decisionId);
    console.log('Stable code:', e.code);
    console.log('Friction:', e.friction);

    console.log('\nTip: rerun with `--tx-hash 0xstub` (or set PROCEEDGATE_TX_HASH).');
    process.exitCode = 2;
  } else {
    throw e;
  }
}
