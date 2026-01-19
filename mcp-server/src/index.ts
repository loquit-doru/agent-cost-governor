#!/usr/bin/env node

/**
 * ProceedGate MCP Server
 * 
 * Exposes ProceedGate cost governance as MCP tools for AI agents.
 * Allows Claude and other MCP-compatible agents to:
 * - Check if actions are allowed under budget/policy
 * - Resolve friction (payment) to proceed
 * - Monitor and manage spending budgets
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { ProceedGateClient } from './client.js';
import { tools, handleToolCall } from './tools.js';

// Parse CLI arguments
function parseArgs(): { apiKey?: string; baseUrl?: string; workspaceId?: string } {
  const args = process.argv.slice(2);
  const result: { apiKey?: string; baseUrl?: string; workspaceId?: string } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    if (arg === '--api-key' && nextArg) {
      result.apiKey = nextArg;
      i++;
    } else if (arg === '--base-url' && nextArg) {
      result.baseUrl = nextArg;
      i++;
    } else if (arg === '--workspace-id' && nextArg) {
      result.workspaceId = nextArg;
      i++;
    }
  }

  return result;
}

async function main() {
  const cliArgs = parseArgs();

  // Get configuration from CLI args or environment
  const apiKey = cliArgs.apiKey || process.env.PROCEEDGATE_API_KEY;
  const baseUrl = cliArgs.baseUrl || process.env.PROCEEDGATE_BASE_URL || 'https://governor.proceedgate.dev';
  const workspaceId = cliArgs.workspaceId || process.env.PROCEEDGATE_WORKSPACE_ID || 'default';

  if (!apiKey) {
    console.error('Error: API key required. Use --api-key or set PROCEEDGATE_API_KEY environment variable.');
    process.exit(1);
  }

  // Initialize client
  const client = new ProceedGateClient({
    apiKey,
    baseUrl,
    workspaceId,
  });

  // Create MCP server
  const server = new Server(
    {
      name: 'proceedgate-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tool listing handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
  });

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await handleToolCall(client, name, args || {});
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new McpError(ErrorCode.InternalError, errorMessage);
    }
  });

  // Connect to transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('ProceedGate MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
