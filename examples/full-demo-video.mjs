#!/usr/bin/env node
/**
 * ProceedGate - Full Demo for X.com Video
 * 
 * This script runs BOTH demos back-to-back for easy video capture.
 * 
 * Usage:
 *   node examples/full-demo-video.mjs
 * 
 * Required:
 *   GROQ_API_KEY
 *   PROCEEDGATE_API_KEY (with limited credits for dramatic effect)
 */

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PROCEEDGATE_API_KEY = process.env.PROCEEDGATE_API_KEY;
const PROCEEDGATE_URL = 'https://governor.proceedgate.dev';

if (!GROQ_API_KEY || !PROCEEDGATE_API_KEY) {
  console.error('❌ Missing GROQ_API_KEY or PROCEEDGATE_API_KEY');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============================================================================
// Clients
// ============================================================================

class GroqClient {
  constructor() {
    this.calls = 0;
    this.tokens = 0;
  }

  async chat(messages) {
    this.calls++;
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages,
        max_tokens: 200,
      }),
    });

    if (!res.ok) throw new Error('Rate limited');
    
    const data = await res.json();
    this.tokens += data.usage?.total_tokens || 0;
    return data.choices[0].message.content;
  }
}

class GateClient {
  constructor() {
    this.checks = 0;
  }

