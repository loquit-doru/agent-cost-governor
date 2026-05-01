# Onchain Contract Package

This folder contains the smart contracts deployed by ProceedGate for governance and on-chain audit trails.

## Contracts

### `AICostGovernor.sol`
Holds USDC stakes for AI action authorization. Exposes `checkApproval(user)` for autonomous gate decisions.

### `ProceedGateLogger` (deployed, source pending)
On-chain audit trail for governance decisions. Every `/v1/check` call fire-and-forgets a log entry.

## Mainnet Deployments

### BSC Mainnet
- **AICostGovernor**: [`0x161D749892a23AC8792eE7fD37f0F423E0b69C97`](https://bscscan.com/address/0x161D749892a23AC8792eE7fD37f0F423E0b69C97)
- **ProceedGateLogger**: [`0xA2Fc77c4Db687cea2B30156f769167A10F02C83A`](https://bscscan.com/address/0xA2Fc77c4Db687cea2B30156f769167A10F02C83A)

### opBNB Mainnet
- **AICostGovernor**: [`0xAd8Da0Af368804e47bcdA8217b4e24F4cEb058dA`](https://opbnbscan.com/address/0xAd8Da0Af368804e47bcdA8217b4e24F4cEb058dA)

## Historical / Testnet Artifacts

### BSC Testnet (hackathon submission)
- contract address (Sourcify ✓): `0x2054Cc6Fa82e7c64b8226913c3b087CA8F18Ffd5`
- deployment tx: `0x0c695608865e5cad89d9b86d0041c3ca1caf142da77cbcb08febc682567c91a7`
- explorer: [testnet.bscscan.com](https://testnet.bscscan.com/address/0x2054Cc6Fa82e7c64b8226913c3b087CA8F18Ffd5)

## Deploy Path

1. Open Remix and compile `AICostGovernor.sol` (Solidity 0.8.28+, with ReentrancyGuard).
2. Select USDC address for target chain.
3. Set initial min stake (USDC has 6 decimals on BSC, 18 on opBNB).
4. Deploy.
5. Record contract address, deployment tx hash, one sample `stakeForAction` tx hash.

## Security

See `SECURITY_AUDIT.md` for Slither findings and mitigations. Full Slither report in `slither-report.json`.
