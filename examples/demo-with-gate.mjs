#!/usr/bin/env node
/**
 * DEMO: AI Agent WITH ProceedGate (Controlled Agent)
 * 
 * This demonstrates how ProceedGate stops runaway agents before they waste money.
 * ✅ The agent is BLOCKED when it exceeds the budget.
 */

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PROCEEDGATE_API_KEY = process.env.PROCEEDGATE_API_KEY;
const PROCEEDGATE_URL = process.env.PROCEEDGATE_URL || 'https://governor.proceedgate.dev';

if (!GROQ_API_KEY) {
  console.error('❌ Missing GROQ_API_KEY');
  process.exit(1);
}

if (!PROCEEDGATE_API_KEY) {
  console.error('❌ Missing PROCEEDGATE_API_KEY');
  process.exit(1);
}

// ============================================================================
// ProceedGate Client
// ============================================================================

class ProceedGateClient {
  constructor(baseUrl, apiKey) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.checks = 0;
    this.allowed = 0;
    this.blocked = 0;
  }

  async check(action, cost = 1) {
    this.checks++;
    
    const res = await fetch(`${this.baseUrl}/v1/check/simple`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        user_id: 'demo-agent',
        action,
        cost,
      }),
    });

    const data = await res.json();
    
    if (data.allowed) {
      this.allowed++;
      return { allowed: true, credits: data.credits_remaining };
    } else {
      this.blocked++;
      return { allowed: false, credits: data.credits_remaining || 0, reason: data.error };
    }
  }

  async getBalance() {
    const res = await fetch(`${this.baseUrl}/v1/me`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    });
    const data = await res.json();
    return data.credits?.remaining ?? 0;
  }
}

// ============================================================================
// Groq Client
// ============================================================================

class GroqClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.groq.com/openai/v1';
    this.totalCalls = 0;
    this.totalTokens = 0;
  }

  async chat(messages) {
    this.totalCalls++;
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages,
        max_tokens: 300,
      }),
    });

    const data = await res.json();
    this.totalTokens += data.usage?.total_tokens || 0;
    return data.choices[0].message.content;
  }
}

// ============================================================================
// Controlled Agent - WITH PROCEEDGATE
// ============================================================================

class ControlledAgent {
  constructor(groqClient, gateClient) {
    this.groq = groqClient;
    this.gate = gateClient;
    this.history = [];
  }

  async run(task) {
    // 🛡️ CHECK WITH PROCEEDGATE BEFORE EVERY LLM CALL
    const check = await this.gate.check('llm_call', 5); // 5 credits per call
    
    if (!check.allowed) {
      return { blocked: true, credits: check.credits };
    }
    
    this.history.push({ role: 'user', content: task });
    
    const response = await this.groq.chat([
      { role: 'system', content: 'You are a helpful assistant. Be concise.' },
      ...this.history,
    ]);
    
    this.history.push({ role: 'assistant', content: response });
    return { blocked: false, response, credits: check.credits };
  }
}

// ============================================================================
// Simulation: Same retry loop, but WITH protection
// ============================================================================

async function simulateControlledAgent() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  ✅ AI AGENT WITH PROCEEDGATE - PROTECTED DEMO                       ║');
  console.log('╠══════════════════════════════════════════════════════════════════════╣');
  console.log('║  This agent has ProceedGate cost controls.                           ║');
  console.log('║  It will be STOPPED when it exceeds the budget!                      ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log('');

  const groq = new GroqClient(GROQ_API_KEY);
  const gate = new ProceedGateClient(PROCEEDGATE_URL, PROCEEDGATE_API_KEY);

  const startCredits = await gate.getBalance();
  console.log(`📊 Starting credits: ${startCredits}`);
  console.log('');
  
  const agent = new ControlledAgent(groq, gate);
  const impossibleTask = "Find the exact current stock price of AAPL and verify it's correct";
  
  console.log(`📋 Task: "${impossibleTask}"`);
  console.log('');
  console.log('🔄 Agent starts retrying (same scenario as before)...');
  console.log('─'.repeat(70));
  
  const startTime = Date.now();
  const MAX_ITERATIONS = 50; // Higher limit - but ProceedGate will stop it first!
  
  let blockedAt = 0;
  
  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    process.stdout.write(`[Retry ${i}] `);
    
    try {
      const result = await agent.run(
        i === 1 ? impossibleTask : "That's not working. Try again with a different approach."
      );
      
      if (result.blocked) {
        console.log(`🛑 BLOCKED BY PROCEEDGATE!`);
        console.log(`   Credits remaining: ${result.credits}`);
        blockedAt = i;
        break;
      }
      
      console.log(`✓ Allowed (${result.credits} credits left)`);
      console.log(`   "${result.response.substring(0, 60)}..."`);
      
    } catch (error) {
      console.log(`✗ Error: ${error.message}`);
    }
    
    await new Promise(r => setTimeout(r, 200));
  }
  
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  const endCredits = await gate.getBalance();
  const creditsUsed = startCredits - endCredits;
  
  console.log('');
  console.log('─'.repeat(70));
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  🛡️  PROCEEDGATE PROTECTED RESULTS                                    ║');
  console.log('╠══════════════════════════════════════════════════════════════════════╣');
  console.log(`║  ⏱️  Time elapsed:     ${totalTime.padStart(8)}s                                   ║`);
  console.log(`║  🔄 LLM API calls:     ${String(groq.totalCalls).padStart(8)}                                    ║`);
  console.log(`║  🛑 Blocked at retry:  ${String(blockedAt || 'N/A').padStart(8)}                                    ║`);
  console.log(`║  💰 Credits used:      ${String(creditsUsed).padStart(8)}                                    ║`);
  console.log(`║  📊 Credits remaining: ${String(endCredits).padStart(8)}                                    ║`);
  console.log('╠══════════════════════════════════════════════════════════════════════╣');
  console.log('║                                                                      ║');
  console.log('║  ✅ Agent was STOPPED before wasting more resources!                 ║');
  console.log('║  ✅ Budget protected. No surprise bills.                             ║');
  console.log('║  ✅ You stay in control of your AI costs.                            ║');
  console.log('║                                                                      ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log('');
  
  return {
    calls: groq.totalCalls,
    blockedAt,
    creditsUsed,
    time: totalTime,
  };
}

simulateControlledAgent().catch(console.error);
