# Project Overview

## Name
ProceedGate — Onchain Cost Governor Agent

## Problem
Autonomous AI agents can enter retry storms and silently drain budgets through repeated tool/API calls.

## Solution
ProceedGate gates expensive agent actions with policy checks and onchain-verifiable friction. If an action is risky, execution is blocked until a valid redeem path is completed.

## Why it matters
- Prevents runaway spend in real agent workflows
- Provides auditable execution control (decision IDs, tx proofs, logs)
- Keeps operators in control while preserving autonomous speed

## Target users
- Teams running production AI agents
- Builders shipping onchain automation
- Ops/security owners who need deterministic cost guardrails

## Impact
- Fewer accidental high-cost loops
- Faster incident response for agent misuse patterns
- Clear proof-based governance for judges and stakeholders

## Roadmap
- Expand onchain verification to additional chains beyond BSC/opBNB
- Add adaptive threshold policies based on historical usage
- Add richer human-in-loop approval policies for sensitive actions
