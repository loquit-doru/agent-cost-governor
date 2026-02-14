#!/usr/bin/env node
/**
 * 🎬 ProceedGate CINEMATIC Video Demo
 * 
 * Beautiful colors, dramatic pauses, perfect for X.com videos
 * 
 * Usage: node examples/video-cinematic.mjs
 */

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
if (!GROQ_API_KEY) {
  throw new Error('Missing GROQ_API_KEY environment variable');
}
const API_BASE = 'https://governor.proceedgate.dev';

// =============================================================================
// ANSI Colors & Styles
// =============================================================================

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  
  // Colors
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  
  // Bright colors
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  
  // Background
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
};

// =============================================================================
// Animation Helpers
// =============================================================================

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function typeText(text, delay = 30) {
  for (const char of text) {
    process.stdout.write(char);
    await sleep(delay);
  }
}

async function dramaticPause(seconds = 2) {
  await sleep(seconds * 1000);
}

function clearScreen() {
  console.clear();
  console.log('\n'.repeat(2));
}

function progressBar(current, total, width = 30) {
  const filled = Math.round((current / total) * width);
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const percent = Math.round((current / total) * 100);
  return `${bar} ${percent}%`;
}

// =============================================================================
// INTRO
// =============================================================================

async function showIntro() {
  clearScreen();
  
  console.log(`${c.brightCyan}${c.bold}`);
  console.log('  ╔════════════════════════════════════════════════════════════════════╗');
  console.log('  ║                                                                    ║');
  console.log(`  ║   ${c.brightYellow}🛡️  PROCEEDGATE${c.brightCyan}                                               ║`);
  console.log('  ║                                                                    ║');
  console.log(`  ║   ${c.white}Stop runaway AI agents from draining your budget${c.brightCyan}              ║`);
  console.log('  ║                                                                    ║');
  console.log('  ╚════════════════════════════════════════════════════════════════════╝');
  console.log(`${c.reset}`);
  
  await dramaticPause(3);
  
  console.log(`\n  ${c.dim}The problem:${c.reset}`);
  await sleep(500);
  await typeText(`  ${c.white}AI agents can get stuck in infinite loops...${c.reset}`, 40);
  await dramaticPause(1);
  console.log();
  await typeText(`  ${c.brightRed}...costing you hundreds of dollars while you sleep.${c.reset}`, 40);
  
  await dramaticPause(3);
}

// =============================================================================
// SETUP
// =============================================================================

async function createWorkspace() {
  clearScreen();
  
  console.log(`\n  ${c.brightBlue}${c.bold}⚙️  SETTING UP DEMO${c.reset}\n`);
  
  const email = `video-${Date.now()}@proceedgate.dev`;
  
  process.stdout.write(`  ${c.cyan}Creating workspace...${c.reset} `);
  
  const res = await fetch(`${API_BASE}/v1/billing/free`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  });
  
  const data = await res.json();
  
  console.log(`${c.green}✓${c.reset}`);
  console.log(`  ${c.dim}Workspace: ${data.workspace_id}${c.reset}`);
  
  // Drain credits with progress bar
  console.log(`\n  ${c.cyan}Setting budget to 30 credits...${c.reset}`);
  
  const toDrain = data.credits - 30;
  const iterations = Math.floor(toDrain / 5);
  
  for (let i = 0; i < iterations; i++) {
    await fetch(`${API_BASE}/v1/check/simple`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${data.api_key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ user_id: 'drain', action: 'drain', cost: 5 })
    });
    
    if (i % 20 === 0) {
      process.stdout.write(`\r  ${c.dim}${progressBar(i, iterations)}${c.reset}`);
    }
  }
  
  console.log(`\r  ${c.green}${progressBar(iterations, iterations)}${c.reset}`);
  console.log(`\n  ${c.green}✓ Setup complete${c.reset}`);
  
  await dramaticPause(2);
  
  return data.api_key;
}

// =============================================================================
// PART 1: Without ProceedGate
// =============================================================================

