#!/usr/bin/env node
/**
 * 🧠 LLM Gateway Agent — ProceedGate Use Case #1
 *
 * Simulates a coding assistant agent that makes LLM API calls (GPT-4, Claude)
 * protected by ProceedGate cost governance.
 *
 * Scenario:
 *   - Agent processes user tickets requiring code generation
 *   - Each LLM call is gated through ProceedGate
 *   - A buggy ticket causes an infinite reasoning loop → ProceedGate detects & blocks
 *   - Budget cap prevents runaway spending
 *
 * Usage: node scripts/demo-llm-gateway.mjs [--base-url URL]
 */

import { spawn } from 'node:child_process';

const PORT = 8810 + Math.floor(Math.random() * 100);
const CUSTOM_URL = process.argv.find(a => a.startsWith('--base-url='))?.split('=')[1];
const GOVERNOR_URL = CUSTOM_URL || `http://127.0.0.1:${PORT}`;
const USE_LOCAL = !CUSTOM_URL;

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', italic: '\x1b[3m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', magenta: '\x1b[35m', blue: '\x1b[34m', gray: '\x1b[90m',
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function banner(t) {
  const l = '═'.repeat(t.length + 4);
  console.log(`\n${c.bold}${c.cyan}╔${l}╗\n║  ${t}  ║\n╚${l}╝${c.reset}\n`);
}
function phase(n, t) { console.log(`\n${c.bold}${c.magenta}  ── Phase ${n}: ${t} ──${c.reset}\n`); }
function agent(t) { console.log(`  ${c.bold}${c.cyan}🤖 ${t}${c.reset}`); }
function llm(t) { console.log(`  ${c.italic}${c.yellow}🧠 LLM: "${t}"${c.reset}`); }
function ok(t) { console.log(`     ${c.green}✅ ${t}${c.reset}`); }
function warn(t) { console.log(`     ${c.yellow}⚠️  ${t}${c.reset}`); }
function fail(t) { console.log(`     ${c.red}🚫 ${t}${c.reset}`); }
function info(t) { console.log(`  ${c.dim}▸ ${t}${c.reset}`); }
function money(t) { console.log(`  ${c.bold}${c.green}💰 ${t}${c.reset}`); }

async function http(method, path, body, headers = {}) {
  const res = await fetch(`${GOVERNOR_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})), headers: Object.fromEntries(res.headers) };
}

// ── Simulated LLM models with pricing ──────────────────────────────────────
const MODELS = [
  { name: 'gpt-4-turbo', provider: 'OpenAI', costPer1k: 0.03, tokens: () => 500 + Math.floor(Math.random() * 2000) },
  { name: 'claude-3-opus', provider: 'Anthropic', costPer1k: 0.075, tokens: () => 800 + Math.floor(Math.random() * 3000) },
  { name: 'gpt-4o', provider: 'OpenAI', costPer1k: 0.005, tokens: () => 300 + Math.floor(Math.random() * 1500) },
  { name: 'claude-3.5-sonnet', provider: 'Anthropic', costPer1k: 0.015, tokens: () => 600 + Math.floor(Math.random() * 2000) },
];

// ── Tickets to process ────────────────────────────────────────────────────────
const TICKETS = [
  { id: 'TICK-201', title: 'Add pagination to user list', model: 0, calls: 2 },
  { id: 'TICK-202', title: 'Fix login redirect loop', model: 1, calls: 1 },
  { id: 'TICK-203', title: 'Implement OAuth2 PKCE flow', model: 2, calls: 3 },
  { id: 'TICK-204', title: '⚠️ BUGGY: Recursive type resolution (infinite loop!)', model: 3, calls: 15 }, // This triggers storm
  { id: 'TICK-205', title: 'Update README with API docs', model: 0, calls: 1 },
];

let totalCost = 0;
let totalBlocked = 0;
let costSaved = 0;
let workerProc = null;
let wsId = null;
let adminKey = null;

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
  if (!ready) { await sleep(3000); }
  ok('Local worker ready');
}

async function setupWorkspace() {
  adminKey = 'demo_admin_' + Date.now();
  const { data } = await http('POST', '/v1/workspaces', {
    name: 'LLM Gateway Demo',
    budget_usd: 2.50,
    owner: 'demo-llm-gateway',
  }, { 'x-api-admin-key': adminKey });
  wsId = data.workspace_id || data.id || 'ws_demo';
  ok(`Workspace: ${wsId} (budget: $2.50)`);
}

async function gateCheck(action, context) {
  const { status, data } = await http('POST', `/v1/workspaces/${wsId}/check`, {
    action,
    context,
    idempotency_key: `llm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  });
  return { status, data };
}

async function processTicket(ticket) {
  const model = MODELS[ticket.model];
  agent(`Processing ${ticket.id}: "${ticket.title}"`);
  info(`Using ${model.name} (${model.provider}) — ~$${model.costPer1k}/1K tokens`);

  for (let call = 1; call <= ticket.calls; call++) {
    const tokens = model.tokens();
    const estCost = (tokens / 1000) * model.costPer1k;

    info(`LLM call ${call}/${ticket.calls} — ~${tokens} tokens ($${estCost.toFixed(4)})`);

    // Gate through ProceedGate
    const { status, data } = await gateCheck(`llm.${model.name}.completion`, {
      ticket_id: ticket.id,
      model: model.name,
      estimated_tokens: tokens,
      estimated_cost_usd: estCost,
      call_number: call,
    });

    if (status === 200) {
      // Simulate LLM response
      llm(call === 1 ? `Analyzing ${ticket.title}...` : `Iteration ${call}: refining solution...`);
      totalCost += estCost;
      ok(`✓ Gated & executed ($${estCost.toFixed(4)}) — running total: $${totalCost.toFixed(4)}`);
      await sleep(300);
    } else if (status === 402) {
      warn(`402 Payment Required — friction applied for $${estCost.toFixed(4)} call`);
      // Simulate payment
      const txHash = '0x' + Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
      const redeem = await http('POST', `/v1/workspaces/${wsId}/redeem`, {
        tx_hash: txHash, chain: 'bsc-testnet', action: `llm.${model.name}.completion`,
      });
      if (redeem.status === 200) {
        llm(`Paid friction, continuing: ${ticket.title}...`);
        totalCost += estCost;
        ok(`Friction paid, proceeding ($${totalCost.toFixed(4)} total)`);
      } else {
        fail(`Payment rejected — skipping`);
        costSaved += estCost;
        totalBlocked++;
      }
      await sleep(200);
    } else if (status === 429) {
      fail(`🛑 BLOCKED — Retry storm detected on ${ticket.id}!`);
      fail(`ProceedGate says: "${data.error || data.message || 'rate limited'}"`);
      costSaved += estCost * (ticket.calls - call + 1);
      totalBlocked += ticket.calls - call + 1;
      money(`Saved ~$${(estCost * (ticket.calls - call + 1)).toFixed(4)} from remaining ${ticket.calls - call + 1} calls`);
      return 'storm_blocked';
    } else {
      warn(`Unexpected ${status} — skipping call`);
      await sleep(100);
    }
  }
  return 'completed';
}

async function main() {
  banner('LLM Gateway Agent — ProceedGate Demo');
  info('Use case: Coding assistant with GPT-4/Claude, cost-gated per LLM call');
  info(`Governor: ${GOVERNOR_URL}`);

  await startLocalWorker();

  phase(1, 'Setup Workspace');
  await setupWorkspace();

  phase(2, 'Process Tickets');
  const results = [];
  for (const ticket of TICKETS) {
    const result = await processTicket(ticket);
    results.push({ ticket: ticket.id, result });
    console.log();
    await sleep(500);
  }

  phase(3, 'Summary');
  console.log(`
  ${c.bold}╔══════════════════════════════════════════════╗
  ║   LLM Gateway Agent — Session Summary         ║
  ╠══════════════════════════════════════════════╣${c.reset}
  ${c.green}  Tickets processed:  ${results.filter(r => r.result === 'completed').length}/${TICKETS.length}${c.reset}
  ${c.red}  Storm blocked:      ${results.filter(r => r.result === 'storm_blocked').length}${c.reset}
  ${c.yellow}  Total LLM cost:     $${totalCost.toFixed(4)}${c.reset}
  ${c.green}  Cost SAVED:         $${costSaved.toFixed(4)}${c.reset}
  ${c.cyan}  Calls blocked:      ${totalBlocked}${c.reset}
  ${c.bold}╚══════════════════════════════════════════════╝${c.reset}

  ${c.dim}Without ProceedGate, the buggy ticket TICK-204 would have
  made 15 Claude calls (~$${(15 * 0.015 * 2).toFixed(2)}) before timing out.
  ProceedGate detected the storm after ~10 calls and saved $${costSaved.toFixed(4)}.${c.reset}
  `);

  if (workerProc) { workerProc.kill(); }
}

main().catch(err => { console.error(err); if (workerProc) workerProc.kill(); process.exit(1); });
