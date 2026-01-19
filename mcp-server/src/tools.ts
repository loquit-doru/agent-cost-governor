/**
 * MCP Tool definitions and handlers for ProceedGate
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { ProceedGateClient, CheckRequest } from './client.js';

// Tool definitions
export const tools = [
  {
    name: 'gate_check',
    description: `Check if an action is allowed under current budget/policy. Call this BEFORE executing any costly action (LLM calls, API calls, browser automation, tool calls).

Returns either:
- ALLOWED: With a proceed_token valid for 45 seconds
- FRICTION: Action blocked, requires payment or approval to proceed

Use this to prevent runaway costs and enforce spending policies.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['tool_call', 'llm_call', 'browser_action', 'api_call'],
          description: 'Type of action being performed',
        },
        policy_id: {
          type: 'string',
          enum: ['retry_friction_v1', 'low_confidence_v1'],
          description: 'Policy to evaluate. retry_friction_v1 charges after retries, low_confidence_v1 charges for uncertain actions',
          default: 'retry_friction_v1',
        },
        tool: {
          type: 'string',
          description: 'Name of the tool being called (for tool_call actions)',
        },
        cost_estimate: {
          type: 'number',
          description: 'Estimated cost of this action in USD',
        },
        attempt_number: {
          type: 'number',
          description: 'Which attempt this is (1 = first try, higher = retries)',
          default: 1,
        },
        confidence: {
          type: 'number',
          description: 'Confidence score 0-1 for this action (used by low_confidence_v1 policy)',
        },
        context: {
          type: 'object',
          description: 'Additional context for the decision',
          additionalProperties: true,
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'gate_redeem',
    description: `Resolve friction and get a proceed token after payment/approval. 
Call this when gate_check returns FRICTION and you have completed payment.`,
    inputSchema: {
      type: 'object',
      properties: {
        decision_id: {
          type: 'string',
          description: 'Decision ID from the gate_check friction response',
        },
        tx_hash: {
          type: 'string',
          description: 'Transaction hash proving payment (or approval token)',
        },
      },
      required: ['decision_id', 'tx_hash'],
    },
  },
  {
    name: 'get_balance',
    description: `Get current credit balance, usage statistics, and budget status.
Use this to check remaining budget before starting expensive operations.`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'set_budget',
    description: `Set spending budget limits for the workspace. 
When a limit is reached, all actions will require friction resolution.`,
    inputSchema: {
      type: 'object',
      properties: {
        daily_limit: {
          type: 'number',
          description: 'Maximum credits to spend per day',
        },
        weekly_limit: {
          type: 'number',
          description: 'Maximum credits to spend per week',
        },
        monthly_limit: {
          type: 'number',
          description: 'Maximum credits to spend per month',
        },
        alert_threshold: {
          type: 'number',
          description: 'Percentage (0-100) at which to send alerts',
          minimum: 0,
          maximum: 100,
        },
      },
    },
  },
  {
    name: 'get_usage_report',
    description: `Get detailed usage report for cost analysis and optimization.
Shows breakdown by action type, tool, and time period.`,
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['today', 'week', 'month', 'all'],
          description: 'Time period for the report',
          default: 'today',
        },
      },
    },
  },
];

// Tool call handlers
export async function handleToolCall(
  client: ProceedGateClient,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (toolName) {
    case 'gate_check':
      return handleGateCheck(client, args);
    case 'gate_redeem':
      return handleGateRedeem(client, args);
    case 'get_balance':
      return handleGetBalance(client);
    case 'set_budget':
      return handleSetBudget(client, args);
    case 'get_usage_report':
      return handleGetUsageReport(client, args);
    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
  }
}

async function handleGateCheck(
  client: ProceedGateClient,
  args: Record<string, unknown>
): Promise<unknown> {
  const action = args.action as string;
  if (!action) {
    throw new McpError(ErrorCode.InvalidParams, 'action is required');
  }

  const policyId = (args.policy_id as string) || 'retry_friction_v1';
  const attemptNumber = (args.attempt_number as number) || 1;
  const confidence = args.confidence as number | undefined;
  const tool = args.tool as string | undefined;
  const costEstimate = args.cost_estimate as number | undefined;
  const extraContext = args.context as Record<string, unknown> | undefined;

  const request: CheckRequest = {
    policy_id: policyId,
    action,
    actor: {
      id: `mcp-agent:${client.getWorkspaceId()}`,
      project: client.getWorkspaceId(),
    },
    context: {
      attempt_in_window: attemptNumber,
      window_seconds: 30,
      confidence: confidence ?? 0.8,
      tool,
      cost_estimate: costEstimate,
      ...extraContext,
    },
  };

  const response = await client.check(request);

  if (response.allowed) {
    return {
      status: 'ALLOWED',
      message: 'Action is allowed. You may proceed.',
      decision_id: response.decision_id,
      proceed_token: response.proceed_token,
      expires_in_seconds: response.expires_in_seconds,
      policy: response.policy,
    };
  } else {
    return {
      status: 'FRICTION',
      message: 'Action blocked. Payment or approval required to proceed.',
      decision_id: response.decision_id,
      reason_code: response.reason_code,
      friction_price: response.policy.friction_price,
      redeem_url: response.redeem.url,
      instructions: 'Use gate_redeem with the decision_id and a valid tx_hash to proceed.',
    };
  }
}

async function handleGateRedeem(
  client: ProceedGateClient,
  args: Record<string, unknown>
): Promise<unknown> {
  const decisionId = args.decision_id as string;
  const txHash = args.tx_hash as string;

  if (!decisionId) {
    throw new McpError(ErrorCode.InvalidParams, 'decision_id is required');
  }
  if (!txHash) {
    throw new McpError(ErrorCode.InvalidParams, 'tx_hash is required');
  }

  const response = await client.redeem(decisionId, txHash);

  return {
    status: 'REDEEMED',
    message: 'Friction resolved. You may now proceed with the action.',
    decision_id: response.decision_id,
    proceed_token: response.proceed_token,
    expires_in_seconds: response.expires_in_seconds,
    receipt: response.receipt,
  };
}

async function handleGetBalance(client: ProceedGateClient): Promise<unknown> {
  try {
    const balance = await client.getBalance();

    return {
      workspace_id: balance.workspace_id,
      credits_remaining: balance.credits,
      usage: {
        today: balance.credits_used_today,
        this_week: balance.credits_used_this_week,
        this_month: balance.credits_used_this_month,
      },
      budget: balance.budget || { message: 'No budget limits configured' },
      status: balance.credits > 100 ? 'healthy' : balance.credits > 0 ? 'low' : 'depleted',
    };
  } catch (error) {
    // If billing endpoint not available, return helpful info
    return {
      message: 'Balance information not available. Billing may not be configured for this workspace.',
      workspace_id: client.getWorkspaceId(),
      hint: 'Contact support to enable billing features.',
    };
  }
}

async function handleSetBudget(
  client: ProceedGateClient,
  args: Record<string, unknown>
): Promise<unknown> {
  const config = {
    daily_limit: args.daily_limit as number | undefined,
    weekly_limit: args.weekly_limit as number | undefined,
    monthly_limit: args.monthly_limit as number | undefined,
    alert_threshold: args.alert_threshold as number | undefined,
  };

  // Filter out undefined values
  const cleanConfig = Object.fromEntries(
    Object.entries(config).filter(([, v]) => v !== undefined)
  );

  if (Object.keys(cleanConfig).length === 0) {
    return {
      status: 'error',
      message: 'At least one budget limit must be specified',
    };
  }

  try {
    const result = await client.setBudget(cleanConfig);

    return {
      status: 'updated',
      message: 'Budget limits updated successfully',
      budget: result,
    };
  } catch (error) {
    return {
      status: 'error',
      message: 'Budget management not available. This feature requires a Pro plan.',
    };
  }
}

async function handleGetUsageReport(
  client: ProceedGateClient,
  args: Record<string, unknown>
): Promise<unknown> {
  const period = (args.period as 'today' | 'week' | 'month' | 'all') || 'today';

  try {
    const report = await client.getUsageReport(period);

    return {
      period: report.period,
      date_range: {
        start: report.start_date,
        end: report.end_date,
      },
      summary: {
        total_credits: report.total_credits_used,
        total_cost_usd: report.total_cost_usd,
      },
      breakdown: report.breakdown,
    };
  } catch (error) {
    return {
      message: 'Usage reports not available. This feature requires billing to be enabled.',
      period,
      hint: 'Enable billing to access detailed usage reports.',
    };
  }
}
