/**
 * MCP Discovery Routes
 * 
 * Provides endpoint for MCP server configuration and agent discovery.
 */

import { Hono } from 'hono';
import type { Env, Vars } from '../types.js';
import { getSupportedProviders } from '../lib/providerPricing.js';
import { generateOpenApiSpec } from '../lib/openapi.js';

const mcpRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

// MCP server configuration endpoint
mcpRoutes.get('/mcp', (c) => {
  const origin = new URL(c.req.url).origin;

  return c.json({
    name: 'ProceedGate',
    description: 'Cost governance and budget control for AI agents. Stop runaway costs before they happen.',
    version: '1.0.0',
    
    tools: [
      {
        name: 'gate_check',
        description: 'Check if an action is allowed under current budget/policy. Call BEFORE any costly action (LLM calls, tool invocations, API calls).',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['llm_call', 'tool_call', 'browser_action', 'api_call'],
              description: 'Type of action to check',
            },
            policy_id: {
              type: 'string',
              enum: ['retry_friction_v1', 'low_confidence_v1', 'llm_cost_v1'],
              description: 'Policy to evaluate against',
            },
            model: {
              type: 'string',
              description: 'LLM model name (for llm_call actions)',
            },
            tool: {
              type: 'string',
              description: 'Tool name (for tool_call actions)',
            },
            input_tokens: {
              type: 'integer',
              description: 'Estimated input tokens',
            },
            output_tokens: {
              type: 'integer',
              description: 'Estimated output tokens',
            },
            confidence: {
              type: 'number',
              description: 'Confidence score 0-1',
            },
          },
          required: ['action'],
        },
      },
      {
        name: 'gate_redeem',
        description: 'Resolve friction and get proceed token after payment/approval',
        inputSchema: {
          type: 'object',
          properties: {
            decision_id: {
              type: 'string',
              description: 'Decision ID from gate_check',
            },
            tx_hash: {
              type: 'string',
              description: 'Transaction hash or approval token',
            },
          },
          required: ['decision_id', 'tx_hash'],
        },
      },
      {
        name: 'get_balance',
        description: 'Get current credit balance and usage statistics',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'set_budget',
        description: 'Configure spending budget limits',
        inputSchema: {
          type: 'object',
          properties: {
            daily_limit: {
              type: 'integer',
              description: 'Daily spending cap in credits',
            },
            weekly_limit: {
              type: 'integer',
              description: 'Weekly spending cap in credits',
            },
            monthly_limit: {
              type: 'integer',
              description: 'Monthly spending cap in credits',
            },
            alert_threshold: {
              type: 'integer',
              description: 'Alert at this percentage (0-100)',
            },
          },
        },
      },
      {
        name: 'get_usage_report',
        description: 'Get detailed usage breakdown for analysis',
        inputSchema: {
          type: 'object',
          properties: {
            period: {
              type: 'string',
              enum: ['today', 'week', 'month', 'all'],
              description: 'Report period',
            },
          },
        },
      },
    ],

    policies: [
      {
        id: 'retry_friction_v1',
        description: 'Applies friction after multiple retries to prevent runaway loops',
        pricing: {
          free_attempts: 3,
          base_price: '0.004 USDC',
          growth_factor: 2,
        },
      },
      {
        id: 'low_confidence_v1',
        description: 'Applies friction for low-confidence actions',
        pricing: {
          confidence_threshold: 0.6,
          base_price: '0.002 USDC',
        },
      },
      {
        id: 'llm_cost_v1',
        description: 'Tracks actual LLM costs with markup for governance overhead',
        pricing: {
          markup: '20%',
          free_threshold: '0.001 USD',
        },
      },
    ],

    supported_providers: getSupportedProviders(),

    endpoints: {
      check: `${origin}/v1/governor/check`,
      redeem: `${origin}/v1/governor/redeem`,
      jwks: `${origin}/.well-known/jwks.json`,
      balance: `${origin}/v1/billing/balance`,
      budget: `${origin}/v1/billing/budget`,
      usage: `${origin}/v1/billing/usage`,
    },

    auth: {
      type: 'bearer',
      header: 'Authorization',
      description: 'API key authentication. Pass as Bearer token.',
    },

    sdks: {
      mcp_server: {
        package: '@proceedgate/mcp-server',
        install: 'npm install -g @proceedgate/mcp-server',
      },
      node: {
        package: '@proceedgate/node',
        install: 'npm install @proceedgate/node',
      },
      langchain: {
        package: '@proceedgate/langchain',
        install: 'npm install @proceedgate/langchain',
      },
      crewai: {
        package: 'proceedgate-crewai',
        install: 'pip install proceedgate-crewai',
      },
    },

    claude_desktop_config: {
      mcpServers: {
        proceedgate: {
          command: 'npx',
          args: [
            '-y',
            '@proceedgate/mcp-server',
            '--api-key',
            'YOUR_API_KEY',
          ],
        },
      },
    },
  });
});

// Health check
mcpRoutes.get('/health', (c) => {
  return c.json({ ok: true });
});

// OpenAPI spec
mcpRoutes.get('/openapi.json', (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json(generateOpenApiSpec(origin));
});

// OpenAPI UI (Swagger)
mcpRoutes.get('/openapi', (c) => {
  const origin = new URL(c.req.url).origin;
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ProceedGate API Documentation</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  <style>
    body { margin: 0; background: #1a1a2e; }
    .swagger-ui .topbar { display: none; }
    .swagger-ui { max-width: 1200px; margin: 0 auto; padding: 20px; }
    .swagger-ui .info .title { color: #2dd4bf; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '${origin}/openapi.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'StandaloneLayout'
    });
  </script>
</body>
</html>`);
});

export { mcpRoutes };
