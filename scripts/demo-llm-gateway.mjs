#!/usr/bin/env node
/**
 * 🧠 LLM Gateway Agent — ProceedGate Use Case #1
 *
 * Simulates a coding assistant agent that makes LLM API calls (GPT-4, Claude)
 * protected by ProceedGate cost governance.
 *
 * Scenario:
 *   - Agent processes user tickets requiring code generation
 *   - Each LLM call is gated through ProceedGate (/v1/governor/check)
 *   - A buggy ticket causes an infinite reasoning loop → ProceedGate detects & blocks
 *   - Budget cap prevents runaway spending
 *
 * Usage: node scripts/demo-llm-gateway.mjs
 */

import { spawn } from 'node:child_process';

const PORT = 8810 + Math.floor(Math.random() * 100);
const GOVERNOR_URL = `http://127.0.0.1:${PORT}`;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

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

async function httpJson(method, path, body, headers = {}) {
  const res = await fetch(`${GOVERNOR_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, headers: Object.fromEntries(res.headers), json, text };
}

async function waitForHealth(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error(`Worker did not start within ${timeoutMs}ms`);
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
  { id: 'TICK-204', title: '⚠️ BUGGY: Recursive type resolution (infinite loop!)', model: 3, calls: 15 }, // triggers storm
  { id: 'TICK-205', title: 'Update README with API docs', model: 0, calls: 1 },
];

let AUTH = {};
let totalCost = 0;
let totalBlocked = 0;
let costSaved = 0;

async function gateCheck(action, context) {
  const { status, json } = await httpJson('POST', '/v1/governor/check', {
    policy_id: 'retry_friction_v1',
    action,
    actor: { id: 'llm-gateway-agent', project: 'llm-demo' },
    context,
  }, AUTH);
  return { status, data: json || {} };
}

async function processTicket(ticket) {
  const model = MODELS[ticket.model];
  agent(`Processing ${ticket.id}: "${ticket.title}"`);
  info(`Using ${model.name} (${model.provider}) — ~$${model.costPer1k}/1K tokens`);

  for (let call = 1; call <= ticket.calls; call++) {
    const tokens = model.tokens();
    const estCost = (tokens / 1000) * model.costPer1k;

    info(`LLM call ${call}/${ticket.calls} — ~${tokens} tokens ($${estCost.toFixed(4)})`);

    // Use same task_hash for same ticket → loop detection triggers on repeated calls
    const taskHash = `ticket-${ticket.id}`;
    const stepHash = ticket.calls > 5 ? taskHash : `call-${call}`; // buggy ticket: same step = same pattern → storm

    const { status, data } = await gateCheck('model_call', {
      attempt_in_window: call,
      window_seconds: 60,
      task_hash: taskHash,
      step_hash: stepHash,
      context_hash: `ctx-${ticket.id}-${call}`,
      tool: model.name,
    });

    if (status === 200) {
      llm(call === 1 ? `Analyzing ${ticket.title}...` : `Iteration ${call}: refining solution...`);
      totalCost += estCost;
      ok(`✓ Gated & executed ($${estCost.toFixed(4)}) — running total: $${totalCost.toFixed(4)}`);
      await sleep(150);
    } else if (status === 402) {
      warn(`402 Payment Required — friction applied for $${estCost.toFixed(4)} call`);
      const txHash = '0xstub:llm-demo-' + Date.now();
      const decisionId = data?.decision_id;
      if (decisionId) {
        const redeem = await httpJson('POST', '/v1/governor/redeem', {
          decision_id: decisionId,
        }, { ...AUTH, 'x402-tx-hash': txHash });
        if (redeem.status === 200) {
          llm(`Paid friction, continuing: ${ticket.title}...`);
          totalCost += estCost;
          ok(`Friction paid — proceeding ($${totalCost.toFixed(4)} total)`);
        } else {
          fail(`Redeem rejected (${redeem.status})`);
          costSaved += estCost;
          totalBlocked++;
        }
      } else {
        fail(`No decision_id — skipping`);
        costSaved += estCost;
        totalBlocked++;
      }
      await sleep(100);
    } else if (status === 429) {
      fail(`🛑 BLOCKED — Retry storm detected on ${ticket.id}!`);
      fail(`ProceedGate says: "${data?.error || data?.reason || 'loop_detected'}"`);
      const remaining = ticket.calls - call + 1;
      costSaved += estCost * remaining;
      totalBlocked += remaining;
      money(`Saved ~$${(estCost * remaining).toFixed(4)} from remaining ${remaining} calls`);
      return 'storm_blocked';
    } else {
      warn(`Unexpected ${status}: ${JSON.stringify(data)}`);
      await sleep(100);
    }
  }
  return 'completed';
}

async function main() {
  banner('LLM Gateway Agent — ProceedGate Demo');
  info('Use case: Coding assistant with GPT-4/Claude, cost-gated per LLM call');
  info(`Governor: ${GOVERNOR_URL}\n`);

  // ── Start local worker ──
  info('Starting ProceedGate Governor...');
  const worker = spawn(npm, [
    '--workspace', 'worker', 'run', 'dev', '--',
    '--env', 'billing', '--local', '--port', String(PORT),
  ], {
    stdio: 'ignore',
    shell: process.platform === 'win32',
    env: process.env,
  });

  try {
    await waitForHealth(`${GOVERNOR_URL}/health`);
    ok(`Governor running on port ${PORT}`);
    await sleep(400);

    // ── Create workspace ──
    phase(1, 'Setup Workspace');
    const ws = await httpJson('POST', '/v1/workspaces/create',
      { workspace_id: 'llm-demo' },
      { 'x-admin-key': 'dev-admin-key' },
    );
    const apiKey = ws.json?.api_key ?? '';
    if (apiKey) {
      AUTH = { authorization: `Bearer ${apiKey}` };
      ok('Workspace created, API key obtained');
    } else {
      warn(`Workspace response: ${JSON.stringify(ws.json)}`);
    }

    // Add credits
    const quote = await httpJson('POST', '/v1/billing/quote',
      { workspace_id: 'llm-demo', credits: 50 }, AUTH);
    const quoteId = quote.json?.quote_id;
    if (quoteId) {
      await httpJson('POST', '/v1/billing/redeem',
        { quote_id: quoteId, tx_hash: `0xstub:llm-demo-${quoteId}` }, AUTH);
      ok('50 credits loaded into workspace');
    }
    await sleep(400);

    // ── Process Tickets ──
    phase(2, 'Process Tickets');
    const results = [];
    for (const ticket of TICKETS) {
      const result = await processTicket(ticket);
      results.push({ ticket: ticket.id, result });
      console.log();
      await sleep(300);
    }

    // ── Summary ──
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
  } finally {
    try { worker.kill('SIGINT'); } catch {}
    await sleep(500);
    if (process.platform === 'win32' && worker.pid) {
      try { spawn('taskkill', ['/PID', String(worker.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
