#!/usr/bin/env node
/**
 * 🎬 ProceedGate Video Demo - One-Click Runner
 * 
 * Creates a fresh workspace, drains credits to 30, and runs the comparison demo.
 * Perfect for screen recording X.com videos.
 * 
 * Usage: node examples/run-video-demo.mjs
 */

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
if (!GROQ_API_KEY) {
  throw new Error('Missing GROQ_API_KEY environment variable');
}
const API_BASE = 'https://governor.proceedgate.dev';

// =============================================================================
// STEP 1: Create Fresh Workspace
// =============================================================================

async function createWorkspace() {
  const email = `video-${Date.now()}@proceedgate.dev`;
  
  console.log('\n┌─────────────────────────────────────────────────────────────────┐');
  console.log('│  🔧 SETUP: Creating fresh workspace...                          │');
  console.log('└─────────────────────────────────────────────────────────────────┘\n');
  
  const res = await fetch(`${API_BASE}/v1/billing/free`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  });
  
  if (!res.ok) {
    throw new Error(`Failed to create workspace: ${res.status}`);
  }
  
  const data = await res.json();
  console.log(`  ✓ Workspace: ${data.workspace_id}`);
  console.log(`  ✓ Credits: ${data.credits}`);
  console.log(`  ✓ API Key: ${data.api_key.slice(0, 20)}...`);
  
  return { apiKey: data.api_key, credits: data.credits };
}

// =============================================================================
// STEP 2: Drain Credits to Target
// =============================================================================

async function drainCredits(apiKey, currentCredits, targetCredits = 30) {
  const toDrain = currentCredits - targetCredits;
  const iterations = Math.floor(toDrain / 5);
  
  console.log(`\n  📉 Draining ${toDrain} credits (${iterations} calls)...`);
  
  for (let i = 0; i < iterations; i++) {
    await fetch(`${API_BASE}/v1/check/simple`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ user_id: 'drain', action: 'drain', cost: 5 })
    });
    
    if (i % 50 === 0 && i > 0) {
      process.stdout.write(`  ... ${i}/${iterations} done\n`);
    }
  }
  
  console.log(`  ✓ Credits drained to ~${targetCredits}\n`);
}

// =============================================================================
// STEP 3: Run Demo Part 1 - Without ProceedGate
// =============================================================================

async function runWithoutGate() {
  console.log('\n');
  console.log('  ╔═══════════════════════════════════════════════════════════════╗');
  console.log('  ║                                                               ║');
  console.log('  ║   ❌ PART 1: AI AGENT WITHOUT PROCEEDGATE                     ║');
  console.log('  ║                                                               ║');
  console.log('  ╚═══════════════════════════════════════════════════════════════╝');
  console.log('\n  📋 Task: Get current AAPL stock price (impossible for LLM)');
  console.log('\n  🔄 Starting retry loop...');
  console.log('  ' + '─  '.repeat(33));
  
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
    
    const cost = (totalTokens * 0.00003).toFixed(3);
    const preview = content.slice(0, 50).replace(/\n/g, ' ');
    
    console.log(`\n  [Retry ${i}] ✓ ${totalTokens} tokens consumed (~$${cost})`);
    console.log(`           "${preview}..."`);
    
    await new Promise(r => setTimeout(r, 800));
  }
  
  console.log('\n  ' + '─  '.repeat(33));
  console.log('  💸 RESULT: Agent would continue FOREVER');
  console.log(`     • ${maxRetries} API calls in seconds`);
  console.log(`     • ${totalTokens} tokens consumed`);
  console.log('     • No one is watching. No one stops it.');
  console.log('\n  ⚠️  With GPT-4: This could cost $50-$500+ per incident');
  
  return totalTokens;
}

// =============================================================================
// STEP 4: Run Demo Part 2 - With ProceedGate
// =============================================================================

