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
 * Usage: node scripts/demo-multi-agent.mjs
 */

import { spawn } from 'node:child_process';

const PORT = 8830 + Math.floor(Math.random() * 100);
const GOVERNOR_URL = `http://127.0.0.1:${PORT}`;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

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

async function httpJson(method, path, body, headers = {}) {
  const res = await fetch(`${GOVERNOR_URL}${path}`, {
    method, headers: { 'content-type': 'application/json', ...headers },
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

// ── Task pipeline ──────────────────────────────────────────────────────────
const PIPELINE = [
  // Research phase (normal) — different queries → different hashes
  { agent: 'researcher', tool: 'serpapi.search', desc: 'Search "AI agent cost overruns 2025"', cost: 0.005, query: 'ai-cost-overruns' },
  { agent: 'researcher', tool: 'tavily.search', desc: 'Search "LLM retry storm real examples"', cost: 0.01, query: 'retry-storms' },
  { agent: 'researcher', tool: 'serpapi.search', desc: 'Search "runaway AI agent AWS bill"', cost: 0.005, query: 'runaway-bill' },

  // Analysis phase — different steps
  { agent: 'analyst', tool: 'openai.gpt4.completion', desc: 'Analyze search results, extract patterns', cost: 0.08, query: 'analysis-1' },
  { agent: 'analyst', tool: 'openai.gpt4.completion', desc: 'Cross-reference with cost databases', cost: 0.06, query: 'analysis-2' },

  // Writing phase
  { agent: 'writer', tool: 'anthropic.claude3.completion', desc: 'Draft report introduction', cost: 0.04, query: 'write-intro' },
  { agent: 'writer', tool: 'anthropic.claude3.completion', desc: 'Write main body (3 sections)', cost: 0.12, query: 'write-body' },
  { agent: 'writer', tool: 'anthropic.claude3.completion', desc: 'Generate executive summary', cost: 0.03, query: 'write-summary' },

  // Review phase
  { agent: 'reviewer', tool: 'openai.gpt4o.completion', desc: 'Review factual accuracy', cost: 0.02, query: 'review-facts' },
  { agent: 'reviewer', tool: 'openai.gpt4o.completion', desc: 'Check tone and clarity', cost: 0.015, query: 'review-tone' },

  // ⚠️ Researcher BUG: enters search loop (ALL same query → same hash → STORM)
  { agent: 'researcher', tool: 'serpapi.search', desc: '⚠️ BUG: Re-searching "AI agent cost" (disambiguation loop)', cost: 0.005, query: 'ai-agent-cost-LOOP' },
  { agent: 'researcher', tool: 'serpapi.search', desc: '⚠️ BUG: Re-searching "AI agent cost" (attempt 2)', cost: 0.005, query: 'ai-agent-cost-LOOP' },
  { agent: 'researcher', tool: 'serpapi.search', desc: '⚠️ BUG: Re-searching "AI agent cost" (attempt 3)', cost: 0.005, query: 'ai-agent-cost-LOOP' },
  { agent: 'researcher', tool: 'serpapi.search', desc: '⚠️ BUG: Re-searching "AI agent cost" (attempt 4)', cost: 0.005, query: 'ai-agent-cost-LOOP' },
  { agent: 'researcher', tool: 'serpapi.search', desc: '⚠️ BUG: Re-searching "AI agent cost" (attempt 5)', cost: 0.005, query: 'ai-agent-cost-LOOP' },
  { agent: 'researcher', tool: 'serpapi.search', desc: '⚠️ BUG: Re-searching "AI agent cost" (attempt 6)', cost: 0.005, query: 'ai-agent-cost-LOOP' },
  { agent: 'researcher', tool: 'serpapi.search', desc: '⚠️ BUG: Re-searching "AI agent cost" (attempt 7)', cost: 0.005, query: 'ai-agent-cost-LOOP' },
  { agent: 'researcher', tool: 'serpapi.search', desc: '⚠️ BUG: Re-searching "AI agent cost" (attempt 8)', cost: 0.005, query: 'ai-agent-cost-LOOP' },
  { agent: 'researcher', tool: 'serpapi.search', desc: '⚠️ BUG: Re-searching "AI agent cost" (attempt 9)', cost: 0.005, query: 'ai-agent-cost-LOOP' },
  { agent: 'researcher', tool: 'serpapi.search', desc: '⚠️ BUG: Re-searching "AI agent cost" (attempt 10)', cost: 0.005, query: 'ai-agent-cost-LOOP' },
  { agent: 'researcher', tool: 'serpapi.search', desc: '⚠️ BUG: Re-searching "AI agent cost" (attempt 11)', cost: 0.005, query: 'ai-agent-cost-LOOP' },
  { agent: 'researcher', tool: 'serpapi.search', desc: '⚠️ BUG: Re-searching "AI agent cost" (attempt 12)', cost: 0.005, query: 'ai-agent-cost-LOOP' },
];

let stats = { allowed: 0, friction: 0, blocked: 0, totalCost: 0, costSaved: 0 };
let AUTH = {};

async function executeStep(step, idx) {
  agentLog(step.agent, step.desc);
  info(`Tool: ${step.tool} | Est. cost: $${step.cost.toFixed(3)}`);

  // For bug steps: same task_hash AND step_hash → loop detection triggers
  const isBugLoop = step.query === 'ai-agent-cost-LOOP';
  const taskHash = isBugLoop ? 'research-loop-bug' : `pipeline-${step.query}`;
  const stepHash = isBugLoop ? 'research-loop-bug' : `step-${step.query}`;

  const { status, json: data } = await httpJson('POST', '/v1/governor/check', {
    policy_id: 'retry_friction_v1',
    action: step.agent === 'researcher' ? 'tool_call' : 'model_call',
    actor: { id: `${step.agent}-agent`, project: 'multi-agent-demo' },
    context: {
      attempt_in_window: idx + 1,
      window_seconds: 60,
      task_hash: taskHash,
      step_hash: stepHash,
      context_hash: `ctx-${step.query}-${idx}`,
      tool: step.tool,
    },
  }, AUTH);

  if (status === 200) {
    stats.allowed++;
    stats.totalCost += step.cost;
    ok(`Allowed — $${step.cost.toFixed(3)} (total: $${stats.totalCost.toFixed(3)})`);
    return 'allowed';
  } else if (status === 402) {
    stats.friction++;
    warn(`402 Friction — requires payment for $${step.cost.toFixed(3)}`);
    const txHash = '0xstub:multi-demo-' + Date.now();
    const decisionId = data?.decision_id;
    if (decisionId) {
      await httpJson('POST', '/v1/governor/redeem', { decision_id: decisionId }, { ...AUTH, 'x402-tx-hash': txHash });
    }
    stats.totalCost += step.cost;
    ok(`Friction paid, proceeding`);
    return 'friction';
  } else if (status === 429) {
    stats.blocked++;
    stats.costSaved += step.cost;
    fail(`BLOCKED — ${data?.error || data?.reason || 'loop_detected'}`);
    return 'blocked';
  }
  warn(`Unexpected ${status}: ${JSON.stringify(data)}`);
  return 'unknown';
}

async function main() {
  banner('Multi-Agent Pipeline — ProceedGate Demo');
  info('Use case: CrewAI-style pipeline (Researcher → Analyst → Writer → Reviewer)');
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

    phase(1, 'Setup');
    const ws = await httpJson('POST', '/v1/workspaces/create',
      { workspace_id: 'multi-agent-demo' },
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
      { workspace_id: 'multi-agent-demo', credits: 50 }, AUTH);
    const quoteId = quote.json?.quote_id;
    if (quoteId) {
      await httpJson('POST', '/v1/billing/redeem',
        { quote_id: quoteId, tx_hash: `0xstub:multi-demo-${quoteId}` }, AUTH);
      ok('50 credits loaded');
    }
    await sleep(400);

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

    for (let i = 10; i < PIPELINE.length; i++) {
      const result = await executeStep(PIPELINE[i], i);
      if (result === 'blocked') {
        for (let j = i + 1; j < PIPELINE.length; j++) {
          stats.costSaved += PIPELINE[j].cost;
          stats.blocked++;
        }
        money(`Loop detected! ${PIPELINE.length - i - 1} remaining searches prevented.`);
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
  } finally {
    try { worker.kill('SIGINT'); } catch {}
    await sleep(500);
    if (process.platform === 'win32' && worker.pid) {
      try { spawn('taskkill', ['/PID', String(worker.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });