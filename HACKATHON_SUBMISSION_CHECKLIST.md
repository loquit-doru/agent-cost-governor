# Hackathon Submission Checklist (OpenClaw Edition)

Use this before uploading to DoraHacks.

## 0) Judging alignment (40% community / 60% judges)

- [ ] Community push is prepared: X post + Discord post + short demo video.
- [ ] Hashtags are included in social posts: `#GoodVibesOnly #OpenClaw #BNBChain`.
- [ ] Judge-facing narrative is explicit:
  - [ ] Innovation: "Onchain Cost Governor Agent" for AI spend gating.
  - [ ] Functionality: real execution path with non-stub tx proof.
  - [ ] Relevance: positioned in `Agent` track (onchain autonomous actions).
  - [ ] Quality: reproducible setup, deterministic commands, clear architecture.
- [ ] Stand-out roadmap included (multi-chain expansion, richer autonomous policies).

## 1) Chain & verification (mandatory)

- [ ] `worker/wrangler.toml` uses the `hackathon` env (or equivalent) with `X402_CHAIN` set to `BSC` or `opBNB`.
- [ ] `ALLOW_STUB_TX=false` in the environment used for judging.
- [ ] `PAYMENT_VERIFY_MODE=facilitator` (or `onchain` if implemented).
- [ ] RPC URL is configured for the selected chain:
  - [ ] `BSC_RPC_URL` for BSC, or
  - [ ] `OPBNB_RPC_URL` for opBNB.
- [ ] `GOVERNOR_SIGNING_JWK` secret is set (no ephemeral key in judge demo).

## 2) Reproducibility (mandatory)

- [ ] Public repository link is accessible.
- [ ] Setup instructions are complete and tested from a clean clone.
- [ ] Required env variables/secrets are documented.
- [ ] `npm --workspaces run check` passes.
- [ ] `npm --prefix . --workspace worker run test` passes.
- [ ] `npm run smoke` passes locally.

## 3) Onchain proof (mandatory)

- [ ] At least one real tx hash on BSC/opBNB is included in submission.
- [ ] Tx explorer links are included and public.
- [ ] Demo shows tx hash used in `/v1/governor/redeem` and successful token issuance.
- [ ] Submission includes contract address if applicable.

## 4) Demo quality (high impact)

- [ ] 60–120s video showing: check -> 402 -> redeem -> proceed token -> action continues.
- [ ] Show hard gate behavior (`--abort-on-402`) to prove enforcement.
- [ ] Show credits/budget/loop protection behavior with clear outputs.
- [ ] Include one sentence impact metric (for example: requests blocked, estimated cost saved).

## 4.1) Stand-out factors (recommended)

- [ ] Submission explicitly frames ProceedGate as an autonomous onchain governor (not just a webhook/paywall).
- [ ] Include coordinator + governor multi-agent flow in architecture diagram.
- [ ] Show at least one human-in-loop safety gate for sensitive actions.
- [ ] Show one future evolution mechanism (for example: adaptive staking threshold policy).

## 5) Rule compliance

- [ ] No token launch / liquidity / airdrop pumping during event period.
- [ ] Submission includes demo link + repo + reproduction steps.
- [ ] AI usage is documented in a short build log (tools used, what they accelerated).

## Recommended command sequence (final sanity pass)

```bash
npm --workspaces run check
npm --prefix . --workspace worker run test
npm run smoke
npm run demo:billing
npm run demo:storm:block
npm run demo:storm:redeem
```

## Suggested judging payload snippets

- Chain: `opBNB` (or `BSC`)
- Tx hashes: `<tx1>`, `<tx2>`, `<tx3>`
- Demo URL: `<video_or_live_demo_url>`
- Repo URL: `<public_repo_url>`
- Repro steps: "Install -> check -> run worker -> run runner -> verify redeem"
