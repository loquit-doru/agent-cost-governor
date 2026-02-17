/**
 * AI Reasoning Engine — Explainable AI governance
 *
 * Two modes:
 * 1. Template-based (zero latency fallback) — deterministic, instant
 * 2. Workers AI (real LLM) — Llama 3.1 8B via Cloudflare Workers AI
 *
 * Every governance decision comes with a reasoning chain
 * that the agent (or human) can read to understand WHY.
 */

import type { Env } from '../types.js';

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

const TEMPLATE_MODEL = 'proceedgate-governance-v1';
const LLM_MODEL = 'llama-3.1-8b-governance';
const WORKERS_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';

const GOVERNANCE_SYSTEM_PROMPT = `You are ProceedGate's AI governance engine analyzing agent behavior in real-time.
You explain cost governance decisions for autonomous AI agents.

Rules:
- 2-3 sentences maximum
- Be specific: reference the exact action, pattern count, timing
- Sound like a security analyst monitoring live traffic, not a chatbot
- Focus on WHY the decision was made and what cost impact it prevents
- Never use emojis or markdown formatting
- Be direct and factual`;

// ─── AI Decision Zone ─────────────────────────────────────────────────────────
// When pattern count is in the gray zone (6-10), AI makes the actual decision.
// This is NOT cosmetic — the LLM decides allow/block based on behavioral signals.

const DECISION_SYSTEM_PROMPT = `You are an AI security analyst deciding whether to allow or block an AI agent's request.

You are given behavioral signals: request count, timing regularity, action type.
You must decide: ALLOW or BLOCK.

Decision factors:
- interval_cv (coefficient of variation): <0.15 means very regular timing = likely bot/loop. >0.4 means irregular = more likely legitimate.
- requests_per_sec: >0.5 in gray zone is suspicious, <0.2 is probably fine.
- action type: scraping/crawl actions are more prone to loops than read/query actions.
- count relative to threshold: 6 is barely suspicious, 9 is very suspicious.

You MUST respond with EXACTLY one line in this format:
DECISION: ALLOW | reason here
or
DECISION: BLOCK | reason here

Nothing else. One line only.`;

export interface GrayZoneInput {
  action: string;
  actor_id: string;
  count: number;
  max_count: number;
  avg_interval_ms: number;
  interval_cv: number;
  requests_per_sec: number;
  window_elapsed_ms: number;
  task_hash?: string;
  step_hash?: string;
}

export interface GrayZoneDecision {
  /** AI decided: allow or block */
  decision: 'allow' | 'block';
  /** AI's reasoning for the decision */
  reasoning: string;
  /** Whether AI actually decided (false = fell back to heuristic) */
  ai_decided: boolean;
  /** Confidence score */
  confidence: number;
  /** Model used */
  model: string;
}

/**
 * AI-powered decision for the gray zone (count 6-10).
 * The LLM actually DECIDES whether to allow or block — not just explain.
 * Falls back to heuristic if AI is unavailable or times out.
 */
export async function aiDecideGrayZone(
  env: Env | undefined,
  input: GrayZoneInput,
): Promise<GrayZoneDecision> {
  // Heuristic fallback: use timing regularity + count proximity to threshold
  const heuristic = heuristicGrayZone(input);

  if (!env?.AI) return heuristic;

  try {
    const prompt = buildDecisionPrompt(input);
    const aiCall = env.AI.run(WORKERS_AI_MODEL, {
      messages: [
        { role: 'system', content: DECISION_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      max_tokens: 60,
      temperature: 0.1, // Low temperature = more deterministic decisions
    }) as Promise<{ response?: string }>;

    const result = await Promise.race([
      aiCall,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), AI_TIMEOUT_MS)),
    ]);

    if (result?.response) {
      const parsed = parseDecisionResponse(result.response.trim());
      if (parsed) {
        return {
          decision: parsed.decision,
          reasoning: parsed.reasoning,
          ai_decided: true,
          confidence: parsed.decision === 'block'
            ? Math.min(0.95, 0.6 + (input.count - 5) * 0.07)
            : Math.min(0.9, 0.5 + input.interval_cv * 0.5),
          model: LLM_MODEL,
        };
      }
    }
  } catch {
    // AI failed — fall through to heuristic
  }

  return heuristic;
}

function buildDecisionPrompt(input: GrayZoneInput): string {
  return [
    `Agent "${input.actor_id}" is requesting "${input.action}".`,
    `Request count: ${input.count} in ${Math.round(input.window_elapsed_ms / 1000)}s (threshold: ${input.max_count})`,
    `Timing: avg interval ${input.avg_interval_ms}ms, regularity CV=${input.interval_cv.toFixed(3)} (0=perfectly regular/bot, >0.4=irregular/human)`,
    `Rate: ${input.requests_per_sec.toFixed(2)} requests/sec`,
    input.task_hash ? `Task: ${input.task_hash}` : '',
    input.step_hash ? `Step: ${input.step_hash}` : '',
    '',
    'Should this request be ALLOWED or BLOCKED?',
  ].filter(Boolean).join('\n');
}

