/**
 * AI Reasoning Engine — Explainable AI governance
 *
 * Generates human-readable, context-aware explanations for every governance
 * decision. Template-based (zero latency, zero LLM cost) but produces
 * genuinely intelligent reasoning that adapts to each situation.
 *
 * This gives ProceedGate an "AI-explained governance" narrative:
 * every block, friction, or approval comes with a reasoning chain
 * that the agent (or human) can read to understand WHY.
 */

export interface ReasoningContext {
  decision: 'allowed' | 'blocked_storm' | 'blocked_credits' | 'friction_required';
  action: string;
  actor_id?: string;
  pattern_count?: number;
  window_seconds?: number;
  cost_saved_usd?: number;
  credits_remaining?: number;
  friction_price?: string;
  policy_id?: string;
  attempt?: number;
  task_hash?: string;
  step_hash?: string;
}

interface ReasoningOutput {
  /** Human-readable reasoning chain (1-3 sentences) */
  ai_reasoning: string;
  /** Structured thought process */
  reasoning_chain: ReasoningStep[];
  /** Confidence in this decision (0-1) */
  confidence: number;
  /** Governance model version */
  model: string;
}

interface ReasoningStep {
  step: string;
  observation: string;
  conclusion: string;
}

const MODEL_VERSION = 'proceedgate-governance-v1';

/**
 * Generate AI reasoning for a governance decision.
 * Zero latency — template interpolation only, no external calls.
 */
export function generateReasoning(ctx: ReasoningContext): ReasoningOutput {
  switch (ctx.decision) {
    case 'blocked_storm':
      return stormReasoning(ctx);
    case 'blocked_credits':
      return creditsReasoning(ctx);
    case 'friction_required':
      return frictionReasoning(ctx);
    case 'allowed':
      return allowedReasoning(ctx);
    default:
      return fallbackReasoning(ctx);
  }
}

// ─── Storm Detection Reasoning ────────────────────────────────────────────────

function stormReasoning(ctx: ReasoningContext): ReasoningOutput {
  const count = ctx.pattern_count ?? 10;
  const window = ctx.window_seconds ?? 60;
  const action = ctx.action || 'unknown';
  const actor = ctx.actor_id ? `Agent '${truncate(ctx.actor_id, 24)}'` : 'The requesting agent';
  const costSaved = ctx.cost_saved_usd ?? 0.05;
  const taskInfo = ctx.task_hash ? ` on task '${truncate(ctx.task_hash, 20)}'` : '';

  // Classify the storm severity
  const severity = count > 20 ? 'critical' : count > 15 ? 'severe' : 'moderate';
  const likelyCause = inferCause(ctx);

  const ai_reasoning = [
    `${actor} sent ${count} identical '${action}' requests${taskInfo} within ${window}s.`,
    `This matches a ${severity} retry storm pattern (threshold: 10/${window}s).`,
    `Likely cause: ${likelyCause}.`,
    `Blocked to prevent an estimated $${costSaved.toFixed(2)} in wasted API costs.`,
    `Recommendation: ${getRecommendation(ctx)}.`,
  ].join(' ');

  return {
    ai_reasoning,
    reasoning_chain: [
      {
        step: 'pattern_analysis',
        observation: `Detected ${count} identical request patterns (action='${action}', hash='${ctx.step_hash || 'same'}') in a ${window}s sliding window`,
        conclusion: `Pattern frequency ${(count / window * 60).toFixed(1)}/min exceeds safe threshold of 10/min`,
      },
      {
        step: 'storm_classification',
        observation: `Request velocity indicates ${severity} retry storm behavior`,
        conclusion: likelyCause,
      },
      {
        step: 'cost_analysis',
        observation: `Each unblocked request costs ~$${(costSaved / Math.max(count - 10, 1)).toFixed(4)}`,
        conclusion: `Blocking prevents estimated $${costSaved.toFixed(2)} in further waste`,
      },
      {
        step: 'governance_decision',
        observation: 'Storm detection policy triggered',
        conclusion: 'BLOCK — halt agent execution to protect budget',
      },
    ],
    confidence: Math.min(0.95, 0.7 + (count - 10) * 0.025),
    model: MODEL_VERSION,
  };
}

// ─── Credits Exhausted Reasoning ──────────────────────────────────────────────

function creditsReasoning(ctx: ReasoningContext): ReasoningOutput {
  const action = ctx.action || 'api_call';
  const actor = ctx.actor_id ? `Agent '${truncate(ctx.actor_id, 24)}'` : 'The requesting agent';
  const remaining = ctx.credits_remaining ?? 0;

  const ai_reasoning = [
    `${actor} attempted '${action}' but the workspace has ${remaining} credits remaining.`,
    `Budget cap enforced — the agent has exhausted its allocated spending limit.`,
    `This prevents unbounded cost accumulation from runaway agent operations.`,
    `Action: top up credits via /v1/billing/quote to resume operations.`,
  ].join(' ');

  return {
    ai_reasoning,
    reasoning_chain: [
      {
        step: 'budget_check',
        observation: `Workspace credits: ${remaining} (minimum required: 1)`,
        conclusion: 'Insufficient credits for this operation',
      },
      {
        step: 'cost_governance',
        observation: 'Budget cap is a safety mechanism against unbounded agent spending',
        conclusion: 'BLOCK — prevent cost accumulation beyond allocated budget',
      },
    ],
    confidence: 0.99,
    model: MODEL_VERSION,
  };
}

