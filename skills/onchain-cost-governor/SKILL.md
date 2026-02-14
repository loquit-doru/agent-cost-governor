---
name: Onchain Cost Governor
description: Controlează costurile agenților AI prin gating onchain pe BNB Chain.
version: 1.0.0
dependencies:
  - ethers
  - viem
---

# Purpose

Allow expensive AI actions only when onchain approval exists.

# Behavior

1. For an expensive action request, read actor address and requested action.
2. Query CostGovernor/AICostGovernor contract on BSC or opBNB.
3. If approved stake/payment is present, allow action.
4. If approval is missing, block action and return remediation:
   - run `approve()` / `stakeForAction()` transaction
   - retry after tx confirmation
5. For sensitive actions, require human confirmation before sending wallet tx.

# Inputs

- actorAddress (required)
- action (required)
- estimatedCostUsd (required)
- chain (optional, default: bsc)
- contractAddress (required)

# Outputs

- allowed: boolean
- reason: string
- txHash: string | null
- recommendation: string

# Security

- Never expose private keys in output.
- Fail closed (block) when RPC/contract verification fails.
- Log decision metadata for audit (`decision_id`, `actorAddress`, `chain`).
