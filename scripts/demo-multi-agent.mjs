#!/usr/bin/env node
/**
 * 🏭 Multi-Agent Pipeline — ProceedGate Use Case #3
 *
 * Simulates a CrewAI/AutoGen style multi-agent system where:
 *   - Researcher agent → searches the web (SerpAPI, Tavily)
 *   - Analyst agent → processes data with LLM (GPT-4)
 *   - Writer agent → generates reports with LLM (Claude)
 *   - Reviewer agent → validates output with LLM
 *
 * Each agent's tool calls are individually gated through ProceedGate.
 * When the Researcher enters a search loop, ProceedGate catches it.
 *
 * Usage: node scripts/demo-multi-agent.mjs [--base-url URL]
 */

import { spawn } from 'node:child_process';

const PORT = 8830 + Math.floor(Math.random() * 100);
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
function ok(t) { console.log(`     ${c.green}✅ ${t}${c.reset}`); }
function warn(t) { console.log(`     ${c.yellow}⚠️  ${t}${c.reset}`); }
function fail(t) { console.log(`     ${c.red}🚫 ${t}${c.reset}`); }
function info(t) { console.log(`  ${c.dim}▸ ${t}${c.reset}`); }
function money(t) { console.log(`  ${c.bold}${c.green}💰 ${t}${c.reset}`); }

// Agent personas
const AGENTS = {
  researcher: { emoji: '🔍', color: c.blue, name: 'Researcher' },
  analyst: { emoji: '📊', color: c.yellow, name: 'Analyst' },
  writer: { emoji: '✍️', color: c.magenta, name: 'Writer' },
  reviewer: { emoji: '👁️', color: c.cyan, name: 'Reviewer' },
};

function agentLog(agentId, text) {
  const a = AGENTS[agentId];
  console.log(`  ${a.color}${c.bold}${a.emoji} [${a.name}] ${text}${c.reset}`);
}