async function runWithoutGate() {
  clearScreen();
  
  // Header
  console.log(`${c.brightRed}${c.bold}`);
  console.log('  ╔════════════════════════════════════════════════════════════════════╗');
  console.log('  ║                                                                    ║');
  console.log('  ║   ❌  SCENARIO 1: AI AGENT WITHOUT COST CONTROLS                   ║');
  console.log('  ║                                                                    ║');
  console.log('  ╚════════════════════════════════════════════════════════════════════╝');
  console.log(`${c.reset}`);
  
  await dramaticPause(2);
  
  console.log(`  ${c.white}${c.bold}Task:${c.reset} ${c.yellow}"Get the current AAPL stock price"${c.reset}`);
  console.log(`  ${c.dim}(An impossible task - LLMs can't access real-time data)${c.reset}`);
  
  await dramaticPause(2);
  
  console.log(`\n  ${c.brightYellow}▶ Agent starting...${c.reset}\n`);
  
  await sleep(1000);
  
  const messages = [
    { role: 'user', content: 'What is the current AAPL stock price? Give me the exact price right now.' }
  ];
  
  let totalTokens = 0;
  const maxRetries = 8;
  
  for (let i = 1; i <= maxRetries; i++) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages,
        max_tokens: 150
      })
    });
    
    const data = await res.json();
    const content = data.choices[0].message.content;
    const tokens = data.usage?.total_tokens || 0;
    totalTokens += tokens;
    
    messages.push({ role: 'assistant', content });
    messages.push({ role: 'user', content: 'That\'s not specific enough. I need the EXACT current price.' });
    
    const cost = (totalTokens * 0.003).toFixed(2); // GPT-4 pricing for drama
    
    // Visual output
    console.log(`  ${c.red}┃${c.reset} ${c.bold}Retry #${i}${c.reset}`);
    console.log(`  ${c.red}┃${c.reset} ${c.dim}Tokens: ${totalTokens} │ Est. cost: $${cost}${c.reset}`);
    console.log(`  ${c.red}┃${c.reset} ${c.yellow}"${content.slice(0, 60).replace(/\n/g, ' ')}..."${c.reset}`);
    console.log(`  ${c.red}┃${c.reset}`);
    
    await sleep(1200);
  }
  
  // Dramatic result
  console.log(`  ${c.red}┃${c.reset}`);
  console.log(`  ${c.red}┃${c.reset}  ${c.dim}...and it keeps going...${c.reset}`);
  console.log(`  ${c.red}┃${c.reset}  ${c.dim}...forever...${c.reset}`);
  console.log(`  ${c.red}┃${c.reset}`);
  
  await dramaticPause(2);
  
  console.log(`\n  ${c.bgRed}${c.white}${c.bold}                                                                    ${c.reset}`);
  console.log(`  ${c.bgRed}${c.white}${c.bold}   💸 RESULT: AGENT RUNS FOREVER                                     ${c.reset}`);
  console.log(`  ${c.bgRed}${c.white}${c.bold}                                                                    ${c.reset}`);
  
  console.log(`\n  ${c.brightRed}${c.bold}• ${maxRetries}+ API calls${c.reset} ${c.dim}(and counting)${c.reset}`);
  console.log(`  ${c.brightRed}${c.bold}• ${totalTokens.toLocaleString()} tokens${c.reset} ${c.dim}consumed${c.reset}`);
  console.log(`  ${c.brightRed}${c.bold}• $${(totalTokens * 0.003).toFixed(2)}+${c.reset} ${c.dim}at GPT-4 rates${c.reset}`);
  
  console.log(`\n  ${c.brightYellow}⚠️  This could cost $50-$500+ overnight${c.reset}`);
  
  await dramaticPause(4);
  
  return totalTokens;
}

// =============================================================================
// PART 2: With ProceedGate
// =============================================================================

