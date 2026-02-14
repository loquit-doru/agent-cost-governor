#!/usr/bin/env node
/**
 * ProceedGate AI Agent Demo with Groq (Real LLM)
 * 
 * This demo shows a REAL AI agent using Groq's free API with ProceedGate cost governance.
 * Every LLM call and tool use is gated - if credits run low, the agent stops.
 * 
 * Usage:
 *   node examples/ai-agent-groq.mjs
 * 
 * Required env vars:
 *   GROQ_API_KEY          - Your Groq API key (free at console.groq.com)
 *   PROCEEDGATE_API_KEY   - Your ProceedGate API key (free at proceedgate.dev)
 */

// ============================================================================
// Configuration
// ============================================================================

const PROCEEDGATE_URL = process.env.PROCEEDGATE_URL || 'https://governor.proceedgate.dev';
const PROCEEDGATE_API_KEY = process.env.PROCEEDGATE_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!GROQ_API_KEY) {
  console.error('❌ Missing GROQ_API_KEY environment variable');
  console.error('   Get a free API key at https://console.groq.com/keys');
  process.exit(1);
}

if (!PROCEEDGATE_API_KEY) {
  console.error('❌ Missing PROCEEDGATE_API_KEY environment variable');
  console.error('   Get a free API key at https://proceedgate.dev/#signup');
  process.exit(1);
}

// ============================================================================
// ProceedGate Client
// ============================================================================

class ProceedGateClient {
  constructor(baseUrl, apiKey) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.stats = { checks: 0, allowed: 0, blocked: 0, creditsUsed: 0 };
  }

  async check(action, metadata = {}) {
    this.stats.checks++;
    
    const res = await fetch(`${this.baseUrl}/v1/check/simple`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        user_id: metadata.user_id || 'groq-agent',
        action,
        cost: metadata.cost || 1,
        metadata,
      }),
    });

    const data = await res.json();
    
    if (data.allowed) {
      this.stats.allowed++;
      this.stats.creditsUsed += metadata.cost || 1;
      return { allowed: true, credits_remaining: data.credits_remaining };
    } else {
      this.stats.blocked++;
      return { 
        allowed: false, 
        reason: data.reason || 'insufficient_credits',
        credits_remaining: data.credits_remaining || 0,
      };
    }
  }

  async getBalance() {
    const res = await fetch(`${this.baseUrl}/v1/me`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    });
    const data = await res.json();
    return {
      workspace_id: data.workspace_id,
      plan_name: data.plan?.name || 'Unknown',
      credits: data.credits?.remaining ?? 0,
      max_credits: data.credits?.included ?? 0,
    };
  }

  getStats() {
    return this.stats;
  }
}

// ============================================================================
// Groq Client
// ============================================================================

class GroqClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.groq.com/openai/v1';
  }

  async chat(messages, options = {}) {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model || 'llama-3.1-8b-instant',
        messages,
        max_tokens: options.maxTokens || 500,
        temperature: options.temperature || 0.7,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Groq API error: ${res.status}`);
    }

    const data = await res.json();
    return {
      content: data.choices[0].message.content,
      usage: data.usage,
      model: data.model,
    };
  }
}

// ============================================================================
// Tools
// ============================================================================

const tools = [
  {
    name: 'search_web',
    description: 'Search the web for current information',
    cost: 2,
    execute: async (query) => {
      await sleep(200);
      // Simulated search results
      const results = {
        'ai cost': 'AI cost management is crucial for enterprises. Key strategies include: setting budgets, monitoring usage, using cost-effective models, and implementing governance tools like ProceedGate.',
        'weather': 'Current weather: Sunny, 22°C with light winds.',
        'news': 'Tech news: AI adoption accelerates in 2026, with focus on cost control and governance.',
        'default': `Found 5 results for "${query}". Top result discusses recent developments and best practices.`,
      };
      const key = Object.keys(results).find(k => query.toLowerCase().includes(k)) || 'default';
      return results[key];
    },
  },
  {
    name: 'calculate',
    description: 'Perform mathematical calculations',
    cost: 1,
    execute: async (expression) => {
      await sleep(100);
      try {
        // Safe eval for simple math
        const result = Function('"use strict"; return (' + expression.replace(/[^0-9+\-*/().]/g, '') + ')')();
        return `${expression} = ${result}`;
      } catch {
        return `Could not calculate: ${expression}`;
      }
    },
  },
  {
    name: 'get_time',
    description: 'Get current date and time',
    cost: 1,
    execute: async () => {
      return `Current time: ${new Date().toLocaleString()}`;
    },
  },
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// AI Agent with ProceedGate + Groq
// ============================================================================

class GatedGroqAgent {
  constructor(groqClient, gateClient) {
    this.groq = groqClient;
    this.gate = gateClient;
    this.conversationHistory = [];
    this.totalLLMCalls = 0;
    this.totalToolCalls = 0;
    
    this.systemPrompt = `You are a helpful AI assistant with access to tools.

Available tools:
${tools.map(t => `- ${t.name}: ${t.description}`).join('\n')}

When you need to use a tool, respond ONLY with this exact format:
[TOOL: tool_name(argument)]

For example:
[TOOL: search_web(AI cost management)]
[TOOL: calculate(25 * 4)]
[TOOL: get_time()]

If you don't need a tool, just respond normally.
Keep responses concise and helpful.`;
  }

  async chat(userMessage) {
    console.log(`\n👤 User: ${userMessage}`);
    
    // Gate check for LLM call (2 credits per LLM call - it's a real API call!)
    const llmCheck = await this.gate.check('llm_call', { 
      model: 'llama-3.1-8b-instant',
      provider: 'groq',
      cost: 2,
    });
    
    if (!llmCheck.allowed) {
      console.log(`\n🚫 LLM call BLOCKED: ${llmCheck.reason}`);
      console.log(`   Credits remaining: ${llmCheck.credits_remaining}`);
      return { blocked: true, reason: llmCheck.reason };
    }

    this.totalLLMCalls++;
    this.conversationHistory.push({ role: 'user', content: userMessage });

    // Call Groq
    console.log(`\n⏳ Calling Groq (llama-3.1-8b-instant)...`);
    
    try {
      const response = await this.groq.chat([
        { role: 'system', content: this.systemPrompt },
        ...this.conversationHistory,
      ]);

      const assistantMessage = response.content;
      this.conversationHistory.push({ role: 'assistant', content: assistantMessage });

      console.log(`\n🤖 Agent: ${assistantMessage}`);
      console.log(`   ✓ LLM call allowed (credits: ${llmCheck.credits_remaining}, tokens: ${response.usage?.total_tokens || '?'})`);

      // Check for tool calls
      const toolMatch = assistantMessage.match(/\[TOOL:\s*(\w+)\((.*?)\)\]/);
      if (toolMatch) {
        const [, toolName, toolArgs] = toolMatch;
        const toolResult = await this.executeTool(toolName, toolArgs);
        
        // If tool succeeded, get LLM to process the result
        if (toolResult && !toolResult.blocked) {
          this.conversationHistory.push({ 
            role: 'user', 
            content: `Tool result: ${toolResult.result}. Please summarize this for the user.` 
          });
          
          // Another LLM call to process tool result
          const processCheck = await this.gate.check('llm_call', { 
            model: 'llama-3.1-8b-instant',
            provider: 'groq',
            cost: 2,
          });
          
          if (processCheck.allowed) {
            this.totalLLMCalls++;
            const followUp = await this.groq.chat([
              { role: 'system', content: 'Summarize the tool result concisely for the user.' },
              ...this.conversationHistory,
            ]);
            console.log(`\n🤖 Agent (summary): ${followUp.content}`);
            console.log(`   ✓ Follow-up LLM (credits: ${processCheck.credits_remaining})`);
            this.conversationHistory.push({ role: 'assistant', content: followUp.content });
          }
        }
      }

      return { blocked: false, message: assistantMessage };
      
    } catch (error) {
      console.error(`\n❌ Groq API Error: ${error.message}`);
      return { blocked: false, error: error.message };
    }
  }

  async executeTool(toolName, args) {
    const tool = tools.find(t => t.name === toolName);
    if (!tool) {
      console.log(`\n⚠️  Unknown tool: ${toolName}`);
      return null;
    }

    console.log(`\n🔧 Tool: ${toolName}(${args}) [cost: ${tool.cost} credits]`);

    // Gate check for tool call
    const toolCheck = await this.gate.check('tool_call', {
      tool: toolName,
      cost: tool.cost,
    });

    if (!toolCheck.allowed) {
      console.log(`   🚫 BLOCKED: ${toolCheck.reason}`);
      return { blocked: true };
    }

    this.totalToolCalls++;
    const result = await tool.execute(args);
    console.log(`   ✅ Result: ${result}`);
    console.log(`   ✓ Tool allowed (credits: ${toolCheck.credits_remaining})`);
    
    return { blocked: false, result };
  }

  getStats() {
    return {
      llmCalls: this.totalLLMCalls,
      toolCalls: this.totalToolCalls,
      gateStats: this.gate.getStats(),
    };
  }
}

// ============================================================================
// Main Demo
// ============================================================================

async function main() {
  console.log('═'.repeat(70));
  console.log('🚀 ProceedGate + Groq AI Agent Demo (REAL LLM!)');
  console.log('═'.repeat(70));
  console.log('This demo uses a REAL LLM (Groq) with ProceedGate cost control.');
  console.log('Model: llama-3.1-8b-instant (free, fast)');

  // Initialize clients
  const groq = new GroqClient(GROQ_API_KEY);
  const gate = new ProceedGateClient(PROCEEDGATE_URL, PROCEEDGATE_API_KEY);

  // Check initial balance
  console.log('\n📊 Initial Balance');
  console.log('─'.repeat(70));
  const balance = await gate.getBalance();
  console.log(`   Workspace: ${balance.workspace_id}`);
  console.log(`   Plan: ${balance.plan_name}`);
  console.log(`   Credits: ${balance.credits} / ${balance.max_credits}`);

  // Create gated agent
  const agent = new GatedGroqAgent(groq, gate);

  // Demo tasks - real questions for the LLM
  console.log('\n' + '═'.repeat(70));
  console.log('📋 Agent Tasks (Real LLM Responses!)');
  console.log('═'.repeat(70));

  const tasks = [
    "What is 25 times 17?",
    "Search for information about AI cost management",
    "What time is it right now?",
    "Can you explain in 2 sentences why cost governance matters for AI agents?",
  ];

  let blocked = false;
  for (let i = 0; i < tasks.length; i++) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`Task ${i + 1}/${tasks.length}`);
    console.log('─'.repeat(70));
    
    const result = await agent.chat(tasks[i]);
    
    if (result.blocked) {
      blocked = true;
      console.log('\n' + '═'.repeat(70));
      console.log('⛔ AGENT STOPPED - Out of Credits');
      console.log('═'.repeat(70));
      console.log('   ProceedGate blocked the agent!');
      console.log('   Upgrade at: https://proceedgate.dev/pay');
      break;
    }

    await sleep(500);
  }

  // Final stats
  console.log('\n' + '═'.repeat(70));
  console.log('📈 Session Summary');
  console.log('═'.repeat(70));
  
  const stats = agent.getStats();
  console.log(`   Real LLM Calls:    ${stats.llmCalls}`);
  console.log(`   Tool Calls:        ${stats.toolCalls}`);
  console.log(`   Total Gate Checks: ${stats.gateStats.checks}`);
  console.log(`   ✅ Allowed:        ${stats.gateStats.allowed}`);
  console.log(`   🚫 Blocked:        ${stats.gateStats.blocked}`);
  console.log(`   💰 Credits Used:   ${stats.gateStats.creditsUsed}`);

  // Final balance
  const finalBalance = await gate.getBalance();
  console.log(`\n   Starting Credits:  ${balance.credits}`);
  console.log(`   Final Credits:     ${finalBalance.credits}`);
  console.log(`   Credits Spent:     ${balance.credits - finalBalance.credits}`);

  if (!blocked) {
    console.log('\n✅ All tasks completed with REAL LLM responses!');
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