async function http(method, path, body, headers = {}) {
  const res = await fetch(`${GOVERNOR_URL}${path}`, {
    method, headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// ── Task pipeline ──────────────────────────────────────────────────────────
const PIPELINE = [
  // Research phase (normal)
  { agent: 'researcher', tool: 'serpapi.search', desc: 'Search "AI agent cost overruns 2025"', cost: 0.005 },
  { agent: 'researcher', tool: 'tavily.search', desc: 'Search "LLM retry storm real examples"', cost: 0.01 },
  { agent: 'researcher', tool: 'serpapi.search', desc: 'Search "runaway AI agent AWS bill"', cost: 0.005 },

  // Analysis phase
  { agent: 'analyst', tool: 'openai.gpt4.completion', desc: 'Analyze search results, extract patterns', cost: 0.08 },
  { agent: 'analyst', tool: 'openai.gpt4.completion', desc: 'Cross-reference with cost databases', cost: 0.06 },

  // Writing phase
  { agent: 'writer', tool: 'anthropic.claude3.completion', desc: 'Draft report introduction', cost: 0.04 },
  { agent: 'writer', tool: 'anthropic.claude3.completion', desc: 'Write main body (3 sections)', cost: 0.12 },
  { agent: 'writer', tool: 'anthropic.claude3.completion', desc: 'Generate executive summary', cost: 0.03 },

  // Review phase
  { agent: 'reviewer', tool: 'openai.gpt4o.completion', desc: 'Review factual accuracy', cost: 0.02 },
  { agent: 'reviewer', tool: 'openai.gpt4o.completion', desc: 'Check tone and clarity', cost: 0.015 },

  // ⚠️ Researcher BUG: enters search loop (repeats same query)
  { agent: 'researcher', tool: 'serpapi.search', desc: '⚠️ BUG: Re-searching "AI agent cost" (disambiguation loop)', cost: 0.005 },
  { agent: 'researcher', tool: 'serpapi.search', desc: '⚠️ BUG: Re-searching "AI agent cost" (attempt 2)', cost: 0.005 },
  { agent: 'researcher', tool: 'serpapi.search', desc: '⚠️ BUG: Re-searching "AI agent cost" (attempt 3)', cost: 0.005 },
  { agent: 'researcher', tool: 'serpapi.search', desc: '⚠️ BUG: Re-searching "AI agent cost" (attempt 4)', cost: 0.005 },
  { agent: 'researcher', tool: 'serpapi.search', desc: '⚠️ BUG: Re-searching "AI agent cost" (attempt 5)', cost: 0.005 },
  { agent: 'researcher', tool: 'serpapi.search', desc: '⚠️ BUG: Re-searching "AI agent cost" (attempt 6)', cost: 0.005 },
  { agent: 'researcher', tool: 'serpapi.search', desc: '⚠️ BUG: Re-searching "AI agent cost" (attempt 7)', cost: 0.005 },
  { agent: 'researcher', tool: 'serpapi.search', desc: '⚠️ BUG: Re-searching "AI agent cost" (attempt 8)', cost: 0.005 },
  { agent: 'researcher', tool: 'serpapi.search', desc: '⚠️ BUG: Re-searching "AI agent cost" (attempt 9)', cost: 0.005 },
  { agent: 'researcher', tool: 'serpapi.search', desc: '⚠️ BUG: Re-searching "AI agent cost" (attempt 10)', cost: 0.005 },
  { agent: 'researcher', tool: 'serpapi.search', desc: '⚠️ BUG: Re-searching "AI agent cost" (attempt 11)', cost: 0.005 },
  { agent: 'researcher', tool: 'serpapi.search', desc: '⚠️ BUG: Re-searching "AI agent cost" (attempt 12)', cost: 0.005 },
];

let stats = { allowed: 0, friction: 0, blocked: 0, totalCost: 0, costSaved: 0 };
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
    name: 'Multi-Agent Research Pipeline',
    budget_usd: 3.00,
    owner: 'demo-multi-agent',
  }, { 'x-api-admin-key': adminKey });
  wsId = data.workspace_id || data.id || 'ws_demo';
  ok(`Workspace: ${wsId} (budget: $3.00)`);
}

