# @proceedgate/mcp-server

MCP (Model Context Protocol) server for ProceedGate cost governance.

Control agent spending, enforce budgets, and prevent runaway costs through the Model Context Protocol.

## Installation

```bash
npm install -g @proceedgate/mcp-server
```

## Quick Start

### Claude Desktop Configuration

Add to your Claude Desktop config (`~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "proceedgate": {
      "command": "npx",
      "args": [
        "-y",
        "@proceedgate/mcp-server",
        "--api-key",
        "YOUR_API_KEY"
      ]
    }
  }
}
```

### Environment Variables

```bash
# Required
PROCEEDGATE_API_KEY=your_api_key_here

# Optional
PROCEEDGATE_BASE_URL=https://governor.proceedgate.dev
PROCEEDGATE_WORKSPACE_ID=your_workspace_id
```

## Available Tools

### `gate_check`
Check if an action is allowed under current budget/policy.

**Parameters:**
- `action` (required): Type of action (tool_call, llm_call, browser_action, api_call)
- `policy_id` (optional): Policy to evaluate (retry_friction_v1, low_confidence_v1)
- `tool` (optional): Name of the tool being called
- `cost_estimate` (optional): Estimated cost in USD
- `context` (optional): Additional context for decision

**Returns:** Decision with proceed_token if allowed, or friction details if blocked.

### `gate_redeem`
Resolve friction and get a proceed token after payment/approval.

**Parameters:**
- `decision_id` (required): Decision ID from gate_check response
- `tx_hash` (required): Transaction hash proving payment

**Returns:** Proceed token for the action.

### `get_balance`
Get current credit balance and usage statistics.

**Returns:** Current balance, usage this period, budget limits.

### `set_budget`
Set spending budget limits for the workspace.

**Parameters:**
- `daily_limit` (optional): Daily spending cap in USDC
- `weekly_limit` (optional): Weekly spending cap in USDC
- `monthly_limit` (optional): Monthly spending cap in USDC
- `alert_threshold` (optional): Percentage at which to alert (0-100)

**Returns:** Updated budget configuration.

### `get_usage_report`
Get detailed usage report for cost analysis.

**Parameters:**
- `period` (optional): Time period (today, week, month, all)

**Returns:** Breakdown of costs by action type, tool, and time.

## Example Usage

Once configured, Claude can use ProceedGate tools:

```
User: Check if I can make an API call

Claude: Let me check with ProceedGate...
[Calls gate_check with action="api_call"]

The action is allowed. You have a proceed token valid for 45 seconds.
Current balance: 950 credits remaining.
```

## Policies

### `retry_friction_v1`
Applies friction after multiple retries:
- Attempts 1-3: Free
- Attempts 4-6: 0.004 USDC
- Attempts 7-9: 0.008 USDC
- Attempts 10+: 0.016 USDC

### `low_confidence_v1`
Applies friction for low-confidence actions:
- Confidence > 0.7: Free
- Confidence 0.4-0.7: 0.002 USDC
- Confidence < 0.4: 0.004 USDC

## Security

- API keys are never logged or exposed
- All communication uses HTTPS
- Proceed tokens are short-lived JWTs (45s TTL)
- Tokens can be verified via JWKS endpoint

## License

MIT