async function runWithGate(apiKey) {
  clearScreen();
  
  // Header
  console.log(`${c.brightGreen}${c.bold}`);
  console.log('  ╔════════════════════════════════════════════════════════════════════╗');
  console.log('  ║                                                                    ║');
  console.log('  ║   ✅  SCENARIO 2: AI AGENT WITH PROCEEDGATE                        ║');
  console.log('  ║                                                                    ║');
  console.log('  ╚════════════════════════════════════════════════════════════════════╝');
  console.log(`${c.reset}`);
  
  await dramaticPause(2);
  
  console.log(`  ${c.white}${c.bold}Same task:${c.reset} ${c.yellow}"Get the current AAPL stock price"${c.reset}`);
  console.log(`  ${c.brightCyan}${c.bold}Budget:${c.reset} ${c.cyan}30 credits${c.reset}`);
  
  await dramaticPause(2);
  
  console.log(`\n  ${c.brightYellow}▶ Agent starting (with protection)...${c.reset}\n`);
  
  await sleep(1000);
  
  const messages = [
    { role: 'user', content: 'What is the current AAPL stock price? Give me the exact price right now.' }
  ];
  
  let blocked = false;
  let retryCount = 0;
  
  for (let i = 1; i <= 15; i++) {
    // Check ProceedGate
    const checkRes = await fetch(`${API_BASE}/v1/check/simple`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ user_id: 'demo', action: 'llm', cost: 5 })
    });
    
    const checkData = await checkRes.json();
    
    if (!checkData.allowed) {
      // DRAMATIC BLOCK
      console.log(`  ${c.green}┃${c.reset}`);
      console.log(`  ${c.green}┃${c.reset} ${c.bold}Retry #${i}${c.reset}`);
      console.log(`  ${c.green}┃${c.reset}`);
      
      await sleep(500);
      
      console.log(`  ${c.bgRed}${c.white}${c.bold}  🛑 BLOCKED BY PROCEEDGATE  ${c.reset}`);
      console.log(`  ${c.brightRed}     Budget exhausted (0 credits remaining)${c.reset}`);
      
      blocked = true;
      break;
    }
    
    retryCount = i;
    const creditsLeft = checkData.credits_remaining;
    
    // Call LLM
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages,
        max_tokens: 100
      })
    });
    
    const data = await res.json();
    const content = data.choices[0].message.content;
    
    messages.push({ role: 'assistant', content });
    messages.push({ role: 'user', content: 'That\'s not specific enough. I need the EXACT current price.' });
    
    // Visual credit bar
    const creditBar = '█'.repeat(Math.ceil(creditsLeft / 5)) + '░'.repeat(6 - Math.ceil(creditsLeft / 5));
    
    console.log(`  ${c.green}┃${c.reset} ${c.bold}Retry #${i}${c.reset} ${c.green}✓ Allowed${c.reset}`);
    console.log(`  ${c.green}┃${c.reset} ${c.cyan}Credits: [${creditBar}] ${creditsLeft}${c.reset}`);
    console.log(`  ${c.green}┃${c.reset}`);
    
    await sleep(1000);
  }
  
  await dramaticPause(2);
  
  // Success result
  console.log(`\n  ${c.bgGreen}${c.white}${c.bold}                                                                    ${c.reset}`);
  console.log(`  ${c.bgGreen}${c.white}${c.bold}   🛡️  RESULT: AGENT STOPPED AT BUDGET LIMIT                         ${c.reset}`);
  console.log(`  ${c.bgGreen}${c.white}${c.bold}                                                                    ${c.reset}`);
  
  console.log(`\n  ${c.brightGreen}${c.bold}• ${retryCount} API calls${c.reset} ${c.dim}(then blocked)${c.reset}`);
  console.log(`  ${c.brightGreen}${c.bold}• 30 → 0 credits${c.reset} ${c.dim}used${c.reset}`);
  console.log(`  ${c.brightGreen}${c.bold}• $0 surprise bills${c.reset}`);
  
  console.log(`\n  ${c.brightCyan}✨ This is what cost governance looks like.${c.reset}`);
  
  await dramaticPause(4);
}

// =============================================================================
// CTA
// =============================================================================

async function showCTA() {
  clearScreen();
  
  console.log(`${c.brightCyan}${c.bold}`);
  console.log('  ╔════════════════════════════════════════════════════════════════════╗');
  console.log('  ║                                                                    ║');
  console.log(`  ║   ${c.brightYellow}🚀 GET STARTED FREE${c.brightCyan}                                            ║`);
  console.log('  ║                                                                    ║');
  console.log(`  ║   ${c.white}proceedgate.dev${c.brightCyan}                                                 ║`);
  console.log('  ║                                                                    ║');
  console.log('  ╚════════════════════════════════════════════════════════════════════╝');
  console.log(`${c.reset}`);
  
  await dramaticPause(1);
  
  console.log(`\n  ${c.green}✓${c.reset} ${c.white}2,000 checks/month free${c.reset}`);
  await sleep(500);
  console.log(`  ${c.green}✓${c.reset} ${c.white}No credit card required${c.reset}`);
  await sleep(500);
  console.log(`  ${c.green}✓${c.reset} ${c.white}API key in 10 seconds${c.reset}`);
  
  await dramaticPause(2);
  
  console.log(`\n\n  ${c.dim}─────────────────────────────────────────────────────────────${c.reset}`);
  console.log(`  ${c.brightYellow}${c.bold}  Stop paying for AI mistakes. Start governing costs today.${c.reset}`);
  console.log(`  ${c.dim}─────────────────────────────────────────────────────────────${c.reset}`);
  
  console.log('\n\n');
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  try {
    await showIntro();
    const apiKey = await createWorkspace();
    await runWithoutGate();
    await runWithGate(apiKey);
    await showCTA();
  } catch (error) {
    console.error(`${c.red}Error: ${error.message}${c.reset}`);
    process.exit(1);
  }
}

main();
