#!/usr/bin/env node
/**
 * ProceedGate Stress Test - Credit Exhaustion Demo
 * 
 * This demo shows what happens when an AI agent runs out of credits.
 * It makes rapid requests until blocked, demonstrating ProceedGate's protection.
 * 
 * Usage:
 *   node examples/stress-test.mjs
 */

const PROCEEDGATE_URL = process.env.PROCEEDGATE_URL || 'https://governor.proceedgate.dev';
const PROCEEDGATE_API_KEY = process.env.PROCEEDGATE_API_KEY;

if (!PROCEEDGATE_API_KEY) {
  console.error('❌ Missing PROCEEDGATE_API_KEY');
  process.exit(1);
}

async function checkSimple(userId, action, cost) {
  const res = await fetch(`${PROCEEDGATE_URL}/v1/check/simple`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${PROCEEDGATE_API_KEY}`,
    },
    body: JSON.stringify({ user_id: userId, action, cost }),
  });
  return res.json();
}

async function getBalance() {
  const res = await fetch(`${PROCEEDGATE_URL}/v1/me`, {
    headers: { 'Authorization': `Bearer ${PROCEEDGATE_API_KEY}` },
  });
  const data = await res.json();
  return data.credits?.remaining ?? 0;
}

async function main() {
  console.log('═'.repeat(70));
  console.log('🏋️ ProceedGate Stress Test - Credit Exhaustion Demo');
  console.log('═'.repeat(70));
  console.log('This demo rapidly consumes credits until blocked.\n');

  const startCredits = await getBalance();
  console.log(`📊 Starting credits: ${startCredits}`);
  
  if (startCredits === 0) {
    console.log('⚠️  Already at 0 credits. Create a new workspace to test.');
    return;
  }

  console.log('\n🚀 Starting rapid agent operations...\n');

  let iteration = 0;
  let totalAllowed = 0;
  let totalBlocked = 0;
  const startTime = Date.now();

  // Simulate an out-of-control agent making expensive calls
  const actions = [
    { action: 'llm_call', cost: 10, name: '🤖 LLM Call (GPT-4)' },
    { action: 'tool_call', cost: 20, name: '🔧 Web Scraping' },
    { action: 'api_call', cost: 15, name: '🌐 External API' },
    { action: 'llm_call', cost: 25, name: '🤖 LLM Call (Claude)' },
    { action: 'browser_action', cost: 30, name: '🖥️ Browser Automation' },
  ];

  while (true) {
    iteration++;
    const op = actions[iteration % actions.length];
    
    process.stdout.write(`[${iteration}] ${op.name} (cost: ${op.cost})... `);
    
    const result = await checkSimple(`stress-test-${Date.now()}`, op.action, op.cost);
    
    if (result.allowed) {
      totalAllowed++;
      console.log(`✅ Allowed (${result.credits_remaining} left)`);
    } else {
      totalBlocked++;
      console.log(`🚫 BLOCKED!`);
      console.log(`\n${'═'.repeat(70)}`);
      console.log('⛔ AGENT STOPPED - Credits Exhausted');
      console.log('═'.repeat(70));
      console.log(`   Reason: ${result.reason || 'insufficient_credits'}`);
      console.log(`   Credits remaining: ${result.credits_remaining || 0}`);
      break;
    }

    // Stop if we've done many iterations (safety limit)
    if (iteration >= 500) {
      console.log('\n⚠️ Safety limit reached (500 iterations)');
      break;
    }

    // Small delay to not hammer the server too hard
    await new Promise(r => setTimeout(r, 50));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  const endCredits = await getBalance();

  console.log(`\n${'═'.repeat(70)}`);
  console.log('📈 Stress Test Results');
  console.log('═'.repeat(70));
  console.log(`   Iterations:     ${iteration}`);
  console.log(`   ✅ Allowed:     ${totalAllowed}`);
  console.log(`   🚫 Blocked:     ${totalBlocked}`);
  console.log(`   Time elapsed:   ${elapsed}s`);
  console.log(`   Requests/sec:   ${(iteration / elapsed).toFixed(1)}`);
  console.log(`\n   Starting credits: ${startCredits}`);
  console.log(`   Final credits:    ${endCredits}`);
  console.log(`   Credits consumed: ${startCredits - endCredits}`);
  
  console.log('\n💡 Key Takeaway:');
  console.log('   ProceedGate stopped the runaway agent before it could');
  console.log('   consume unlimited resources. Without this gate, the');
  console.log('   agent would have continued making expensive API calls!');
}

main().catch(console.error);
