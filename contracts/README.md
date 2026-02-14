# Onchain Contract Package (Competition)

This folder contains the reference contract used by ProceedGate's OpenClaw competition mode.

## Contract

- `AICostGovernor.sol`

## Purpose

- Hold USDC stakes for AI action authorization.
- Expose `checkApproval(user)` for autonomous gate decisions.
- Provide verifiable onchain proof for hackathon judging.

## Suggested network

- `opBNB` (preferred for low fees) or `BSC`.

## Suggested deploy path

1. Open Remix and compile `AICostGovernor.sol` (Solidity 0.8.20+).
2. Select USDC address for target chain.
3. Set initial min stake (USDC has 6 decimals).
4. Deploy.
5. Record:
   - contract address
   - deployment tx hash
   - one sample `stakeForAction` tx hash

## Judge artifacts

Include all below in submission:

- contract address
- deployment tx hash
- staking tx hash
- explorer links
- short explanation of how `checkApproval` gates AI actions