function parseDecisionResponse(response: string): { decision: 'allow' | 'block'; reasoning: string } | null {
  // Parse "DECISION: ALLOW | reason" or "DECISION: BLOCK | reason"
  const match = response.match(/DECISION:\s*(ALLOW|BLOCK)\s*\|\s*(.+)/i);
  if (match) {
    return {
      decision: match[1].toLowerCase() as 'allow' | 'block',
      reasoning: match[2].trim(),
    };
  }
  // Fallback: check if first word is ALLOW or BLOCK
  const first = response.split(/[\s|,]/)[0].toUpperCase();
  if (first === 'ALLOW' || first === 'BLOCK') {
    return {
      decision: first.toLowerCase() as 'allow' | 'block',
      reasoning: response,
    };
  }
  return null;
}

/**
 * Heuristic fallback for gray zone decisions when AI is unavailable.
 * Uses timing regularity + count proximity to threshold.
 */
function heuristicGrayZone(input: GrayZoneInput): GrayZoneDecision {
  // Very regular timing (cv < 0.15) + high count = likely bot
  const isRegular = input.interval_cv < 0.15;
  const isHighCount = input.count >= 8;
  const isFastRate = input.requests_per_sec > 0.5;
  const isSuspiciousAction = /scrape|crawl|swap|transfer/i.test(input.action);

  // Score: higher = more suspicious
  let suspicion = 0;
  if (isRegular) suspicion += 3;
  if (isHighCount) suspicion += 2;
  if (isFastRate) suspicion += 2;
  if (isSuspiciousAction) suspicion += 1;
  // Low CV + high count is the strongest bot signal
  if (isRegular && isHighCount) suspicion += 2;

  const shouldBlock = suspicion >= 5;

  const reasoning = shouldBlock
    ? `Heuristic: ${input.count} requests with ${isRegular ? 'mechanical' : 'semi-regular'} timing (CV=${input.interval_cv.toFixed(3)}), ${input.requests_per_sec.toFixed(1)} req/s. Pattern suggests automated retry loop.`
    : `Heuristic: ${input.count} requests with ${isRegular ? 'regular' : 'irregular'} timing (CV=${input.interval_cv.toFixed(3)}), ${input.requests_per_sec.toFixed(1)} req/s. Pattern within acceptable burst range.`;

  return {
    decision: shouldBlock ? 'block' : 'allow',
    reasoning,
    ai_decided: false,
    confidence: shouldBlock ? 0.7 : 0.65,
    model: 'heuristic-v1',
  };
}

/** Max time to wait for Workers AI before falling back to template */
const AI_TIMEOUT_MS = 800;

/**
 * Generate AI reasoning with real LLM when available, template fallback.
 * Hard timeout of 1.5s — if Workers AI is slow, template returns instantly.
 */
export async function generateReasoningWithAI(
  env: Env | undefined,
  ctx: ReasoningContext,
): Promise<ReasoningOutput> {
  // Get template as deterministic baseline (instant, zero-cost)
  const template = generateReasoning(ctx);

  // If Workers AI is available, race it against a timeout
  if (env?.AI) {
    try {
      const prompt = buildLLMPrompt(ctx);
      const aiCall = env.AI.run(WORKERS_AI_MODEL, {
        messages: [
          { role: 'system', content: GOVERNANCE_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        max_tokens: 150,
        temperature: 0.3,
      }) as Promise<{ response?: string }>;

      // Race: AI vs timeout — whoever wins
      const result = await Promise.race([
        aiCall,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), AI_TIMEOUT_MS)),
      ]);

      if (result && result.response && result.response.trim().length > 20) {
        return {
          ...template,
          ai_reasoning: result.response.trim(),
          model: LLM_MODEL,
        };
      }
    } catch {
      // Workers AI failed — fall through to template
    }
  }

  return template;
}

function buildLLMPrompt(ctx: ReasoningContext): string {
  const parts: string[] = [`Governance decision: ${ctx.decision.toUpperCase()}`];
  parts.push(`Action requested: "${ctx.action}"`);
  if (ctx.actor_id) parts.push(`Agent: ${ctx.actor_id}`);
  if (ctx.pattern_count) parts.push(`Identical requests detected: ${ctx.pattern_count} in ${ctx.window_seconds || 60}s window`);
  if (ctx.cost_saved_usd) parts.push(`Estimated cost prevented: $${ctx.cost_saved_usd.toFixed(2)}`);
  if (ctx.credits_remaining !== undefined) parts.push(`Credits remaining: ${ctx.credits_remaining}`);
  if (ctx.friction_price) parts.push(`Friction price required: ${ctx.friction_price}`);
  if (ctx.task_hash) parts.push(`Task context: ${ctx.task_hash}`);
  if (ctx.attempt) parts.push(`Attempt number: ${ctx.attempt}`);

  parts.push('\nExplain this governance decision concisely. Why was this decision made? What does it protect against?');
  return parts.join('\n');
}

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
    model: TEMPLATE_MODEL,
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
    model: TEMPLATE_MODEL,
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
    model: TEMPLATE_MODEL,
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
    model: TEMPLATE_MODEL,
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
    model: TEMPLATE_MODEL,
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
