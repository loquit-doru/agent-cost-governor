#!/usr/bin/env node
/**
 * DEMO: AI Agent WITHOUT ProceedGate (Runaway Agent)
 * 
 * This demonstrates what happens when an AI agent runs without cost controls.
 * ⚠️ WARNING: This agent will keep running until manually stopped!
 */

const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!GROQ_API_KEY) {
  console.error('❌ Missing GROQ_API_KEY');
  process.exit(1);
}

// ============================================================================
// Groq Client (Same as before)
// ============================================================================

class GroqClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.groq.com/openai/v1';
    this.totalCalls = 0;
    this.totalTokens = 0;
  }

  async chat(messages, options = {}) {
    this.totalCalls++;
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model || 'llama-3.1-8b-instant',
        messages,
        max_tokens: options.maxTokens || 300,
        temperature: 0.7,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `API error: ${res.status}`);
    }

    const data = await res.json();
    this.totalTokens += data.usage?.total_tokens || 0;
    return {
      content: data.choices[0].message.content,
      usage: data.usage,
    };
  }
}

// ============================================================================
// Uncontrolled Agent - NO COST LIMITS!
// ============================================================================

class UncontrolledAgent {
  constructor(groqClient) {
    this.groq = groqClient;
    this.history = [];
  }

  async run(task) {
    this.history.push({ role: 'user', content: task });
    
    const response = await this.groq.chat([
      { role: 'system', content: 'You are a helpful assistant. Be concise.' },
      ...this.history,
    ]);
    
    this.history.push({ role: 'assistant', content: response.content });
    return response.content;
  }
}

// ============================================================================
// Simulation: Agent in a retry loop (common failure mode)
// ============================================================================

async function simulateRunawayAgent() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  ⚠️  AI AGENT WITHOUT PROCEEDGATE - RUNAWAY DEMO                      ║');
  console.log('╠══════════════════════════════════════════════════════════════════════╣');
  console.log('║  This agent has NO cost controls. It will keep retrying forever!     ║');
  console.log('║  In production, this could cost $$$$ before anyone notices.          ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log('');

  const groq = new GroqClient(GROQ_API_KEY);
  const agent = new UncontrolledAgent(groq);

  // Simulated scenario: Agent stuck in a retry loop trying to complete an impossible task
  const impossibleTask = "Find the exact current stock price of AAPL and verify it's correct";
  
  console.log(`📋 Task: "${impossibleTask}"`);
  console.log('');
  console.log('🔄 Agent starts retrying (simulating stuck loop)...');
  console.log('─'.repeat(70));
  
  const startTime = Date.now();
  const MAX_ITERATIONS = 15; // Safety limit for demo
  
  // Cost assumptions (hypothetical production costs)
  const COST_PER_1K_TOKENS = 0.002; // $0.002 per 1K tokens (example)
  
  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const estimatedCost = ((groq.totalTokens / 1000) * COST_PER_1K_TOKENS).toFixed(4);
    
    process.stdout.write(`[Retry ${i}] `);
    
    try {
      const response = await agent.run(
        i === 1 ? impossibleTask : "That's not working. Try again with a different approach."
      );
      
      console.log(`✓ Got response (${groq.totalTokens} tokens, ~$${estimatedCost})`);
      console.log(`   "${response.substring(0, 80)}..."`);
      
    } catch (error) {
      console.log(`✗ Error: ${error.message}`);
    }
    
    // Brief pause
    await new Promise(r => setTimeout(r, 300));
  }
  
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalCost = ((groq.totalTokens / 1000) * COST_PER_1K_TOKENS).toFixed(4);
  
  console.log('');
  console.log('─'.repeat(70));
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  💸 RUNAWAY AGENT RESULTS (stopped at safety limit)                  ║');
  console.log('╠══════════════════════════════════════════════════════════════════════╣');
  console.log(`║  ⏱️  Time elapsed:     ${totalTime.padStart(8)}s                                   ║`);
  console.log(`║  🔄 LLM API calls:     ${String(groq.totalCalls).padStart(8)}                                    ║`);
  console.log(`║  📊 Total tokens:      ${String(groq.totalTokens).padStart(8)}                                    ║`);
  console.log(`║  💰 Estimated cost:    $${totalCost.padStart(7)}                                    ║`);
  console.log('╠══════════════════════════════════════════════════════════════════════╣');
  console.log('║                                                                      ║');
  console.log('║  ⚠️  IN PRODUCTION: This loop could run for HOURS with no limits!    ║');
  console.log('║  ⚠️  Real cost with GPT-4: Could easily reach $50-$500+ per incident ║');
  console.log('║                                                                      ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log('');
  
  return {
    calls: groq.totalCalls,
    tokens: groq.totalTokens,
    cost: totalCost,
    time: totalTime,
  };
}

simulateRunawayAgent().catch(console.error);
