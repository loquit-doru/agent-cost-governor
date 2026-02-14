# OpenClaw Competition Mode

This repo is prepared for a **non-stub, real onchain proof flow** for the OpenClaw Edition.

## Deployed hackathon endpoint

- `https://agent-cost-governor-hackathon.apiworkersdev.workers.dev`

## Current chain mode

- `BSC`
- `PAYMENT_VERIFY_MODE=facilitator`
- `FACILITATOR_URL=internal`
- `ALLOW_STUB_TX=false`

## Real tx used for proof run

- `0xd97039268c048cafd45c0f3b870111b1dcd22f3fdfd62a47e75ae843eb13b548`
- Explorer: `https://bscscan.com/tx/0xd97039268c048cafd45c0f3b870111b1dcd22f3fdfd62a47e75ae843eb13b548`

## Deployed contract (BSC Testnet)

- Contract: `0xAd8Da0Af368804e47bcdA8217b4e24F4cEb058dA`
- Deploy tx: `0x0c695608865e5cad89d9b86d0041c3ca1caf142da77cbcb08febc682567c91a7`
- Explorer (contract): `https://testnet.bscscan.com/address/0xAd8Da0Af368804e47bcdA8217b4e24F4cEb058dA`
- Explorer (tx): `https://testnet.bscscan.com/tx/0x0c695608865e5cad89d9b86d0041c3ca1caf142da77cbcb08febc682567c91a7`

## One-command proof run

Set admin key (already configured in the hackathon worker), then run:

```bash
# PowerShell
$env:HACKATHON_API_ADMIN_KEY="<your_api_admin_key>"
npm run demo:hackathon:proof
```

Optional overrides:

- `HACKATHON_BASE_URL`
- `HACKATHON_WORKSPACE_ID`
- `HACKATHON_TX_HASH`
- `HACKATHON_CREDITS`

Notes:

- Default workspace is `hackathon-demo`.
- If workspace already has credits, script skips billing top-up and runs proof directly.
- If workspace has no credits, top-up requires a fresh (unused) tx hash.

## Expected output

Script prints JSON with:

- `decision_id`
- `paid_chain`
- `tx_hash`
- `credits_total`
- `has_proceed_token=true`

This is the artifact you can attach in submission notes/video proof.

## OpenClaw Integration Steps

Install OpenClaw:

```bash
npm install -g openclaw
```

Run OpenClaw onboarding:

```bash
openclaw onboard
```

Register skill from this repo:

```bash
openclaw configure --section skills
```

Reference docs:

- `OPENCLAW_SETUP.md`
- `skills/onchain-cost-governor/SKILL.md`

## If you don't have a deploy key

Generate a fresh BSC testnet deploy wallet:

```bash
npm run wallet:generate:testnet
```

This creates `.secrets/bsc-testnet-deployer.json` with:

- deployer address
- private key

Then:

1. Fund the generated address from a BSC testnet faucet.
2. Export key and token address:

```bash
# PowerShell
$env:DEPLOYER_PRIVATE_KEY="0x..."
$env:USDC_TOKEN_ADDRESS="0x..."
npm run deploy:contract:testnet
```

Output includes `contractAddress` and deploy `txHash` for submission proof.

## Judging Strategy Alignment

### 40% Community Votes

- Publish demo clips on X + Discord with:
	- `#GoodVibesOnly`
	- `#OpenClaw`
	- `#BNBChain`
- Include direct proof snippet (`decision_id`, `tx_hash`, `paid_chain`) in post.
- Keep one short non-technical caption: "Stops runaway AI spend with onchain approval."

### 60% Judges

- Innovation: autonomous onchain spend governance for AI agents.
- Functionality: non-stub tx path, real check -> 402 -> redeem -> proceed token.
- Relevance: Agent track fit (autonomous execution control).
- Quality: deterministic command + reproducible docs + auditable artifacts.

## Stand-Out Additions Included

- Multi-agent role design in `openclaw/SOUL.md`.
- OpenClaw custom skill in `openclaw/skills/OnchainCostGovernor.yaml`.
- Onchain stake contract in `contracts/AICostGovernor.sol`.
- AI usage evidence in `AI_BUILD_LOG.md`.
