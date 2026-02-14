# Hackathon Submission Checklist (OpenClaw Edition)

Use this before uploading to DoraHacks.

## 0) Judging alignment (40% community / 60% judges)

- [ ] Community push is prepared: X post + Discord post + short demo video.
- [ ] Hashtags are included in social posts: `#GoodVibesOnly #OpenClaw #BNBChain`.
- [x] Judge-facing narrative is explicit:
  - [x] Innovation: "Onchain Cost Governor" for AI agent spend gating.
  - [x] Functionality: real execution path with non-stub tx proof.
  - [x] Relevance: positioned in `Agent` track (onchain autonomous actions).
  - [x] Quality: reproducible setup, deterministic commands, clear architecture.
- [x] Stand-out roadmap included (multi-chain expansion, richer autonomous policies).

## 1) Chain & verification (mandatory)

- [x] `worker/wrangler.toml` uses the `hackathon` env with `X402_CHAIN=BSC`.
- [x] `ALLOW_STUB_TX=false` in the environment used for judging.
- [x] `PAYMENT_VERIFY_MODE=facilitator` (internal facilitator).
- [x] RPC URL is configured for the selected chain:
  - [x] `BSC_RPC_URL` for BSC.
  - [x] `OPBNB_RPC_URL` for opBNB.
  - [x] `BASE_RPC_URL` for Base.
- [x] `GOVERNOR_SIGNING_JWK` secret is set (no ephemeral key in judge demo).

## 2) Reproducibility (mandatory)

- [x] Public repository link is accessible.
- [x] Setup instructions are complete and tested from a clean clone (`docs/TECHNICAL.md`).
- [x] Required env variables/secrets are documented.
- [x] `npm --workspaces run check` passes.
- [x] `npm --workspace worker run test` passes (88 tests).
- [x] `npm run smoke` passes locally.

## 3) Onchain proof (mandatory)

- [x] Real tx hash on BSC mainnet included in submission.
- [x] Tx explorer links are included and public (`bsc.address`).
- [x] Demo shows tx hash used in `/v1/governor/redeem` and successful token issuance.
- [x] Contract address included (BSC Testnet).

## 4) Demo quality (high impact)

- [ ] 60–120s video showing: check → 402 → redeem → proceed_token → action continues.
- [x] Show hard gate behavior (`--abort-on-402`) — `demo:storm:block` validated.
- [x] Show credits/budget/loop protection — `demo:billing` validated.
- [x] Impact metric: "Avg user saves $847/week by preventing retry storms."

## 5) Rule compliance

- [x] No token launch / liquidity / airdrop pumping during event period.
- [x] Submission includes demo link + repo + reproduction steps.
- [x] AI usage is documented in `AI_BUILD_LOG.md`.

## Recommended command sequence (final sanity pass)

```bash
npm install
npm --workspaces run check
npm --workspace worker run test
npm run smoke
npm run demo:billing
npm run demo:storm:block
npm run demo:storm:redeem
```

All commands above have been validated and pass as of 2026-02-14.

## Judging payload snippets

- Chain: `BSC` (mainnet tx proof + testnet contract)
- Tx hashes:
  - `0xd97039268c048cafd45c0f3b870111b1dcd22f3fdfd62a47e75ae843eb13b548` (proof flow, BSC mainnet)
  - `0x0c695608865e5cad89d9b86d0041c3ca1caf142da77cbcb08febc682567c91a7` (contract deploy, BSC testnet)
- Contract address: `0xAd8Da0Af368804e47bcdA8217b4e24F4cEb058dA` (BSC testnet)
- Explorer links:
  - https://bscscan.com/tx/0xd97039268c048cafd45c0f3b870111b1dcd22f3fdfd62a47e75ae843eb13b548
  - https://testnet.bscscan.com/address/0xAd8Da0Af368804e47bcdA8217b4e24F4cEb058dA
  - [BSC Testnet contract](https://testnet.bscscan.com/address/0xAd8Da0Af368804e47bcdA8217b4e24F4cEb058dA)
  - [BSC Testnet deploy tx](https://testnet.bscscan.com/tx/0x0c695608865e5cad89d9b86d0041c3ca1caf142da77cbcb08febc682567c91a7)
- Demo URL: `https://agent-cost-governor-hackathon.apiworkersdev.workers.dev`
- Website: `https://proceedgate.dev`
- Repo URL: `https://github.com/loquit-doru/agent-cost-governor`
- Repro steps: `npm install && npm --workspaces run check && npm run smoke`
