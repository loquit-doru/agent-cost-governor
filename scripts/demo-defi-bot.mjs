#!/usr/bin/env node
/**
 * 💹 DeFi Trading Bot — ProceedGate Use Case #2
 *
 * Simulates a DeFi arbitrage bot that executes swaps across DEXes,
 * with ProceedGate enforcing per-trade cost caps and storm detection.
 *
 * Scenario:
 *   - Bot scans price differences across PancakeSwap, Uniswap, SushiSwap
 *   - Each swap is gated through ProceedGate (gas + slippage = cost)
 *   - A flash crash causes the bot to spam swaps → ProceedGate blocks the storm
 *   - Budget cap prevents draining the wallet
 *
 * Usage: node scripts/demo-defi-bot.mjs [--base-url URL]
 */

import { spawn } from 'node:child_process';

const PORT = 8820 + Math.floor(Math.random() * 100);
const CUSTOM_URL = process.argv.find(a => a.startsWith('--base-url='))?.split('=')[1];
const GOVERNOR_URL = CUSTOM_URL || `http://127.0.0.1:${PORT}`;
const USE_LOCAL = !CUSTOM_URL;

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', italic: '\x1b[3m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', magenta: '\x1b[35m', blue: '\x1b[34m', gray: '\x1b[90m',
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function banner(t) { console.log(`\n${c.bold}${c.cyan}╔${'═'.repeat(t.length + 4)}╗\n║  ${t}  ║\n╚${'═'.repeat(t.length + 4)}╝${c.reset}\n`); }
function phase(n, t) { console.log(`\n${c.bold}${c.magenta}  ── Phase ${n}: ${t} ──${c.reset}\n`); }
function bot(t) { console.log(`  ${c.bold}${c.cyan}🤖 ${t}${c.reset}`); }
function ok(t) { console.log(`     ${c.green}✅ ${t}${c.reset}`); }
function warn(t) { console.log(`     ${c.yellow}⚠️  ${t}${c.reset}`); }
function fail(t) { console.log(`     ${c.red}🚫 ${t}${c.reset}`); }
function info(t) { console.log(`  ${c.dim}▸ ${t}${c.reset}`); }
function money(t) { console.log(`  ${c.bold}${c.green}💰 ${t}${c.reset}`); }

async function http(method, path, body, headers = {}) {
  const res = await fetch(`${GOVERNOR_URL}${path}`, {
    method, headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const DEXES = ['PancakeSwap', 'Uniswap V3', 'SushiSwap', '1inch'];
const PAIRS = ['BNB/USDT', 'ETH/USDC', 'CAKE/BNB', 'ARB/ETH', 'SOL/USDC'];

// ── Trading rounds ─────────────────────────────────────────────────────────
const ROUNDS = [
  // Normal arbitrage opportunities
  { pair: 'BNB/USDT', dex: 'PancakeSwap', type: 'swap', spread: 0.3, gasUsd: 0.15, amount: 500 },
  { pair: 'ETH/USDC', dex: 'Uniswap V3', type: 'swap', spread: 0.5, gasUsd: 2.10, amount: 1200 },
  { pair: 'CAKE/BNB', dex: 'PancakeSwap', type: 'swap', spread: 0.2, gasUsd: 0.08, amount: 300 },
  // Price feed check (cheap)
  { pair: 'ARB/ETH', dex: '1inch', type: 'quote', spread: 0, gasUsd: 0, amount: 0 },
  // Another normal swap
  { pair: 'SOL/USDC', dex: 'SushiSwap', type: 'swap', spread: 0.4, gasUsd: 0.12, amount: 800 },
  // ⚡ Flash crash — bot panic-swaps the same pair repeatedly
  { pair: 'BNB/USDT', dex: 'PancakeSwap', type: 'panic_swap', spread: -2.0, gasUsd: 0.50, amount: 2000 },
  { pair: 'BNB/USDT', dex: 'PancakeSwap', type: 'panic_swap', spread: -3.0, gasUsd: 0.80, amount: 2000 },
  { pair: 'BNB/USDT', dex: 'PancakeSwap', type: 'panic_swap', spread: -4.5, gasUsd: 1.20, amount: 3000 },
  { pair: 'BNB/USDT', dex: 'PancakeSwap', type: 'panic_swap', spread: -5.0, gasUsd: 1.50, amount: 5000 },
  { pair: 'BNB/USDT', dex: 'PancakeSwap', type: 'panic_swap', spread: -6.0, gasUsd: 2.00, amount: 5000 },
  { pair: 'BNB/USDT', dex: 'PancakeSwap', type: 'panic_swap', spread: -7.0, gasUsd: 3.00, amount: 8000 },
  { pair: 'BNB/USDT', dex: 'PancakeSwap', type: 'panic_swap', spread: -8.0, gasUsd: 4.00, amount: 10000 },
  { pair: 'BNB/USDT', dex: 'PancakeSwap', type: 'panic_swap', spread: -9.0, gasUsd: 5.00, amount: 10000 },
  { pair: 'BNB/USDT', dex: 'PancakeSwap', type: 'panic_swap', spread: -10.0, gasUsd: 6.00, amount: 15000 },
  { pair: 'BNB/USDT', dex: 'PancakeSwap', type: 'panic_swap', spread: -12.0, gasUsd: 8.00, amount: 20000 },
  // Post-storm: this should be blocked
  { pair: 'ETH/USDC', dex: 'Uniswap V3', type: 'swap', spread: 0.6, gasUsd: 1.80, amount: 1000 },
];

let totalGas = 0;
let totalSwaps = 0;
let totalBlocked = 0;
let gasSaved = 0;
let slippageSaved = 0;
let workerProc = null;
let wsId = null;

async function startLocalWorker() {
  if (!USE_LOCAL) return;
  info(`Starting local worker on port ${PORT}...`);
  workerProc = spawn('npx', ['wrangler', 'dev', '--local', '--port', String(PORT), '--config', 'worker/wrangler.toml'], {
    cwd: process.cwd(), shell: true, stdio: 'pipe',
  });
  let ready = false;
  workerProc.stderr.on('data', d => { if (d.toString().includes('Ready')) ready = true; });
  workerProc.stdout.on('data', d => { if (d.toString().includes('Ready')) ready = true; });
  for (let i = 0; i < 40 && !ready; i++) await sleep(500);
  if (!ready) await sleep(3000);
  ok('Local worker ready');
}

async function setupWorkspace() {
  const adminKey = 'demo_admin_' + Date.now();
  const { data } = await http('POST', '/v1/workspaces', {
    name: 'DeFi Arb Bot',
    budget_usd: 5.00,
    owner: 'demo-defi-bot',
  }, { 'x-api-admin-key': adminKey });
  wsId = data.workspace_id || data.id || 'ws_demo';
  ok(`Workspace: ${wsId} (budget: $5.00)`);
}

async function executeRound(round, idx) {
  const isPanic = round.type === 'panic_swap';
  const emoji = isPanic ? '⚡' : round.type === 'quote' ? '📊' : '💱';
  const costEst = round.gasUsd + Math.abs(round.spread) * round.amount / 100;

  bot(`${emoji} Round ${idx + 1}: ${round.type.toUpperCase()} ${round.pair} on ${round.dex}`);
  if (round.type !== 'quote') {
    info(`Amount: $${round.amount} | Gas: $${round.gasUsd} | Spread: ${round.spread > 0 ? '+' : ''}${round.spread}%`);
  }

  const { status, data } = await http('POST', `/v1/workspaces/${wsId}/check`, {
    action: `defi.${round.dex.toLowerCase().replace(/\s/g, '_')}.${round.type}`,
    context: {
      pair: round.pair,
      dex: round.dex,
      amount_usd: round.amount,
      gas_estimate_usd: round.gasUsd,
      spread_percent: round.spread,
      estimated_cost_usd: costEst,
      round: idx + 1,
    },
    idempotency_key: `defi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  });

  if (status === 200) {
    if (round.type === 'quote') {
      ok(`Price feed received — ${round.pair} in range`);
    } else {
      totalSwaps++;
      totalGas += round.gasUsd;
      const profit = round.spread > 0 ? (round.spread * round.amount / 100) : 0;
      ok(`Swap executed! Gas: $${round.gasUsd}${profit > 0 ? ` | Profit: $${profit.toFixed(2)}` : ''}`);
    }
  } else if (status === 402) {
    warn(`402 — Friction on $${round.amount} ${round.pair} swap (high cost)`);
    // DeFi bot pays friction automatically
    const txHash = '0x' + Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
    await http('POST', `/v1/workspaces/${wsId}/redeem`, {
      tx_hash: txHash, chain: 'bsc-testnet', action: `defi.swap`,
    });
    totalGas += round.gasUsd;
    ok(`Friction paid, swap proceeding`);
  } else if (status === 429) {
    fail(`🛑 BLOCKED — Storm detected! ${isPanic ? 'Panic selling stopped!' : 'Rate limited'}`);
    fail(`Governor: "${data.error || data.message || 'too many requests'}"`);
    totalBlocked++;
    gasSaved += round.gasUsd;
    slippageSaved += Math.abs(round.spread) * round.amount / 100;
    return 'blocked';
  }

  await sleep(isPanic ? 100 : 400); // Panic swaps are fast
  return 'ok';
}

async function main() {
  banner('DeFi Trading Bot — ProceedGate Demo');
  info('Use case: Arbitrage bot with per-swap cost gating and storm detection');
  info(`Governor: ${GOVERNOR_URL}`);

  await startLocalWorker();

  phase(1, 'Setup');
  await setupWorkspace();

  phase(2, 'Normal Trading');
  for (let i = 0; i < 5; i++) {
    await executeRound(ROUNDS[i], i);
    console.log();
  }

  phase(3, '⚡ Flash Crash — Bot Enters Panic Mode');
  console.log(`  ${c.red}${c.bold}  ┌─────────────────────────────────────────┐`);
  console.log(`  │ BNB drops 15% in 30 seconds!            │`);
  console.log(`  │ Bot starts panic-selling at any price... │`);
  console.log(`  └─────────────────────────────────────────┘${c.reset}\n`);

  let stormDetected = false;
  for (let i = 5; i < ROUNDS.length; i++) {
    const result = await executeRound(ROUNDS[i], i);
    console.log();
    if (result === 'blocked') {
      if (!stormDetected) {
        stormDetected = true;
        // Count remaining panic rounds as saved
        for (let j = i + 1; j < ROUNDS.length; j++) {
          if (ROUNDS[j].type === 'panic_swap') {
            gasSaved += ROUNDS[j].gasUsd;
            slippageSaved += Math.abs(ROUNDS[j].spread) * ROUNDS[j].amount / 100;
            totalBlocked++;
          }
        }
        money(`Storm detection kicked in! Remaining ${ROUNDS.length - i - 1} panic trades prevented.`);
        break;
      }
    }
  }

  phase(4, 'Summary');
  const totalSaved = gasSaved + slippageSaved;
  console.log(`
  ${c.bold}╔══════════════════════════════════════════════════╗
  ║   DeFi Trading Bot — Session Summary              ║
  ╠══════════════════════════════════════════════════╣${c.reset}
  ${c.green}  Swaps executed:      ${totalSwaps}${c.reset}
  ${c.red}  Trades blocked:      ${totalBlocked}${c.reset}
  ${c.yellow}  Gas spent:           $${totalGas.toFixed(2)}${c.reset}
  ${c.green}  Gas SAVED:           $${gasSaved.toFixed(2)}${c.reset}
  ${c.green}  Slippage SAVED:      $${slippageSaved.toFixed(2)}${c.reset}
  ${c.bold}${c.green}  Total SAVED:         $${totalSaved.toFixed(2)}${c.reset}
  ${c.bold}╚══════════════════════════════════════════════════╝${c.reset}

  ${c.dim}Without ProceedGate, the bot would have executed all ${ROUNDS.filter(r => r.type === 'panic_swap').length} panic trades
  during the flash crash, losing $${totalSaved.toFixed(2)} in gas + slippage.
  ProceedGate detected the swap storm and blocked after ~${totalSwaps + 1} trades.${c.reset}
  `);

  if (workerProc) workerProc.kill();
}

main().catch(err => { console.error(err); if (workerProc) workerProc.kill(); process.exit(1); });