async function runWithGate(apiKey, budget = 30) {
  console.log('\n\n');
  console.log('  ╔═══════════════════════════════════════════════════════════════╗');
  console.log('  ║                                                               ║');
  console.log('  ║   ✅ PART 2: AI AGENT WITH PROCEEDGATE                        ║');
  console.log('  ║                                                               ║');
  console.log('  ╚═══════════════════════════════════════════════════════════════╝');
  console.log(`\n  📊 Budget: ${budget} credits`);
  console.log('\n  📋 Same task: Get current AAPL stock price');
  console.log('\n  🔄 Starting retry loop (WITH protection)...');
  console.log('  ' + '─  '.repeat(33));
  
  const messages = [
    { role: 'user', content: 'What is the current AAPL stock price? Give me the exact price right now.' }
  ];
  
  let creditsUsed = 0;
  let blocked = false;
  let retryCount = 0;
  
  for (let i = 1; i <= 15; i++) {
    // Check with ProceedGate BEFORE calling LLM
    const checkRes = await fetch(`${API_BASE}/v1/check/simple`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        user_id: 'demo-agent',
        action: 'llm_call',
        cost: 5
      })
    });
    
    const checkData = await checkRes.json();
    
    if (!checkData.allowed) {
      console.log(`\n  [Retry ${i}] 🛑 BLOCKED BY PROCEEDGATE`);
      console.log(`             Credits: ${checkData.credits_remaining}`);
      blocked = true;
      break;
    }
    
    retryCount = i;
    creditsUsed = budget - checkData.credits_remaining;
    
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
    
    const preview = content.slice(0, 45).replace(/\n/g, ' ');
    
    console.log(`\n  [Retry ${i}] ✓ Allowed (${checkData.credits_remaining} credits left)`);
    console.log(`           "${preview}..."`);
    
    await new Promise(r => setTimeout(r, 800));
  }
  
  console.log('\n  ' + '─  '.repeat(33));
  
  if (blocked) {
    console.log('  🛡️  RESULT: Agent STOPPED at budget limit');
    console.log(`     • Budget: ${budget} → 0 credits`);
    console.log(`     • ${retryCount} API calls (then blocked)`);
    console.log('     • No surprise bills. You stay in control.');
    console.log('\n  ✅ This is what cost governance looks like.');
  }
}

// =============================================================================
// STEP 5: Show CTA
// =============================================================================

function showCTA() {
  console.log('\n');
  console.log('  ┌─────────────────────────────────────────────────────────────────┐');
  console.log('  │                                                                 │');
  console.log('  │   🔗 Get started free: proceedgate.dev                          │');
  console.log('  │                                                                 │');
  console.log('  │   ✓ 2,000 checks/month free                                     │');
  console.log('  │   ✓ No credit card required                                     │');
  console.log('  │   ✓ API key in 10 seconds                                       │');
  console.log('  │                                                                 │');
  console.log('  └─────────────────────────────────────────────────────────────────┘');
  console.log('\n');
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  console.clear();
  console.log('\n');
  console.log('  ╔═══════════════════════════════════════════════════════════════╗');
  console.log('  ║                                                               ║');
  console.log('  ║   🎬 PROCEEDGATE VIDEO DEMO                                   ║');
  console.log('  ║                                                               ║');
  console.log('  ║   Stop runaway AI agents from draining your budget            ║');
  console.log('  ║                                                               ║');
  console.log('  ╚═══════════════════════════════════════════════════════════════╝');
  
  try {
    // Setup
    const { apiKey, credits } = await createWorkspace();
    await drainCredits(apiKey, credits, 30);
    
    console.log('  ✓ Setup complete! Starting demo in 3 seconds...');
    await new Promise(r => setTimeout(r, 3000));
    
    // Run demos
    await runWithoutGate();
    await new Promise(r => setTimeout(r, 2000));
    await runWithGate(apiKey, 30);
    
    // CTA
    showCTA();
    
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
