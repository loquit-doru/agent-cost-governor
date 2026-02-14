#!/usr/bin/env node
/**
 * ProceedGate AI Agent Demo
 * 
 * This demo shows a real AI agent (using OpenAI) with ProceedGate cost governance.
 * Every LLM call and tool use is gated - if credits run low, the agent stops.
 * 
 * Usage:
 *   node examples/ai-agent-demo.mjs
 * 
 * Required env vars:
 *   OPENAI_API_KEY        - Your OpenAI API key
 *   PROCEEDGATE_API_KEY   - Your ProceedGate API key (get free at proceedgate.dev)
 */

import OpenAI from 'openai';

// ============================================================================
// Configuration
// ============================================================================

const PROCEEDGATE_URL = process.env.PROCEEDGATE_URL || 'https://governor.proceedgate.dev';
const PROCEEDGATE_API_KEY = process.env.PROCEEDGATE_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY environment variable');
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
    return res.json();
  }

  getStats() {
    return this.stats;
  }
}

// ============================================================================
// Mock Tools (simulating real agent tools)
// ============================================================================

const tools = [
  {
    name: 'search_web',
    description: 'Search the web for information',
    cost: 2, // Web searches cost 2 credits
    execute: async (query) => {
      // Simulate web search
      await sleep(500);
      return `Search results for "${query}": Found 3 relevant articles about ${query}.`;
    },
  },
  {
    name: 'analyze_data',
    description: 'Analyze data and provide insights',
    cost: 3, // Analysis costs 3 credits
    execute: async (data) => {
      await sleep(300);
      return `Analysis complete: The data shows a positive trend with 15% growth.`;
    },
  },
  {
    name: 'send_email',
    description: 'Send an email to a recipient',
    cost: 1, // Emails cost 1 credit
    execute: async (recipient, subject) => {
      await sleep(200);
      return `Email sent to ${recipient} with subject "${subject}"`;
    },
  },
  {
    name: 'generate_report',
    description: 'Generate a detailed report',
    cost: 5, // Reports cost 5 credits
    execute: async (topic) => {
      await sleep(800);
      return `Report generated: "${topic}" - 3 pages with charts and recommendations.`;
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
  constructor(openaiClient, gateClient) {
    this.openai = openaiClient;
    this.gate = gateClient;
    this.conversationHistory = [];
    this.totalLLMCalls = 0;
    this.totalToolCalls = 0;
  }

  async chat(userMessage) {
    console.log(`\n👤 User: ${userMessage}`);
    
    // Gate check for LLM call
    const llmCheck = await this.gate.check('llm_call', { 
      model: 'gpt-4o-mini',
      cost: 1,
    });
    
    if (!llmCheck.allowed) {
      console.log(`\n🚫 LLM call blocked: ${llmCheck.reason}`);
      console.log(`   Credits remaining: ${llmCheck.credits_remaining}`);
      return { blocked: true, reason: llmCheck.reason };
    }

    this.totalLLMCalls++;
    this.conversationHistory.push({ role: 'user', content: userMessage });

    // Call OpenAI
    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a helpful AI assistant with access to tools. 
Available tools: ${tools.map(t => `${t.name} (${t.description})`).join(', ')}.
When you need to use a tool, respond with: [TOOL: tool_name(args)]
Keep responses concise.`,
        },
        ...this.conversationHistory,
      ],
      max_tokens: 300,
    });

    const assistantMessage = response.choices[0].message.content;
    this.conversationHistory.push({ role: 'assistant', content: assistantMessage });

    console.log(`\n🤖 Agent: ${assistantMessage}`);
    console.log(`   (Credits remaining: ${llmCheck.credits_remaining})`);

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

    console.log(`\n🔧 Executing tool: ${toolName} (cost: ${tool.cost} credits)`);

    // Gate check for tool call
    const toolCheck = await this.gate.check('tool_call', {
      tool: toolName,
      cost: tool.cost,
    });

    if (!toolCheck.allowed) {
      console.log(`   🚫 Tool blocked: ${toolCheck.reason}`);
      console.log(`   Credits remaining: ${toolCheck.credits_remaining}`);
      this.conversationHistory.push({
        role: 'system',
        content: `Tool ${toolName} was blocked due to insufficient credits.`,
      });
      return;
    }

    this.totalToolCalls++;
    const result = await tool.execute(args);
    console.log(`   ✅ Result: ${result}`);
    console.log(`   (Credits remaining: ${toolCheck.credits_remaining})`);

    this.conversationHistory.push({
      role: 'system',
      content: `Tool ${toolName} result: ${result}`,
    });
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
  console.log('═'.repeat(60));
  console.log('🚀 ProceedGate AI Agent Demo');
  console.log('═'.repeat(60));

  // Initialize clients
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  const gate = new ProceedGateClient(PROCEEDGATE_URL, PROCEEDGATE_API_KEY);

  // Check initial balance
  console.log('\n📊 Checking initial balance...');
  const balance = await gate.getBalance();
  console.log(`   Workspace: ${balance.workspace_id}`);
  console.log(`   Plan: ${balance.plan_name}`);
  console.log(`   Credits: ${balance.credits} / ${balance.max_credits}`);

  if (balance.credits < 10) {
    console.log('\n⚠️  Low credits! The agent may be blocked soon.');
  }

  // Create gated agent
  const agent = new GatedAIAgent(openai, gate);

  // Demo conversation
  console.log('\n' + '─'.repeat(60));
  console.log('Starting agent conversation...');
  console.log('─'.repeat(60));

  const tasks = [
    "Hello! Can you search for information about AI cost management?",
    "Based on that, can you analyze the current trends?",
    "Great, now generate a report on AI governance best practices.",
    "Finally, send an email summary to team@example.com",
  ];

  for (const task of tasks) {
    const result = await agent.chat(task);
    
    if (result.blocked) {
      console.log('\n' + '═'.repeat(60));
      console.log('⛔ Agent stopped: Out of credits');
      console.log('   Upgrade at: https://proceedgate.dev/pay');
      break;
    }

    // Small delay between tasks
    await sleep(1000);
  }

  // Final stats
  console.log('\n' + '═'.repeat(60));
  console.log('📈 Session Summary');
  console.log('═'.repeat(60));
  
  const stats = agent.getStats();
  console.log(`   LLM Calls: ${stats.llmCalls}`);
  console.log(`   Tool Calls: ${stats.toolCalls}`);
  console.log(`   Gate Checks: ${stats.gateStats.checks}`);
  console.log(`   Allowed: ${stats.gateStats.allowed}`);
  console.log(`   Blocked: ${stats.gateStats.blocked}`);
  console.log(`   Credits Used: ${stats.gateStats.creditsUsed}`);

  // Final balance
  const finalBalance = await gate.getBalance();
  console.log(`\n   Final Credits: ${finalBalance.credits} / ${finalBalance.max_credits}`);
}

main().catch(console.error);
