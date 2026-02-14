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

## Current deploy artifact (BSC Testnet)

- contract address: `0xAd8Da0Af368804e47bcdA8217b4e24F4cEb058dA`
- deployment tx hash: `0x0c695608865e5cad89d9b86d0041c3ca1caf142da77cbcb08febc682567c91a7`
- explorer (contract): `https://testnet.bscscan.com/address/0xAd8Da0Af368804e47bcdA8217b4e24F4cEb058dA`
- explorer (tx): `https://testnet.bscscan.com/tx/0x0c695608865e5cad89d9b86d0041c3ca1caf142da77cbcb08febc682567c91a7`

## Judge artifacts

Include all below in submission:

- contract address
- deployment tx hash
- staking tx hash
- explorer links
- short explanation of how `checkApproval` gates AI actions
