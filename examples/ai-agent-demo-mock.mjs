#!/usr/bin/env node
/**
 * ProceedGate AI Agent Demo (Mock LLM)
 * 
 * This demo simulates an AI agent to test ProceedGate cost governance
 * without requiring an OpenAI API key.
 * 
 * Usage:
 *   node examples/ai-agent-demo-mock.mjs
 * 
 * Required env vars:
 *   PROCEEDGATE_API_KEY   - Your ProceedGate API key (get free at proceedgate.dev)
 */

// ============================================================================
// Configuration
// ============================================================================

const PROCEEDGATE_URL = process.env.PROCEEDGATE_URL || 'https://governor.proceedgate.dev';
const PROCEEDGATE_API_KEY = process.env.PROCEEDGATE_API_KEY;

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
        user_id: metadata.user_id || 'agent-session',
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
    // Normalize response
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
// Mock LLM Responses (simulating GPT-4)
// ============================================================================

const mockResponses = [
  {
    trigger: /search.*information|find.*about/i,
    response: "I'll search for that information. [TOOL: search_web(AI cost management)]",
  },
  {
    trigger: /analyze|trend/i,
    response: "Let me analyze the data from the search. [TOOL: analyze_data(search results)]",
  },
  {
    trigger: /report|generate/i,
    response: "I'll generate a comprehensive report for you. [TOOL: generate_report(AI governance)]",
  },
  {
    trigger: /email|send|summary/i,
    response: "I'll send that email summary right away. [TOOL: send_email(team@example.com, AI Governance Summary)]",
  },
  {
    trigger: /hello|hi|hey/i,
    response: "Hello! I'm an AI assistant with cost-governed tools. How can I help you today?",
  },
];

function getMockLLMResponse(input) {
  for (const mock of mockResponses) {
    if (mock.trigger.test(input)) {
      return mock.response;
    }
  }
  return "I understand. Let me help you with that task.";
}

// ============================================================================
// Tools (simulating real agent tools)
// ============================================================================

const tools = [
  {
    name: 'search_web',
    description: 'Search the web for information',
    cost: 2,
    execute: async (query) => {
      await sleep(300);
      return `Search results for "${query}": Found 3 relevant articles about AI cost management and governance best practices.`;
    },
  },
  {
    name: 'analyze_data',
    description: 'Analyze data and provide insights',
    cost: 3,
    execute: async (data) => {
      await sleep(200);
      return `Analysis complete: AI governance adoption is growing 45% YoY. Key trends: budget controls, usage limits, and audit trails.`;
    },
  },
  {
    name: 'send_email',
    description: 'Send an email',
    cost: 1,
    execute: async (recipient, subject) => {
      await sleep(100);
      return `Email sent to ${recipient} with subject "${subject}"`;
    },
  },
  {
    name: 'generate_report',
    description: 'Generate a detailed report',
    cost: 5,
    execute: async (topic) => {
      await sleep(400);
      return `Report generated: "${topic}" - Executive summary, 3 key findings, and 5 recommendations.`;
    },
  },
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// AI Agent with ProceedGate Integration
// ============================================================================

class GatedAIAgent {
  constructor(gateClient) {
    this.gate = gateClient;
    this.conversationHistory = [];
    this.totalLLMCalls = 0;
    this.totalToolCalls = 0;
  }

  async chat(userMessage) {
    console.log(`\n👤 User: ${userMessage}`);
    
    // Gate check for LLM call (1 credit per LLM call)
    const llmCheck = await this.gate.check('llm_call', { 
      model: 'gpt-4o-mini',
      cost: 1,
    });
    
    if (!llmCheck.allowed) {
      console.log(`\n🚫 LLM call BLOCKED: ${llmCheck.reason}`);
      console.log(`   Credits remaining: ${llmCheck.credits_remaining}`);
      return { blocked: true, reason: llmCheck.reason };
    }

    this.totalLLMCalls++;
    
    // Simulate LLM thinking
    await sleep(200);
    
    // Get mock response
    const assistantMessage = getMockLLMResponse(userMessage);
    this.conversationHistory.push({ role: 'user', content: userMessage });
    this.conversationHistory.push({ role: 'assistant', content: assistantMessage });

    console.log(`\n🤖 Agent: ${assistantMessage}`);
    console.log(`   ✓ LLM call allowed (credits: ${llmCheck.credits_remaining})`);

    // Check for tool calls
    const toolMatch = assistantMessage.match(/\[TOOL:\s*(\w+)\((.*?)\)\]/);
    if (toolMatch) {
      const [, toolName, toolArgs] = toolMatch;
      await this.executeTool(toolName, toolArgs);
    }

    return { blocked: false, message: assistantMessage };
  }

  async executeTool(toolName, args) {
    const tool = tools.find(t => t.name === toolName);
    if (!tool) {
      console.log(`\n⚠️  Unknown tool: ${toolName}`);
      return;
    }

    console.log(`\n🔧 Tool: ${toolName} (cost: ${tool.cost} credits)`);

    // Gate check for tool call
    const toolCheck = await this.gate.check('tool_call', {
      tool: toolName,
      cost: tool.cost,
    });

    if (!toolCheck.allowed) {
      console.log(`   🚫 BLOCKED: ${toolCheck.reason}`);
      console.log(`   Credits remaining: ${toolCheck.credits_remaining}`);
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
  console.log('🚀 ProceedGate AI Agent Demo (Mock LLM)');
  console.log('═'.repeat(70));
  console.log('This demo shows how ProceedGate controls AI agent costs.');
  console.log('Each LLM call costs 1 credit. Tools cost 1-5 credits.');

  // Initialize gate client
  const gate = new ProceedGateClient(PROCEEDGATE_URL, PROCEEDGATE_API_KEY);

  // Check initial balance
  console.log('\n📊 Initial Balance');
  console.log('─'.repeat(70));
  const balance = await gate.getBalance();
  console.log(`   Workspace: ${balance.workspace_id}`);
  console.log(`   Plan: ${balance.plan_name}`);
  console.log(`   Credits: ${balance.credits} / ${balance.max_credits}`);

  if (balance.credits < 20) {
    console.log('\n⚠️  Warning: Low credits! The agent may be blocked during this demo.');
  }

  // Create gated agent
  const agent = new GatedAIAgent(gate);

  // Demo tasks
  console.log('\n' + '═'.repeat(70));
  console.log('📋 Agent Tasks');
  console.log('═'.repeat(70));

  const tasks = [
    "Hello! Can you search for information about AI cost management?",
    "Analyze the trends in that data",
    "Generate a report on AI governance best practices",
    "Send an email summary to team@example.com",
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
      console.log('   This is ProceedGate in action!');
      console.log('   The agent was blocked before it could run up costs.');
      console.log('\n   To continue: Upgrade at https://proceedgate.dev/pay');
      break;
    }

    await sleep(500);
  }

  // Final stats
  console.log('\n' + '═'.repeat(70));
  console.log('📈 Session Summary');
  console.log('═'.repeat(70));
  
  const stats = agent.getStats();
  console.log(`   LLM Calls Made:    ${stats.llmCalls}`);
  console.log(`   Tool Calls Made:   ${stats.toolCalls}`);
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
    console.log('\n✅ All tasks completed successfully!');
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
