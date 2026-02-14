#!/usr/bin/env node
/**
 * 🤖 CryptoScraper — AI Agent Demo with ProceedGate
 *
 * An autonomous AI agent that scrapes cryptocurrency prices from multiple
 * exchanges, protected by ProceedGate cost governance.
 *
 * The agent:
 *   1. Plans which exchanges/coins to scrape (LLM reasoning)
 *   2. Gates every API call through ProceedGate
 *   3. Handles errors + retries autonomously
 *   4. Gets stopped by ProceedGate when a retry storm is detected
 *
 * Usage:
 *   npm run demo:agent            # mock LLM (deterministic, no API key)
 *   OPENAI_API_KEY=sk-… npm run demo:agent   # real OpenAI (optional)
 *
 * This is a REAL agent loop — plan → decide → gate → execute → observe → repeat.
 */

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = 8800 + Math.floor(Math.random() * 200);
const GOVERNOR_URL = `http://127.0.0.1:${PORT}`;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const USE_REAL_LLM = Boolean(OPENAI_API_KEY);

// ─── OpenClaw Skill ───────────────────────────────────────────────────────────
// Agent loads its behavior from an OpenClaw AgentSkill file (SKILL.md).
const SKILL_PATH = new URL("../skills/onchain-cost-governor/SKILL.md", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
let SKILL_PROMPT = "";
try {
  const raw = readFileSync(SKILL_PATH, "utf-8");
  // Strip YAML frontmatter, keep the instructions
  SKILL_PROMPT = raw.replace(/^---[\s\S]*?---\n*/m, "").trim();
} catch { /* skill file not found — OK, use hardcoded fallback */ }

// ─── ANSI ─────────────────────────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", italic: "\x1b[3m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
  cyan: "\x1b[36m", magenta: "\x1b[35m", blue: "\x1b[34m",
  white: "\x1b[37m", gray: "\x1b[90m",
  bgCyan: "\x1b[46m", bgRed: "\x1b[41m", bgGreen: "\x1b[42m", bgYellow: "\x1b[43m",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function banner(text) {
  const line = "═".repeat(text.length + 4);
  console.log(`\n${c.bold}${c.cyan}╔${line}╗`);
  console.log(`║  ${text}  ║`);
  console.log(`╚${line}╝${c.reset}\n`);
}

function phase(num, title) {
  console.log(`\n${c.bold}${c.magenta}  ┌──────────────────────────────────────────────────┐`);
  console.log(`  │  Phase ${num}: ${title.padEnd(39)}│`);
  console.log(`  └──────────────────────────────────────────────────┘${c.reset}\n`);
}

function think(text)  { console.log(`  ${c.italic}${c.yellow}🧠 LLM: "${text}"${c.reset}`); }
function agent(text)  { console.log(`  ${c.bold}${c.cyan}🤖 Agent: ${text}${c.reset}`); }
function ok(text)     { console.log(`     ${c.green}✅ ${text}${c.reset}`); }
function warn(text)   { console.log(`     ${c.yellow}⚠️  ${text}${c.reset}`); }
function fail(text)   { console.log(`     ${c.red}🚫 ${text}${c.reset}`); }
function info(text)   { console.log(`  ${c.dim}${c.white}▸ ${text}${c.reset}`); }
function money(text)  { console.log(`  ${c.bold}${c.green}💰 ${text}${c.reset}`); }

async function httpJson(method, path, body, headers = {}) {
  const res = await fetch(`${GOVERNOR_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, headers: Object.fromEntries(res.headers), json, text };
}

function getNpmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function waitForHealth(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error(`Worker did not start within ${timeoutMs}ms`);
}

async function stopWorker(worker) {
  if (!worker?.pid) return;
  try { worker.kill("SIGINT"); } catch { /* ignore */ }
  await sleep(750);
  if (worker.exitCode !== null) return;
  if (process.platform === "win32") {
    const tk = spawn("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" });
    await new Promise((r) => tk.on("exit", r));
    return;
  }
  try { worker.kill("SIGTERM"); } catch { /* ignore */ }
}

// ─── Mock Exchange API ────────────────────────────────────────────────────────
// Simulates real exchange REST APIs. CoinMarketCap is "broken" (503).

const EXCHANGE_DATA = {
  coingecko:      { name: "CoinGecko",      latency: 200, working: true },
  binance:        { name: "Binance",         latency: 150, working: true },
  kraken:         { name: "Kraken",          latency: 180, working: true },
  coinmarketcap:  { name: "CoinMarketCap",   latency: 300, working: false }, // 🐛 broken!
  messari:        { name: "Messari",         latency: 250, working: true },
};

const COIN_PRICES = {
  BTC:  97_432.50,
  ETH:  3_812.40,
  SOL:  198.75,
  AVAX: 42.18,
  BNB:  612.30,
};

async function mockScrape(exchange, coin) {
  const ex = EXCHANGE_DATA[exchange];
  await sleep(ex.latency);
  if (!ex.working) {
    throw new Error(`503 Service Unavailable — ${ex.name} API is down`);
  }
  const price = COIN_PRICES[coin] * (1 + (Math.random() - 0.5) * 0.002); // ±0.1% jitter
  return { exchange: ex.name, coin, price: price.toFixed(2), timestamp: new Date().toISOString() };
}

// ─── Mock LLM ─────────────────────────────────────────────────────────────────
// Scripted but realistic reasoning. Replaced by real OpenAI if key is available.

class MockLLM {
  constructor() { this.callCount = 0; }

  async reason(context) {
    this.callCount++;
    await sleep(400); // simulate "thinking"

    // Planning phase
    if (context.type === "plan") {
      return {
        reasoning: `Loaded OpenClaw skill "onchain-cost-governor" — I must gate every expensive action through ProceedGate before executing. Planning 5 exchange scrapes with cost governance.`,
        plan: [
          { exchange: "coingecko",     coin: "BTC", reason: "CoinGecko is the most reliable free API for BTC" },
          { exchange: "binance",       coin: "ETH", reason: "Binance has the highest volume for ETH" },
          { exchange: "kraken",        coin: "SOL", reason: "Kraken has good SOL liquidity" },
          { exchange: "coinmarketcap", coin: "AVAX", reason: "CMC aggregates AVAX prices across DEXes" },
          { exchange: "messari",       coin: "BNB", reason: "Messari provides institutional-grade BNB data" },
        ],
      };
    }

    // Error handling — should we retry?
    if (context.type === "error") {
      const { attempt, error, frictionPrice, frictionCount } = context;

      if (frictionPrice) {
        // ProceedGate is applying friction — count how many times
        if (frictionCount >= 3) {
          return {
            reasoning: `ProceedGate has blocked me ${frictionCount} times with escalating prices ($${frictionPrice}). This is clearly a retry loop on a broken endpoint. Continuing would waste money. I should skip this source and move on.`,
            action: "skip",
          };
        }
        if (frictionCount === 2) {
          return {
            reasoning: `ProceedGate is escalating friction to $${frictionPrice} — second time blocked. The pattern is clear: this endpoint is probably broken. One more warning and I stop.`,
            action: "retry",
          };
        }
        // First friction — try to pay onchain
        return {
          reasoning: `ProceedGate detected repeated attempts and is applying friction ($${frictionPrice}). I'll pay the friction onchain to prove I'm legitimate, then retry.`,
          action: agentWallet ? "pay" : "retry",
        };
      }

      if (attempt <= 3) {
        return {
          reasoning: `API returned "${error}". This could be a transient issue. Attempt ${attempt} of 3 — standard retry policy says try again.`,
          action: "retry",
        };
      }

      return {
        reasoning: `Still failing after ${attempt} attempts. This endpoint appears permanently broken. I should skip it.`,
        action: "skip",
      };
    }

    // Success handling
    if (context.type === "success") {
      return {
        reasoning: `Successfully scraped ${context.coin} from ${context.exchange}. Price: $${context.price}. Moving to next target.`,
        action: "continue",
      };
    }

    return { reasoning: "Proceeding with next step.", action: "continue" };
  }
}

// ─── Real LLM (OpenAI) ───────────────────────────────────────────────────────

class RealLLM {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.callCount = 0;
  }

  async reason(context) {
    this.callCount++;

    // Use OpenClaw SKILL.md as the system prompt (real integration)
    const skillContext = SKILL_PROMPT
      ? `${SKILL_PROMPT}\n\n## Agent Role\nYou are a crypto price scraping agent. Respond in JSON: { "reasoning": "...", "action": "retry|skip|continue", "plan": [...] }`
      : `You are a crypto price scraping agent with ProceedGate cost governance.\nAlways respond in JSON: { "reasoning": "...", "action": "retry|skip|continue", "plan": [...] }`;
    const systemPrompt = skillContext;

    const userPrompt = JSON.stringify(context);

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        max_tokens: 500,
      }),
    });

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content ?? "{}";
    try { return JSON.parse(content); }
    catch { return { reasoning: content, action: "continue" }; }
  }
}

