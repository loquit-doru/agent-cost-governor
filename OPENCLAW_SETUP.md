# OpenClaw Setup (Competition)

## Prerequisites

- Node.js 22+
- Git

## Install OpenClaw

```bash
npm install -g openclaw
```

Alternative:

- Clone: `https://github.com/openclaw/openclaw`

## Initial Setup

Run CLI wizard and configure your LLM provider keys.

```bash
openclaw onboard
```

## Register skill from this repo

```bash
openclaw configure --section skills
```

Use the repository skill path during skills setup:

- `./skills/onchain-cost-governor`

## Test skill behavior

1. Configure chain RPC + contract address in your OpenClaw runtime.
2. Send a command that triggers expensive action gating.
3. Validate block/allow decision based on onchain approval.

## Safety

- Use sandbox runtime for local testing.
- Use test wallet for BSC/opBNB experiments.
- Add human confirmation for sensitive actions.
