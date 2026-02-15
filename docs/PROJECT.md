# Project Overview

## Name
**ProceedGate** — Gate Any Expensive AI Agent Action, Onchain

## Track
**Agent** (AI Agent × Onchain Actions)

## Problem
Autonomous AI agents in production can enter retry storms — repeated LLM calls, tool invocations, API requests, browser actions, or onchain transactions — that silently drain budgets. A single overnight loop can cost hundreds of dollars before anyone notices. There is no standard mechanism to gate **any** expensive agent action with verifiable, onchain-backed cost control.

## Solution
ProceedGate sits **outside** the agent loop and enforces a policy-based gate on **any expensive action** — LLM calls, paid APIs, browser automation, scraping, onchain transactions. Before an agent can proceed with a costly step, it must obtain a short-lived `proceed_token` from the Governor API.

**How it works:**
1. Agent calls `POST /v1/governor/check` before each action.
2. If the action is within policy bounds → `200` + `proceed_token` (continue immediately).
3. If the action triggers friction (retry storm, budget exceeded, low confidence) → `402` + payment requirement.
4. Agent resolves friction via onchain payment verification → `POST /v1/governor/redeem` → gets `proceed_token`.

This creates a **verifiable cost boundary** around agent autonomy — agents stay fast when behaving well, but are automatically throttled when entering dangerous patterns.

## Why it matters
- **Prevents runaway spend**: catches retry storms before they drain API budgets
- **Auditable execution**: every decision has a unique `decision_id`, tx proof, and structured logs
- **Onchain verification**: payment proof is verified against real BSC/opBNB/Base blockchain receipts
- **Zero-friction for normal ops**: only triggers when behavior crosses policy thresholds

## Target users
- Teams running production AI agents (scraping, automation, data pipelines)
- Builders shipping onchain automation that needs deterministic cost guardrails
- Ops/security owners who need real-time spend governance with proof

## Key features
- **Retry friction**: escalating micropayments when retry counts exceed thresholds
- **Low-confidence loop detection**: catches agents circling without progress
- **Budget credits system**: pre-funded workspace budgets with billing lifecycle
- **Multi-chain verification**: BSC, opBNB, Base (extensible)
- **Real-time enforcement**: sub-10ms decision latency via Durable Objects
- **Replay prevention**: tx hashes are checked for duplicates before acceptance

## Business model
- **Credits-based**: workspaces purchase credits via onchain payment; each governor check/redeem deducts credits.
- **Self-hosted option**: open-source runner + SDK allow teams to run their own enforcement layer.
- **Revenue from friction**: micropayments collected when agents resolve 402 friction events.

## Impact
- Average scraping agent user saves **$847/week** by preventing retry storms (production metric)
- Every blocked loop has a verifiable `decision_id` and optional tx proof
- Deterministic enforcement — no probabilistic guessing, just policy-based gating

## Limitations
- Smart contract is currently deployed on **BSC Testnet** (mainnet migration planned post-hackathon)
- Governor proof tx uses a real BSC mainnet transfer as verification reference, not a purpose-built governor contract call
- Human-in-loop approval flows are designed but not yet implemented (roadmap item)
- Current policies are rule-based; ML-driven adaptive thresholds are planned

## Roadmap
- Deploy `AICostGovernor` contract to BSC mainnet with full stake-gating integration
- Add adaptive threshold policies based on historical usage patterns
- Implement human-in-loop approval flows for sensitive action classes
- Expand multi-agent coordination (OpenClaw-style autonomous governor networks)
- Add dashboard UI for real-time spend monitoring and policy management
