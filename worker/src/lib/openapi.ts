/**
 * OpenAPI 3.1 Specification for ProceedGate Governor API
 */

export function generateOpenApiSpec(origin: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'ProceedGate Governor API',
      version: '1.0.0',
      description: `ProceedGate is an economic governor for AI agents - a hard gate that blocks expensive steps unless the agent has a short-lived \`proceed_token\`.

## Core Concept

Every decision check returns either:
- \`200\` (allowed) + \`proceed_token\` — agent can proceed
- \`402\` (friction required) + x402 headers — agent must pay or get approval

## Billing

ProceedGate uses a prepaid credits model:
- 1 credit = 1 governor check
- Top up via USDC on Base
- 10 microUSDC ($0.00001) per credit

## Authentication

Production uses per-workspace API keys:
- Create workspace via admin endpoint
- Include API key in \`Authorization: Bearer <key>\` header`,
      contact: {
        name: 'ProceedGate',
        url: 'https://proceedgate.dev',
      },
      license: {
        name: 'Proprietary',
        url: 'https://proceedgate.dev/terms',
      },
    },
    servers: [
      {
        url: origin,
        description: 'Current server',
      },
      {
        url: 'https://governor.proceedgate.dev',
        description: 'Production',
      },
    ],
    tags: [
      { name: 'Governor', description: 'Core decision check and redeem endpoints' },
      { name: 'Billing', description: 'Credits, quotes, and payment endpoints' },
      { name: 'Budgets', description: 'Budget limits and alerts' },
      { name: 'Admin', description: 'Workspace provisioning (requires admin key)' },
      { name: 'Discovery', description: 'MCP, JWKS, and health endpoints' },
    ],
    paths: {
      '/v1/governor/check': {
        post: {
          tags: ['Governor'],
          summary: 'Check if action is allowed',
          description: 'Submit a decision request. Returns 200 with proceed_token if allowed, or 402 with payment info if friction is required.',
          operationId: 'governorCheck',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CheckRequest' },
                example: {
                  policy_id: 'retry_friction_v1',
                  action: 'model_call',
                  actor: { id: 'agent:my-bot', project: 'acme' },
                  context: {
                    attempt_in_window: 1,
                    model: 'gpt-4o',
                    tool: 'web_search',
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Action allowed',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/CheckAllowed' },
                },
              },
            },
            '402': {
              description: 'Friction required (payment needed)',
              headers: {
                'x402-price': { schema: { type: 'string' }, description: 'Required payment amount' },
                'x402-recipient': { schema: { type: 'string' }, description: 'Payment recipient address' },
                'x402-chain': { schema: { type: 'string' }, description: 'Blockchain network' },
              },
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/CheckFriction' },
                },
              },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '400': { $ref: '#/components/responses/BadRequest' },
          },
        },
      },
      '/v1/governor/redeem': {
        post: {
          tags: ['Governor'],
          summary: 'Redeem payment for proceed token',
          description: 'After paying the required friction, redeem the decision_id with your tx_hash to get a proceed_token.',
          operationId: 'governorRedeem',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RedeemRequest' },
                example: {
                  decision_id: 'dec_abc123',
                  tx_hash: '0x1234...abcd',
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Payment verified, token issued',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/RedeemSuccess' },
                },
              },
            },
            '400': { $ref: '#/components/responses/BadRequest' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '404': {
              description: 'Decision not found or expired',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Error' },
                },
              },
            },
          },
        },
      },
      '/v1/billing/balance': {
        get: {
          tags: ['Billing'],
          summary: 'Get workspace credit balance',
          operationId: 'getBalance',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'workspace_id',
              in: 'query',
              required: true,
              schema: { type: 'string' },
              description: 'Workspace identifier',
            },
          ],
          responses: {
            '200': {
              description: 'Current balance',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/BalanceResponse' },
                },
              },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/v1/billing/quote': {
        post: {
          tags: ['Billing'],
          summary: 'Create payment quote for credits',
          description: 'Generate a quote to purchase credits. Returns payment address and amount.',
          operationId: 'createQuote',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/QuoteRequest' },
                example: {
                  workspace_id: 'acme',
                  credits: 10000,
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Quote created',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/QuoteResponse' },
                },
              },
            },
            '400': { $ref: '#/components/responses/BadRequest' },
            '401': { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/v1/billing/redeem': {
        post: {
          tags: ['Billing'],
          summary: 'Redeem payment quote for credits',
          description: 'After paying the quote, submit tx_hash to credit your workspace.',
          operationId: 'redeemQuote',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/BillingRedeemRequest' },
                example: {
                  quote_id: 'quote_xyz789',
                  tx_hash: '0x1234...abcd',
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Credits added',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/BillingRedeemResponse' },
                },
              },
            },
            '400': { $ref: '#/components/responses/BadRequest' },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '404': {
              description: 'Quote not found or expired',
            },
          },
        },
      },
      '/v1/billing/usage': {
        get: {
          tags: ['Billing'],
          summary: 'Get usage statistics',
          operationId: 'getUsage',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'workspace_id',
              in: 'query',
              required: true,
              schema: { type: 'string' },
            },
            {
              name: 'days',
              in: 'query',
              schema: { type: 'integer', default: 7 },
              description: 'Number of days of history',
            },
          ],
          responses: {
            '200': {
              description: 'Usage statistics',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/UsageResponse' },
                },
              },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/v1/billing/budget': {
        get: {
          tags: ['Budgets'],
          summary: 'Get budget configuration',
          operationId: 'getBudget',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'workspace_id',
              in: 'query',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'Budget configuration',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/BudgetConfig' },
                },
              },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
          },
        },
        post: {
          tags: ['Budgets'],
          summary: 'Set budget limits',
          operationId: 'setBudget',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SetBudgetRequest' },
                example: {
                  workspace_id: 'acme',
                  daily_limit: 1000,
                  alert_threshold: 80,
                  webhook_url: 'https://example.com/webhook',
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Budget updated',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/BudgetConfig' },
                },
              },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/v1/workspaces/create': {
        post: {
          tags: ['Admin'],
          summary: 'Create new workspace',
          description: 'Provision a new workspace with API key. Requires admin key.',
          operationId: 'createWorkspace',
          security: [{ adminKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    workspace_id: {
                      type: 'string',
                      description: 'Unique workspace identifier',
                    },
                  },
                  required: ['workspace_id'],
                },
                example: { workspace_id: 'acme-corp' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Workspace created',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      workspace_id: { type: 'string' },
                      api_key: { type: 'string', description: 'Save this! Only shown once.' },
                    },
                  },
                },
              },
            },
            '401': { $ref: '#/components/responses/Unauthorized' },
            '409': {
              description: 'Workspace already exists',
            },
          },
        },
      },
      '/v1/pricing/models': {
        get: {
          tags: ['Discovery'],
          summary: 'Get LLM model pricing',
          description: 'Returns pricing for supported LLM models (per 1K tokens).',
          operationId: 'getModelPricing',
          responses: {
            '200': {
              description: 'Model pricing list',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    additionalProperties: {
                      $ref: '#/components/schemas/ModelPricing',
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/.well-known/jwks.json': {
        get: {
          tags: ['Discovery'],
          summary: 'Get JWKS public keys',
          description: 'Public keys for verifying proceed_token JWTs.',
          operationId: 'getJwks',
          responses: {
            '200': {
              description: 'JWKS',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      keys: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/JWK' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/mcp': {
        get: {
          tags: ['Discovery'],
          summary: 'MCP server configuration',
          description: 'Returns MCP tool definitions for AI agents.',
          operationId: 'getMcpConfig',
          responses: {
            '200': {
              description: 'MCP configuration',
            },
          },
        },
      },
      '/health': {
        get: {
          tags: ['Discovery'],
          summary: 'Health check',
          operationId: 'healthCheck',
          responses: {
            '200': {
              description: 'Service healthy',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean', example: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Workspace API key',
        },
        adminKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-admin-key',
          description: 'Admin API key for workspace provisioning',
        },
      },
      schemas: {
        CheckRequest: {
          type: 'object',
          required: ['policy_id', 'action', 'actor', 'context'],
          properties: {
            policy_id: {
              type: 'string',
              enum: ['retry_friction_v1', 'low_confidence_loop_v1'],
              description: 'Policy to evaluate',
            },
            action: {
              type: 'string',
              enum: ['model_call', 'tool_call', 'retry', 'override', 'plan_execute'],
              description: 'Type of action',
            },
            actor: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Actor identifier' },
                project: { type: 'string', description: 'Project/workspace ID' },
              },
              required: ['id'],
            },
            context: {
              type: 'object',
              properties: {
                attempt_in_window: { type: 'integer', description: 'Retry attempt number' },
                confidence: { type: 'number', description: 'Confidence score 0-1' },
                model: { type: 'string', description: 'LLM model name' },
                tool: { type: 'string', description: 'Tool name' },
                task_hash: { type: 'string', description: 'SHA256 of task' },
                step_hash: { type: 'string', description: 'SHA256 of step' },
                context_hash: { type: 'string', description: 'SHA256 of context' },
              },
              required: ['attempt_in_window'],
            },
            idempotency_key: { type: 'string' },
          },
        },
        CheckAllowed: {
          type: 'object',
          properties: {
            allowed: { type: 'boolean', example: true },
            decision_id: { type: 'string' },
            proceed_token: { type: 'string', description: 'JWT valid for 45 seconds' },
            expires_in_seconds: { type: 'integer', example: 45 },
            reason_code: { type: 'string', example: 'none' },
            policy: {
              type: 'object',
              properties: {
                policy_id: { type: 'string' },
                friction_required: { type: 'boolean' },
                friction_price: { type: 'string' },
              },
            },
          },
        },
        CheckFriction: {
          type: 'object',
          properties: {
            allowed: { type: 'boolean', example: false },
            decision_id: { type: 'string' },
            reason_code: { type: 'string', example: 'retry_friction' },
            policy: {
              type: 'object',
              properties: {
                policy_id: { type: 'string' },
                friction_required: { type: 'boolean', example: true },
                friction_price: { type: 'string', example: '0.004 USDC' },
              },
            },
          },
        },
        RedeemRequest: {
          type: 'object',
          required: ['decision_id', 'tx_hash'],
          properties: {
            decision_id: { type: 'string' },
            tx_hash: { type: 'string', description: 'Blockchain transaction hash' },
          },
        },
        RedeemSuccess: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            decision_id: { type: 'string' },
            proceed_token: { type: 'string' },
            expires_in_seconds: { type: 'integer' },
          },
        },
        BalanceResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            workspace_id: { type: 'string' },
            credits: { type: 'integer', description: 'Available credits' },
            updated_at: { type: 'string', format: 'date-time' },
          },
        },
        QuoteRequest: {
          type: 'object',
          required: ['workspace_id', 'credits'],
          properties: {
            workspace_id: { type: 'string' },
            credits: { type: 'integer', minimum: 1 },
          },
        },
        QuoteResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            quote_id: { type: 'string' },
            workspace_id: { type: 'string' },
            credits: { type: 'integer' },
            required_price: { type: 'string', example: '0.10 USDC' },
            required_chain: { type: 'string', example: 'Base' },
            required_recipient: { type: 'string' },
            expires_at: { type: 'string', format: 'date-time' },
          },
        },
        BillingRedeemRequest: {
          type: 'object',
          required: ['quote_id', 'tx_hash'],
          properties: {
            quote_id: { type: 'string' },
            tx_hash: { type: 'string' },
          },
        },
        BillingRedeemResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            workspace_id: { type: 'string' },
            credits_added: { type: 'integer' },
            credits_total: { type: 'integer' },
          },
        },
        UsageResponse: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            workspace_id: { type: 'string' },
            daily: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  date: { type: 'string' },
                  credits: { type: 'integer' },
                  actions: { type: 'object' },
                  tools: { type: 'object' },
                },
              },
            },
          },
        },
        BudgetConfig: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            workspace_id: { type: 'string' },
            daily_limit: { type: 'integer', nullable: true },
            weekly_limit: { type: 'integer', nullable: true },
            monthly_limit: { type: 'integer', nullable: true },
            alert_threshold: { type: 'integer', nullable: true, description: 'Percentage 0-100' },
            webhook_url: { type: 'string', nullable: true },
          },
        },
        SetBudgetRequest: {
          type: 'object',
          required: ['workspace_id'],
          properties: {
            workspace_id: { type: 'string' },
            daily_limit: { type: 'integer' },
            weekly_limit: { type: 'integer' },
            monthly_limit: { type: 'integer' },
            alert_threshold: { type: 'integer', minimum: 0, maximum: 100 },
            webhook_url: { type: 'string', format: 'uri' },
          },
        },
        ModelPricing: {
          type: 'object',
          properties: {
            provider: { type: 'string' },
            model: { type: 'string' },
            inputPer1kTokens: { type: 'number' },
            outputPer1kTokens: { type: 'number' },
            contextWindow: { type: 'integer' },
          },
        },
        JWK: {
          type: 'object',
          properties: {
            kty: { type: 'string' },
            crv: { type: 'string' },
            x: { type: 'string' },
            y: { type: 'string' },
            use: { type: 'string' },
            alg: { type: 'string' },
            kid: { type: 'string' },
          },
        },
        Error: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', example: false },
            error: { type: 'string' },
            issues: {
              type: 'array',
              items: { type: 'object' },
            },
          },
        },
      },
      responses: {
        BadRequest: {
          description: 'Invalid request',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
        Unauthorized: {
          description: 'Authentication required or invalid',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
      },
    },
  };
}