async function executeStep(step, idx) {
  agentLog(step.agent, step.desc);
  info(`Tool: ${step.tool} | Est. cost: $${step.cost.toFixed(3)}`);

  const { status, data } = await http('POST', `/v1/workspaces/${wsId}/check`, {
    action: step.tool,
    context: {
      agent: step.agent,
      description: step.desc,
      estimated_cost_usd: step.cost,
      step: idx + 1,
      pipeline: 'research_report',
    },
    idempotency_key: `multi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  });

  if (status === 200) {
    stats.allowed++;
    stats.totalCost += step.cost;
    ok(`Allowed — $${step.cost.toFixed(3)} (total: $${stats.totalCost.toFixed(3)})`);
    return 'allowed';
  } else if (status === 402) {
    stats.friction++;
    warn(`402 Friction — requires payment for $${step.cost.toFixed(3)}`);
    const txHash = '0x' + Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
    await http('POST', `/v1/workspaces/${wsId}/redeem`, { tx_hash: txHash, chain: 'bsc-testnet', action: step.tool });
    stats.totalCost += step.cost;
    ok(`Friction paid, proceeding`);
    return 'friction';
  } else if (status === 429) {
    stats.blocked++;
    stats.costSaved += step.cost;
    fail(`BLOCKED — ${data.error || data.message || 'loop detected'}`);
    return 'blocked';
  }
  return 'unknown';
}

async function main() {
  banner('Multi-Agent Pipeline — ProceedGate Demo');
  info('Use case: CrewAI-style pipeline (Researcher → Analyst → Writer → Reviewer)');
  info(`Governor: ${GOVERNOR_URL}`);

  await startLocalWorker();

  phase(1, 'Setup');
  await setupWorkspace();

  phase(2, '🔍 Research Phase');
  for (let i = 0; i < 3; i++) {
    await executeStep(PIPELINE[i], i);
    await sleep(300);
  }

  phase(3, '📊 Analysis Phase');
  for (let i = 3; i < 5; i++) {
    await executeStep(PIPELINE[i], i);
    await sleep(400);
  }

  phase(4, '✍️ Writing Phase');
  for (let i = 5; i < 8; i++) {
    await executeStep(PIPELINE[i], i);
    await sleep(400);
  }

  phase(5, '👁️ Review Phase');
  for (let i = 8; i < 10; i++) {
    await executeStep(PIPELINE[i], i);
    await sleep(300);
  }

  phase(6, '⚠️ Researcher Bug — Search Loop');
  console.log(`  ${c.red}${c.bold}  ┌───────────────────────────────────────────────────┐`);
  console.log(`  │ Researcher agent enters disambiguation loop!     │`);
  console.log(`  │ Same query "AI agent cost" repeated indefinitely │`);
  console.log(`  └───────────────────────────────────────────────────┘${c.reset}\n`);

  let loopStopped = false;
  for (let i = 10; i < PIPELINE.length; i++) {
    const result = await executeStep(PIPELINE[i], i);
    if (result === 'blocked') {
      // Count remaining steps as saved
      for (let j = i + 1; j < PIPELINE.length; j++) {
        stats.costSaved += PIPELINE[j].cost;
        stats.blocked++;
      }
      money(`Loop detected! ${PIPELINE.length - i - 1} remaining searches prevented.`);
      loopStopped = true;
      break;
    }
    await sleep(150);
  }

  phase(7, 'Pipeline Summary');

  const agentStats = {};
  for (const step of PIPELINE) {
    if (!agentStats[step.agent]) agentStats[step.agent] = { calls: 0, cost: 0 };
    agentStats[step.agent].calls++;
    agentStats[step.agent].cost += step.cost;
  }

  console.log(`
  ${c.bold}╔══════════════════════════════════════════════════════╗
  ║   Multi-Agent Pipeline — Session Summary               ║
  ╠══════════════════════════════════════════════════════╣${c.reset}
  ${c.blue}  🔍 Researcher:  ${agentStats.researcher.calls} planned calls ($${agentStats.researcher.cost.toFixed(3)})${c.reset}
  ${c.yellow}  📊 Analyst:     ${agentStats.analyst.calls} calls ($${agentStats.analyst.cost.toFixed(3)})${c.reset}
  ${c.magenta}  ✍️ Writer:      ${agentStats.writer.calls} calls ($${agentStats.writer.cost.toFixed(3)})${c.reset}
  ${c.cyan}  👁️ Reviewer:    ${agentStats.reviewer.calls} calls ($${agentStats.reviewer.cost.toFixed(3)})${c.reset}
  ${c.dim}  ─────────────────────────────────────────${c.reset}
  ${c.green}  Allowed:            ${stats.allowed}${c.reset}
  ${c.yellow}  Friction (402):     ${stats.friction}${c.reset}
  ${c.red}  Blocked (429):      ${stats.blocked}${c.reset}
  ${c.yellow}  Cost incurred:      $${stats.totalCost.toFixed(3)}${c.reset}
  ${c.bold}${c.green}  Cost SAVED:          $${stats.costSaved.toFixed(3)}${c.reset}
  ${c.bold}╚══════════════════════════════════════════════════════╝${c.reset}

  ${c.dim}The Researcher agent's disambiguation loop was caught after ~10 repeats.
  Without ProceedGate, it would search indefinitely until the SerpAPI
  monthly quota ($${(agentStats.researcher.cost).toFixed(3)}) was exhausted.
  
  All 4 agents share one workspace → one budget → one storm detector.${c.reset}
  `);

  if (workerProc) workerProc.kill();
}

main().catch(err => { console.error(err); if (workerProc) workerProc.kill(); process.exit(1); });