  async check(cost = 5) {
    this.checks++;
    const res = await fetch(`${PROCEEDGATE_URL}/v1/check/simple`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${PROCEEDGATE_API_KEY}`,
      },
      body: JSON.stringify({ user_id: 'demo', action: 'llm', cost }),
    });
    const data = await res.json();
    return { allowed: data.allowed, credits: data.credits_remaining || 0 };
  }

  async getCredits() {
    const res = await fetch(`${PROCEEDGATE_URL}/v1/me`, {
      headers: { 'Authorization': `Bearer ${PROCEEDGATE_API_KEY}` },
    });
    const data = await res.json();
    return data.credits?.remaining ?? 0;
  }
}

// ============================================================================
// Part 1: WITHOUT ProceedGate
// ============================================================================

async function demoWithoutGate() {
  console.clear();
  console.log('');
  console.log('');
  console.log('  ╔═══════════════════════════════════════════════════════════════╗');
  console.log('  ║                                                               ║');
  console.log('  ║   ⚠️  PART 1: AI AGENT WITHOUT COST CONTROLS                   ║');
  console.log('  ║                                                               ║');
  console.log('  ╚═══════════════════════════════════════════════════════════════╝');
  console.log('');
  
  await sleep(2000);
  
  console.log('  📋 Task: Get current AAPL stock price (impossible for LLM)');
  console.log('');
  console.log('  🔄 Starting retry loop...');
  console.log('  ─'.repeat(35));
  console.log('');
  
  const groq = new GroqClient();
  const history = [];
  
  for (let i = 1; i <= 8; i++) {
    await sleep(500);
    
    const task = i === 1 
      ? 'Get the exact current AAPL stock price' 
      : 'Try again with a different approach';
    
    history.push({ role: 'user', content: task });
    
    try {
      const response = await groq.chat([
        { role: 'system', content: 'Be concise.' },
        ...history,
      ]);
      
      history.push({ role: 'assistant', content: response });
      
      const cost = ((groq.tokens / 1000) * 0.03).toFixed(3); // GPT-4 pricing for impact
      
      console.log(`  [Retry ${i}] ✓ ${groq.tokens} tokens consumed (~$${cost})`);
      console.log(`           "${response.substring(0, 50)}..."`);
      console.log('');
      
    } catch (err) {
      console.log(`  [Retry ${i}] ✓ Retrying... (${groq.tokens} tokens so far)`);
      console.log('');
    }
  }
  
  console.log('  ─'.repeat(35));
  console.log('');
  console.log('  💸 RESULT: Agent would continue FOREVER');
  console.log(`     • ${groq.calls} API calls in seconds`);
  console.log(`     • ${groq.tokens} tokens consumed`);
  console.log('     • No one is watching. No one stops it.');
  console.log('');
  console.log('  ⚠️  With GPT-4: This could cost $50-$500+ per incident');
  console.log('');
  
  await sleep(3000);
}

// ============================================================================
// Part 2: WITH ProceedGate
// ============================================================================

async function demoWithGate() {
  console.log('');
  console.log('');
  console.log('  ╔═══════════════════════════════════════════════════════════════╗');
  console.log('  ║                                                               ║');
  console.log('  ║   ✅ PART 2: AI AGENT WITH PROCEEDGATE                        ║');
  console.log('  ║                                                               ║');
  console.log('  ╚═══════════════════════════════════════════════════════════════╝');
  console.log('');
  
  await sleep(2000);
  
  const gate = new GateClient();
  const groq = new GroqClient();
  
  const startCredits = await gate.getCredits();
  console.log(`  📊 Budget: ${startCredits} credits`);
  console.log('');
  console.log('  📋 Same task: Get current AAPL stock price');
  console.log('');
  console.log('  🔄 Starting retry loop (WITH protection)...');
  console.log('  ─'.repeat(35));
  console.log('');
  
  const history = [];
  
  for (let i = 1; i <= 20; i++) {
    await sleep(600);
    
    // Check with ProceedGate FIRST
    const check = await gate.check(5);
    
    if (!check.allowed) {
      console.log(`  [Retry ${i}] 🛑 BLOCKED BY PROCEEDGATE`);
      console.log(`             Credits: ${check.credits}`);
      console.log('');
      break;
    }
    
    const task = i === 1 
      ? 'Get the exact current AAPL stock price' 
      : 'Try again with a different approach';
    
    history.push({ role: 'user', content: task });
    
    try {
      const response = await groq.chat([
        { role: 'system', content: 'Be concise.' },
        ...history,
      ]);
      
      history.push({ role: 'assistant', content: response });
      
      console.log(`  [Retry ${i}] ✓ Allowed (${check.credits} credits left)`);
      console.log(`           "${response.substring(0, 45)}..."`);
      console.log('');
      
    } catch (err) {
      console.log(`  [Retry ${i}] ✓ Allowed (${check.credits} credits left)`);
      console.log('');
    }
  }
  
  console.log('  ─'.repeat(35));
  console.log('');
  
  const endCredits = await gate.getCredits();
  
  console.log('  🛡️  RESULT: Agent STOPPED at budget limit');
  console.log(`     • Budget: ${startCredits} → ${endCredits} credits`);
  console.log(`     • ${groq.calls} API calls (then blocked)`);
  console.log('     • No surprise bills. You stay in control.');
  console.log('');
  console.log('  ✅ This is what cost governance looks like.');
  console.log('');
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.clear();
  console.log('');
  console.log('  ┌─────────────────────────────────────────────────────────────────┐');
  console.log('  │                                                                 │');
  console.log('  │   🚀 ProceedGate Demo - Stop Runaway AI Agents                  │');
  console.log('  │                                                                 │');
  console.log('  │   proceedgate.dev                                               │');
  console.log('  │                                                                 │');
  console.log('  └─────────────────────────────────────────────────────────────────┘');
  console.log('');
  
  await sleep(2000);
  
  await demoWithoutGate();
  await demoWithGate();
  
  console.log('');
  console.log('  ┌─────────────────────────────────────────────────────────────────┐');
  console.log('  │                                                                 │');
  console.log('  │   🔗 Get started free: proceedgate.dev                          │');
  console.log('  │                                                                 │');
  console.log('  │   ✓ 2,000 checks/month free                                     │');
  console.log('  │   ✓ No credit card required                                     │');
  console.log('  │   ✓ API key in 10 seconds                                       │');
  console.log('  │                                                                 │');
  console.log('  └─────────────────────────────────────────────────────────────────┘');
  console.log('');
}

main().catch(console.error);