// ─── Friction Required Reasoning ──────────────────────────────────────────────

function frictionReasoning(ctx: ReasoningContext): ReasoningOutput {
  const action = ctx.action || 'tool_call';
  const actor = ctx.actor_id ? `Agent '${truncate(ctx.actor_id, 24)}'` : 'The requesting agent';
  const price = ctx.friction_price || '0.01 USDC';
  const attempt = ctx.attempt ?? 1;
  const policy = ctx.policy_id || 'retry_friction_v1';

  const frictionType = policy === 'retry_friction_v1' ? 'retry escalation' : 'low confidence';
  const isEscalating = attempt > 3;

  const ai_reasoning = [
    `${actor} is on attempt #${attempt} for '${action}'.`,
    `Policy '${policy}' requires friction payment of ${price} (${frictionType}).`,
    isEscalating
      ? `Escalating friction detected — repeated attempts suggest the agent may be in a loop.`
      : `Friction introduces intentional delay to distinguish legitimate retries from loops.`,
    `The agent must pay onchain to prove this action is intentional, not automated drift.`,
  ].join(' ');

  return {
    ai_reasoning,
    reasoning_chain: [
      {
        step: 'attempt_analysis',
        observation: `Attempt #${attempt} for action '${action}' detected`,
        conclusion: attempt > 5
          ? 'High retry count — possible automated loop'
          : 'Within normal retry range but caution warranted',
      },
      {
        step: 'friction_policy',
        observation: `Policy '${policy}' maps attempt ${attempt} to friction price ${price}`,
        conclusion: `Friction payment required to proceed — onchain proof of intent`,
      },
      {
        step: 'governance_decision',
        observation: `x402 payment-required response with decision_id for redeem flow`,
        conclusion: 'FRICTION — require onchain payment before allowing execution',
      },
    ],
    confidence: 0.92,
    model: MODEL_VERSION,
  };
}

// ─── Allowed Reasoning ────────────────────────────────────────────────────────

function allowedReasoning(ctx: ReasoningContext): ReasoningOutput {
  const action = ctx.action || 'tool_call';
  const actor = ctx.actor_id ? `Agent '${truncate(ctx.actor_id, 24)}'` : 'The agent';

  const ai_reasoning = [
    `${actor} requested '${action}' — all governance checks passed.`,
    `No storm pattern detected, credits available, and policy requirements met.`,
    `Issuing proceed_token (signed JWT) authorizing execution.`,
  ].join(' ');

  return {
    ai_reasoning,
    reasoning_chain: [
      {
        step: 'pattern_check',
        observation: 'No repetitive pattern detected in sliding window',
        conclusion: 'Request is within safe operational limits',
      },
      {
        step: 'budget_check',
        observation: 'Workspace has sufficient credits',
        conclusion: 'Cost budget allows this operation',
      },
      {
        step: 'governance_decision',
        observation: 'All checks passed',
        conclusion: 'ALLOW — issue proceed_token for authorized execution',
      },
    ],
    confidence: 0.98,
    model: MODEL_VERSION,
  };
}

// ─── Fallback ─────────────────────────────────────────────────────────────────

function fallbackReasoning(ctx: ReasoningContext): ReasoningOutput {
  return {
    ai_reasoning: `Governance decision: ${ctx.decision} for action '${ctx.action || 'unknown'}'.`,
    reasoning_chain: [{
      step: 'evaluation',
      observation: `Decision type: ${ctx.decision}`,
      conclusion: 'Standard governance policy applied',
    }],
    confidence: 0.85,
    model: MODEL_VERSION,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function inferCause(ctx: ReasoningContext): string {
  const action = (ctx.action || '').toLowerCase();
  const task = (ctx.task_hash || '').toLowerCase();
  const step = (ctx.step_hash || '').toLowerCase();

  if (action.includes('scrape') || action.includes('crawl'))
    return 'failing upstream API causing the scraping agent to retry indefinitely';
  if (action.includes('transfer') || action.includes('swap'))
    return 'repeated identical onchain operations — possible automated execution without variation';
  if (action.includes('model_call') || action.includes('llm') || action.includes('completion'))
    return 'LLM call loop — the agent may be retrying a prompt that consistently fails';
  if (action.includes('search') || action.includes('query'))
    return 'search query loop — the agent is repeating identical searches without refining the query';
  if (step === task || step === ctx.step_hash)
    return 'identical step_hash on every attempt — the agent is not varying its approach between retries';

  return 'the agent is sending identical requests without variation, indicating a retry loop or stuck state';
}

function getRecommendation(ctx: ReasoningContext): string {
  const action = (ctx.action || '').toLowerCase();

  if (action.includes('scrape') || action.includes('crawl'))
    return 'check if the upstream API key is valid or if the target URL returns errors';
  if (action.includes('transfer') || action.includes('swap'))
    return 'implement transaction deduplication or add nonce tracking';
  if (action.includes('model_call') || action.includes('llm'))
    return 'add exponential backoff or adjust the prompt if the LLM consistently fails';

  return 'add variation to step_hash between retries, or implement exponential backoff';
}