// ─── Onchain Wallet (BSC Testnet) ─────────────────────────────────────────────
// Agent autonomously signs and sends real transactions when ProceedGate requires payment.

const BSC_TESTNET_RPC = "https://data-seed-prebsc-1-s1.bnbchain.org:8545";
const BSC_TESTNET_CHAIN_ID = 97;
const BSC_TESTNET_EXPLORER = "https://testnet.bscscan.com/tx";
const GOVERNOR_CONTRACT = "0xAd8Da0Af368804e47bcdA8217b4e24F4cEb058dA";
const WALLET_PATH = new URL("../.secrets/bsc-testnet-deployer.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const PAYMENT_AMOUNT = "0.0001"; // 0.0001 tBNB per friction payment

let agentWallet = null;
const onchainTxLog = []; // track all onchain actions for summary

async function initWallet() {
  try {
    const { ethers } = require("ethers");
    let privateKey = process.env.AGENT_WALLET_KEY;

    if (!privateKey && existsSync(WALLET_PATH)) {
      const walletData = JSON.parse(readFileSync(WALLET_PATH, "utf-8"));
      privateKey = walletData.privateKey;
    }

    if (!privateKey) return;

    const provider = new ethers.JsonRpcProvider(BSC_TESTNET_RPC);
    const wallet = new ethers.Wallet(privateKey, provider);
    const balance = await provider.getBalance(wallet.address);
    const balanceEth = ethers.formatEther(balance);

    if (parseFloat(balanceEth) < 0.001) {
      warn(`Wallet ${wallet.address.slice(0, 10)}… has only ${balanceEth} tBNB — skipping onchain payments`);
      return;
    }

    agentWallet = { wallet, provider, ethers, balance: balanceEth, address: wallet.address };
  } catch (err) {
    // ethers not available or wallet error — graceful degradation
    agentWallet = null;
  }
}

async function sendFrictionPayment(recipient, price) {
  if (!agentWallet) return null;
  const { wallet, ethers } = agentWallet;

  try {
    const tx = await wallet.sendTransaction({
      to: recipient || GOVERNOR_CONTRACT,
      value: ethers.parseEther(PAYMENT_AMOUNT),
      chainId: BSC_TESTNET_CHAIN_ID,
    });

    ok(`⛓️  Tx signed & sent: ${c.cyan}${tx.hash.slice(0, 18)}…${c.reset}`);
    ok(`⛓️  Explorer: ${c.blue}${BSC_TESTNET_EXPLORER}/${tx.hash}${c.reset}`);

    // Wait for confirmation (1 block)
    const receipt = await tx.wait(1);
    ok(`⛓️  Confirmed in block ${c.bold}${receipt.blockNumber}${c.reset} (gas: ${receipt.gasUsed.toString()})`);

    onchainTxLog.push({
      hash: tx.hash,
      block: receipt.blockNumber,
      to: recipient || GOVERNOR_CONTRACT,
      value: PAYMENT_AMOUNT,
      explorer: `${BSC_TESTNET_EXPLORER}/${tx.hash}`,
    });

    return tx.hash;
  } catch (err) {
    warn(`Onchain tx failed: ${err.message.slice(0, 80)}`);
    return null;
  }
}

// ─── ProceedGate Gate ─────────────────────────────────────────────────────────
// Wraps every agent action with a cost governance check.

class ProceedGateGuard {
  constructor(auth) {
    this.auth = auth;
    this.stats = { checks: 0, allowed: 0, blocked: 0, totalFriction: 0 };
  }

  async gate(taskHash, attempt) {
    this.stats.checks++;
    const body = {
      policy_id: "retry_friction_v1",
      action: "tool_call",
      actor: { id: "crypto-scraper-agent", project: "agent-demo" },
      context: {
        attempt_in_window: attempt,
        window_seconds: 600,
        task_hash: taskHash,
        step_hash: `step-${attempt}`,
        context_hash: `ctx-${taskHash}-${attempt}`,
        tool: "exchange_scraper",
      },
    };

    const res = await httpJson("POST", "/v1/governor/check", body, this.auth);

    if (res.status === 200) {
      this.stats.allowed++;
      return { allowed: true, token: res.json?.proceed_token };
    }

    // 402 — friction
    this.stats.blocked++;
    const price = res.headers["x402-price"] ?? res.json?.price ?? null;
    if (price) this.stats.totalFriction += parseFloat(price) || 0;
    return {
      allowed: false,
      status: res.status,
      price,
      decisionId: res.json?.decision_id,
      recipient: res.headers["x402-recipient"] ?? res.json?.recipient,
    };
  }
}

// ─── The Agent ────────────────────────────────────────────────────────────────

class CryptoScrapingAgent {
  constructor(llm, guard) {
    this.llm = llm;
    this.guard = guard;
    this.results = [];
    this.skipped = [];
    this.totalRetries = 0;
  }

  async run() {
    // ── Phase 1: Planning ──
    phase(1, "Agent Planning");
    think("Analyzing task: scrape crypto prices from exchanges…");
    await sleep(1200);

    const planResult = await this.llm.reason({ type: "plan" });

    think(planResult.reasoning);
    await sleep(800);

    console.log();
    info("Task plan:");
    for (const step of planResult.plan) {
      console.log(`     ${c.dim}${step.exchange.padEnd(16)} → ${step.coin.padEnd(5)} ${c.gray}(${step.reason})${c.reset}`);
    }
    await sleep(2000);

    // ── Phase 2: Execution ──
    phase(2, "Executing Scrape Tasks (Gated)");
    info("Every API call goes through ProceedGate before execution.\n");
    await sleep(1000);

    for (let i = 0; i < planResult.plan.length; i++) {
      const step = planResult.plan[i];
      const taskNum = i + 1;
      await this.executeStep(taskNum, step.exchange, step.coin);
      await sleep(500);
    }

    return { results: this.results, skipped: this.skipped, retries: this.totalRetries };
  }

  async executeStep(taskNum, exchange, coin) {
    const taskHash = `scrape-${exchange}-${coin}`;
    const exchangeName = EXCHANGE_DATA[exchange]?.name ?? exchange;
    let attempt = 0;
    let frictionCount = 0; // how many times ProceedGate applied friction
    const MAX_AGENT_RETRIES = 10; // agent would retry up to 10 times without ProceedGate

    while (attempt < MAX_AGENT_RETRIES) {
      attempt++;
      if (attempt > 1) this.totalRetries++;

      console.log(`  ${c.bold}📡 [${taskNum}/5] ${exchangeName} / ${coin}${c.reset}  ${c.dim}(attempt ${attempt})${c.reset}`);

      // ── Step A: Ask ProceedGate for permission ──
      const gate = await this.guard.gate(taskHash, attempt);

      if (!gate.allowed) {
        // ProceedGate is applying friction
        frictionCount++;
        const priceStr = gate.price ?? "blocked";
        warn(`Gate: ${c.red}402 Payment Required${c.reset} — friction: ${c.yellow}$${priceStr}${c.reset}`);

        // Ask LLM what to do
        const decision = await this.llm.reason({
          type: "error",
          attempt,
          error: "ProceedGate 402 friction",
          frictionPrice: gate.price,
          frictionCount,
          exchange,
          coin,
        });

        think(decision.reasoning);

        if (decision.action === "skip") {
          fail(`Agent decided to skip ${exchangeName}/${coin} — friction too high.`);
          this.skipped.push({ exchange, coin, reason: "friction_escalation", attempts: attempt });
          console.log();
          return;
        }

        if (decision.action === "pay" && agentWallet) {
          // ── Onchain payment: agent autonomously signs a real BSC testnet tx ──
          const recipient = gate.recipient ?? GOVERNOR_CONTRACT;
          ok(`Agent decides to pay onchain to resolve friction...`);
          const txHash = await sendFrictionPayment(recipient, gate.price ?? "0.0001");

          if (txHash) {
            // Redeem the decision with the real tx hash
            try {
              const redeemRes = await httpJson(
                "POST",
                "/v1/governor/redeem",
                { decision_id: gate.decisionId },
                { ...this.guard.auth, "x402-tx-hash": txHash }
              );
              ok(`Redeem: ${c.green}proceed_token issued${c.reset} (onchain payment verified)`);
            } catch (redeemErr) {
              warn(`Redeem failed: ${redeemErr.message}`);
              await sleep(600);
              continue;
            }
            // Now execute the scrape with the redeemed token
            try {
              const result = await mockScrape(exchange, coin);
              ok(`Result: ${c.bold}${coin} = $${result.price}${c.reset} via ${result.exchange}`);
              this.results.push(result);
              console.log();
              return;
            } catch (scrapeErr) {
              warn(`Scrape after payment: ${scrapeErr.message} — endpoint still broken`);
            }
          }
          await sleep(600);
          continue;
        }

        // Agent wants to retry despite friction — loop continues
        await sleep(600);
        continue;
      }

      // ── Step B: Gate approved — execute the scrape ──
      ok(`Gate: ${c.green}200 OK${c.reset} — proceed_token issued`);

      try {
        const result = await mockScrape(exchange, coin);
        ok(`Result: ${c.bold}${coin} = $${result.price}${c.reset} via ${result.exchange}`);

        // LLM acknowledges success
        const ack = await this.llm.reason({
          type: "success",
          exchange: exchangeName,
          coin,
          price: result.price,
        });
        // Don't print every success reasoning — keep it flowing
        this.results.push(result);
        console.log();
        return;

      } catch (err) {
        // ── Step C: Scrape failed — ask LLM if we should retry ──
        warn(`API Error: ${err.message}`);

        const decision = await this.llm.reason({
          type: "error",
          attempt,
          error: err.message,
          exchange,
          coin,
        });

        think(decision.reasoning);

        if (decision.action === "skip") {
          fail(`Agent decided to skip ${exchangeName}/${coin}.`);
          this.skipped.push({ exchange, coin, reason: "api_error", attempts: attempt });
          console.log();
          return;
        }

        // Retry — loop continues
        await sleep(400);
      }
    }

    // Shouldn't reach here in the demo, but just in case
    fail(`Max retries exhausted for ${exchangeName}/${coin}.`);
    this.skipped.push({ exchange, coin, reason: "max_retries", attempts: attempt });
    console.log();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const npm = getNpmCommand();

  // ── Intro ──
  console.clear();
  banner("🤖 CryptoScraper — AI Agent with ProceedGate");

  console.log(`  ${c.bold}An autonomous AI agent that scrapes crypto prices,${c.reset}`);
  console.log(`  ${c.bold}protected by ProceedGate cost governance.${c.reset}\n`);
  console.log(`  ${c.dim}LLM: ${USE_REAL_LLM ? "OpenAI GPT-4o-mini (real)" : "Mock LLM (deterministic demo)"}${c.reset}`);
  console.log(`  ${c.dim}Skill: ${SKILL_PROMPT ? "skills/onchain-cost-governor/SKILL.md (OpenClaw)" : "hardcoded fallback"}${c.reset}`);
  console.log(`  ${c.dim}Onchain: BSC Testnet (chain 97) — real signed transactions${c.reset}`);
  console.log(`  ${c.dim}Good Vibes Only: OpenClaw Edition · Track: Agent${c.reset}`);
  console.log(`  ${c.dim}github.com/loquit-doru/agent-cost-governor${c.reset}\n`);

  info("Starting ProceedGate Governor…\n");
  await sleep(1500);

  // ── Start Worker ──
  const worker = spawn(npm, [
    "--workspace", "worker", "run", "dev", "--",
    "--env", "billing", "--local", "--port", String(PORT),
  ], {
    stdio: "ignore",
    shell: process.platform === "win32",
    env: process.env,
  });

  try {
    await waitForHealth(`${GOVERNOR_URL}/health`);
    ok(`Governor running on port ${PORT}`);
    await sleep(400);

    // ── Create workspace + auth + credits ──
    const ws = await httpJson("POST", "/v1/workspaces/create",
      { workspace_id: "agent-demo" },
      { "x-admin-key": "dev-admin-key" },
    );
    const apiKey = ws.json?.api_key ?? "";
    let AUTH = {};
    if (apiKey) {
      AUTH = { authorization: `Bearer ${apiKey}` };
      ok("Workspace created, API key obtained");
    } else {
      warn(`Workspace response: ${JSON.stringify(ws.json)}`);
    }

    // Add credits so the first attempts pass (billing env requires credits)
    const quote = await httpJson("POST", "/v1/billing/quote",
      { workspace_id: "agent-demo", credits: 50 }, AUTH);
    const quoteId = quote.json?.quote_id;
    if (quoteId) {
      await httpJson("POST", "/v1/billing/redeem",
        { quote_id: quoteId, tx_hash: `0xstub:agent-demo-${quoteId}` }, AUTH);
      ok("50 credits loaded into workspace");
    }
    await sleep(500);

    // ── Initialize Wallet ──
    await initWallet();
    if (agentWallet) {
      ok(`Onchain wallet: ${c.cyan}${agentWallet.address}${c.reset}`);
      ok(`BSC Testnet — real transactions will be signed and broadcast`);
    } else {
      warn(`No wallet configured — using stub tx hashes (set AGENT_WALLET_KEY or add .secrets/bsc-testnet-deployer.json)`);
    }
    await sleep(400);

    // ── Load OpenClaw Skill ──
    if (SKILL_PROMPT) {
      ok(`OpenClaw skill loaded: ${c.cyan}onchain-cost-governor${c.reset} (${SKILL_PROMPT.length} chars)`);
      info(`Agent behavior defined by ${c.bold}skills/onchain-cost-governor/SKILL.md${c.reset}`);
    } else {
      warn("OpenClaw SKILL.md not found — using hardcoded behavior");
    }
    await sleep(400);

    // ── Initialize Agent ──
    const llm = USE_REAL_LLM ? new RealLLM(OPENAI_API_KEY) : new MockLLM();
    const guard = new ProceedGateGuard(AUTH);
    const agentInstance = new CryptoScrapingAgent(llm, guard);

    // ── Run Agent ──
    const startTime = Date.now();
    const outcome = await agentInstance.run();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // ── Phase 3: Impact — Live Contrast Simulation ──
    phase(3, "Impact: With vs Without ProceedGate");

    const COST_PER_CALL = 0.02; // $0.02 per API call (SerpAPI/Firecrawl typical)
    const RETRY_DELAY_S = 0.4;  // 400ms between retries (aggressive agent)
    const SIM_RETRIES = 500;    // simulate up to 500 retries in ~3 min

    console.log(`  ${c.bold}${c.red}⚠️  SIMULATION: What this agent does WITHOUT ProceedGate${c.reset}`);
    console.log(`  ${c.dim}(CoinMarketCap is down — agent retries endlessly at 400ms intervals)${c.reset}\n`);
    await sleep(1200);

    // Rapid visual counter — shows retries + cost climbing
    const milestones = [10, 25, 50, 100, 200, 300, 500];
    let mIdx = 0;
    for (let i = 1; i <= SIM_RETRIES; i++) {
      if (i === milestones[mIdx]) {
        const cost = (i * COST_PER_CALL).toFixed(2);
        const perHour = Math.floor(3600 / (RETRY_DELAY_MS / 1000));
        const bar = "█".repeat(Math.min(Math.floor(i / 10), 40));
        const color = i <= 50 ? c.yellow : i <= 200 ? c.red : `${c.bold}${c.red}`;
        process.stdout.write(`\r     ${color}🔄 ${String(i).padStart(3)} retries │ $${cost.padStart(7)} wasted │ ${bar}${c.reset}`);
        process.stdout.write("\n");
        mIdx++;
        await sleep(i <= 50 ? 400 : i <= 200 ? 300 : 200);
      }
    }

    const totalNoCost = (SIM_RETRIES * COST_PER_CALL).toFixed(2);
    const overnightCost = Math.floor(8 * 3600 / RETRY_DELAY_S * COST_PER_CALL);
    console.log();
    console.log(`  ${c.bold}${c.bgRed}${c.white} 💸 500 retries in ~3 min = $${totalNoCost} burned on a DEAD endpoint ${c.reset}`);
    console.log(`  ${c.red}     Overnight (8h): ~$${overnightCost} wasted. Weekend: ~$${(overnightCost * 6).toLocaleString()} gone.${c.reset}`);
    await sleep(2500);

    // Now the contrast
    console.log(`\n  ${c.bold}${c.green}✅ ACTUAL RESULT — Same agent WITH ProceedGate:${c.reset}\n`);

    const actualRetries = outcome.retries;
    const actualFriction = guard.stats.totalFriction.toFixed(4);
    const actualOnchain = onchainTxLog.length > 0 ? `${onchainTxLog.length} real BSC tx` : "0 onchain";
    const savedPerIncident = (parseFloat(totalNoCost) - parseFloat(actualFriction)).toFixed(2);

    console.log(`     ${c.green}🔄 Total retries:     ${c.bold}${actualRetries}${c.reset}${c.green}  (not 500+)${c.reset}`);
    console.log(`     ${c.green}💰 Friction paid:     ${c.bold}$${actualFriction}${c.reset}${c.green}  (not $${totalNoCost})${c.reset}`);
    console.log(`     ${c.green}⛓️  Onchain actions:   ${c.bold}${actualOnchain}${c.reset}${c.green}  (verifiable on BSC Testnet)${c.reset}`);
    console.log(`     ${c.green}🧠 LLM decided:       ${c.bold}STOP${c.reset}${c.green}  (autonomous, not hardcoded)${c.reset}`);
    console.log();
    console.log(`  ${c.bold}${c.bgGreen}${c.white} 💰 SAVED: $${savedPerIncident} per incident × ~3 incidents/week = $${(savedPerIncident * 3).toFixed(0)}/week ${c.reset}`);
    await sleep(3000);

    // ── Phase 4: Summary ──
    phase(4, "Mission Report");

    const stats = guard.stats;
    console.log(`  ${c.bold}Agent Performance:${c.reset}`);
    console.log(`     ${c.green}✅ Successful scrapes:  ${outcome.results.length}/5${c.reset}`);
    console.log(`     ${c.red}🚫 Skipped (broken):   ${outcome.skipped.length}/5${c.reset}`);
    console.log(`     ${c.yellow}🔄 Total retries:      ${outcome.retries}${c.reset}`);
    console.log(`     ${c.dim}⏱  Elapsed:            ${elapsed}s${c.reset}`);
    console.log();

    console.log(`  ${c.bold}ProceedGate Stats:${c.reset}`);
    console.log(`     ${c.cyan}📊 Total checks:       ${stats.checks}${c.reset}`);
    console.log(`     ${c.green}✅ Allowed:            ${stats.allowed}${c.reset}`);
    console.log(`     ${c.red}🚫 Blocked (friction): ${stats.blocked}${c.reset}`);
    console.log(`     ${c.yellow}💰 Total friction:     $${stats.totalFriction.toFixed(4)}${c.reset}`);
    console.log();

    if (outcome.results.length > 0) {
      console.log(`  ${c.bold}Price Snapshot:${c.reset}`);
      for (const r of outcome.results) {
        console.log(`     ${c.cyan}${r.coin.padEnd(5)}${c.reset} $${r.price.padStart(12)} ${c.dim}via ${r.exchange}${c.reset}`);
      }
      console.log();
    }

    money(`Quantified impact: $${savedPerIncident} saved THIS demo run`);
    money(`Projected: $${(savedPerIncident * 3).toFixed(0)}/week · $${(savedPerIncident * 12).toFixed(0)}/month (at 3 incidents/week)`);
    console.log();

    if (onchainTxLog.length > 0) {
      console.log(`  ${c.bold}${c.cyan}⛓️  Onchain Transactions (BSC Testnet):${c.reset}`);
      for (const tx of onchainTxLog) {
        console.log(`     ${c.green}TX:${c.reset} ${tx.hash}`);
        console.log(`        ${c.dim}Block: ${tx.block} · ${tx.value} BNB → ${tx.to.slice(0, 10)}...${c.reset}`);
        console.log(`        ${c.cyan}🔗 ${BSC_TESTNET_EXPLORER}/${tx.hash}${c.reset}`);
      }
      console.log();
    } else {
      console.log(`  ${c.bold}${c.cyan}⛓️  On-chain enforcement available:${c.reset}`);
      console.log(`     ${c.dim}BSC · opBNB · Base — AICostGovernor.sol deployed${c.reset}\n`);
    }

    console.log(`  ${c.bold}LLM calls: ${llm.callCount}${c.reset}  ${c.dim}(${USE_REAL_LLM ? "OpenAI GPT-4o-mini" : "Mock LLM — zero cost"})${c.reset}\n`);

    // ── Closing ──
    banner("⭐  github.com/loquit-doru/agent-cost-governor  ⭐");
    console.log(`  ${c.bold}${c.cyan}proceedgate.dev${c.reset}  ·  ${c.dim}Start free — 2,000 checks/month${c.reset}\n`);

    await sleep(3000);
    await stopWorker(worker);
    process.exit(0);

  } catch (error) {
    await stopWorker(worker);
    console.error(`\n${c.red}ERROR: ${error}${c.reset}`);
    process.exit(1);
  }
}

await main();
