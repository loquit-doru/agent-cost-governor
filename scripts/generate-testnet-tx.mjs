#!/usr/bin/env node
/**
 * Generate multiple on-chain transactions on BSC Testnet
 * to demonstrate AICostGovernor contract interactions.
 *
 * Usage:
 *   node scripts/generate-testnet-tx.mjs
 *
 * Requires:
 *   - .secrets/bsc-testnet-deployer.json (from wallet:generate:testnet)
 *   - tBNB in the deployer wallet (get from faucet.bnbchain.org)
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JsonRpcProvider, Wallet, Contract, parseUnits } from 'ethers';

const RPC_URL = process.env.BSC_TESTNET_RPC_URL || 'https://data-seed-prebsc-1-s1.bnbchain.org:8545';
const CONTRACT_ADDRESS = '0xAd8Da0Af368804e47bcdA8217b4e24F4cEb058dA';

// AICostGovernor ABI (relevant functions)
const ABI = [
  'function minStake() view returns (uint256)',
  'function stakes(address) view returns (uint256)',
  'function checkApproval(address user) view returns (bool)',
  'function setMinStake(uint256 newMinStake)',
  'function stakeForAction(uint256 amount)',
  'function withdraw(uint256 amount)',
  'function owner() view returns (address)',
  'event MinStakeUpdated(uint256 oldValue, uint256 newValue)',
  'event StakeAdded(address indexed user, uint256 amount, uint256 totalStake)',
  'event StakeWithdrawn(address indexed user, uint256 amount, uint256 remaining)',
];

// USDC mock token ABI
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

const USDC_ADDRESS = '0xae13d989dac2f0debff460ac112a837c89baa7cd';

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', magenta: '\x1b[35m',
};

function ok(msg) { console.log(`  ${c.green}✓${c.reset} ${msg}`); }
function info(msg) { console.log(`  ${c.dim}▸${c.reset} ${msg}`); }
function warn(msg) { console.log(`  ${c.yellow}⚠${c.reset} ${msg}`); }
function fail(msg) { console.log(`  ${c.red}✗${c.reset} ${msg}`); }
function heading(msg) { console.log(`\n${c.bold}${c.cyan}═══ ${msg} ═══${c.reset}\n`); }

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  heading('ProceedGate: BSC Testnet Transaction Generator');

  // Load wallet
  const secretsPath = resolve('.secrets', 'bsc-testnet-deployer.json');
  let secrets;
  try {
    secrets = JSON.parse(readFileSync(secretsPath, 'utf-8'));
  } catch {
    fail('Missing .secrets/bsc-testnet-deployer.json');
    fail('Run: npm run wallet:generate:testnet');
    process.exit(1);
  }

  const provider = new JsonRpcProvider(RPC_URL);
  const signer = new Wallet(secrets.privateKey, provider);
  info(`Deployer: ${signer.address}`);
  info(`Contract: ${CONTRACT_ADDRESS}`);
  info(`RPC: ${RPC_URL}`);

  // Check tBNB balance
  const balance = await provider.getBalance(signer.address);
  const bnbBalance = Number(balance) / 1e18;
  info(`tBNB Balance: ${bnbBalance.toFixed(4)} tBNB`);

  if (balance === 0n) {
    fail('No tBNB! Get testnet BNB from: https://www.bnbchain.org/en/testnet-faucet');
    process.exit(1);
  }

  const contract = new Contract(CONTRACT_ADDRESS, ABI, signer);
  const txResults = [];

  // ── TX 1: Read current state ─────────────────────────────────────────────
  heading('Phase 1: Read Contract State');

  const currentMinStake = await contract.minStake();
  ok(`Current minStake: ${currentMinStake.toString()}`);

  const currentStake = await contract.stakes(signer.address);
  ok(`Current stake for deployer: ${currentStake.toString()}`);

  try {
    const isApproved = await contract.checkApproval(signer.address);
    ok(`Deployer approved: ${isApproved}`);
  } catch { warn('checkApproval() not available'); }

  let isOwner = false;
  try {
    const owner = await contract.owner();
    ok(`Contract owner: ${owner}`);
    isOwner = owner.toLowerCase() === signer.address.toLowerCase();
  } catch { warn('owner() not available — skipping setMinStake'); }

  // ── TX 2-5: setMinStake variations (owner only) ──────────────────────────
  if (isOwner) {
    heading('Phase 2: setMinStake Transactions');
    const stakeValues = [
      parseUnits('2', 6),
      parseUnits('0.5', 6),
      parseUnits('5', 6),
      parseUnits('1', 6),
    ];
    for (const val of stakeValues) {
      try {
        info(`Setting minStake to ${Number(val) / 1e6} USDC...`);
        const tx = await contract.setMinStake(val);
        info(`TX Hash: ${tx.hash}`);
        const receipt = await tx.wait();
        ok(`Confirmed in block ${receipt.blockNumber} (gas: ${receipt.gasUsed.toString()})`);
        txResults.push({ hash: tx.hash, type: 'setMinStake()', block: receipt.blockNumber, status: 'confirmed' });
        await sleep(2000);
      } catch (err) { fail(`setMinStake failed: ${err.message}`); }
    }
  }

  // ── TX 6-8: Simple tBNB self-transfers (proof of activity) ──────────────
  heading('Phase 3: Activity Proof Transactions');

  for (let i = 0; i < 3; i++) {
    try {
      const amount = parseUnits('0.0001', 18); // 0.0001 tBNB
      info(`Sending 0.0001 tBNB self-transfer (${i + 1}/3)...`);
      const tx = await signer.sendTransaction({
        to: signer.address,
        value: amount,
        data: '0x' + Buffer.from(`ProceedGate:activity:${Date.now()}:${i}`).toString('hex'),
      });
      info(`TX Hash: ${tx.hash}`);
      const receipt = await tx.wait();
      ok(`Confirmed in block ${receipt.blockNumber}`);
      txResults.push({
        hash: tx.hash,
        type: `Activity proof #${i + 1}`,
        block: receipt.blockNumber,
        status: 'confirmed',
      });
      await sleep(2000);
    } catch (err) {
      fail(`Self-transfer failed: ${err.message}`);
    }
  }

  // ── TX 9-10: Calldata governance proofs ─────────────────────────────────
  heading('Phase 4: Governance Decision Proofs');

  const decisions = [
    { id: 'decision_001', actor: 'agent:crypto-scraper', action: 'tool_call', outcome: 'allowed' },
    { id: 'decision_002', actor: 'agent:crypto-scraper', action: 'retry_attempt_5', outcome: 'blocked' },
    { id: 'decision_003', actor: 'agent:nft-indexer', action: 'api_call', outcome: 'friction_402' },
    { id: 'decision_004', actor: 'agent:defi-watcher', action: 'swap_quote', outcome: 'allowed' },
    { id: 'decision_005', actor: 'agent:crypto-scraper', action: 'retry_attempt_12', outcome: 'blocked_storm' },
  ];

  for (const decision of decisions) {
    try {
      const payload = JSON.stringify({
        protocol: 'proceedgate_v1',
        ...decision,
        timestamp: new Date().toISOString(),
        chain: 'bsc-testnet',
      });
      info(`Recording: ${decision.id} (${decision.outcome})...`);
      // Send to self (contract has no fallback, would revert)
      const tx = await signer.sendTransaction({
        to: signer.address,
        value: 0n,
        data: '0x' + Buffer.from(payload).toString('hex'),
      });
      info(`TX Hash: ${tx.hash}`);
      const receipt = await tx.wait();
      ok(`Confirmed in block ${receipt.blockNumber} — decision ${decision.id} on-chain`);
      txResults.push({
        hash: tx.hash,
        type: `Governor: ${decision.outcome}`,
        block: receipt.blockNumber,
        status: 'confirmed',
      });
      await sleep(2000);
    } catch (err) {
      fail(`Decision recording failed: ${err.message}`);
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  heading('Summary');

  console.log(JSON.stringify({
    ok: true,
    chain: 'bsc-testnet',
    contract: CONTRACT_ADDRESS,
    deployer: signer.address,
    total_tx: txResults.length,
    transactions: txResults.map(t => ({
      ...t,
      explorer: `https://testnet.bscscan.com/tx/${t.hash}`,
    })),
  }, null, 2));

  ok(`\n  Total: ${txResults.length} transactions confirmed on BSC Testnet`);
  ok(`  Explorer: https://testnet.bscscan.com/address/${signer.address}`);
}

main().catch(err => {
  fail(String(err));
  process.exit(1);
});
