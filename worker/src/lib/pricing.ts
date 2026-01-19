import type { Env } from '../types.js';
import { getRetryPricingConfig, getConfidencePricingConfig } from './config.js';
import { getModelPricing, estimateRequestCost } from './providerPricing.js';

export type PriceResult = {
  price: string;
  required: boolean;
  explain: string;
};

export type LLMCallContext = {
  model: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: number;
};

/**
 * Compute friction price for retry policy.
 * 
 * Pricing curve:
 * - First N attempts (freeAttempts) are free
 * - After that, price = base * growth^(attempt - freeAttempts)
 * - Capped at maxPrice
 */
export function computeRetryFrictionPrice(env: Env, attemptInWindow: number): PriceResult {
  const { freeAttempts, base, growth, maxPrice } = getRetryPricingConfig(env);

  if (attemptInWindow <= freeAttempts) {
    return {
      price: '0 USDC',
      required: false,
      explain: `attempt ${attemptInWindow}; free<=${freeAttempts}`,
    };
  }

  const exponent = attemptInWindow - freeAttempts;
  const raw = base * Math.pow(growth, exponent);
  const v = Math.min(maxPrice, raw);
  const formatted = `${v.toFixed(6).replace(/0+$/, '').replace(/[.]$/, '')} USDC`;

  return {
    price: formatted,
    required: true,
    explain: `attempt ${attemptInWindow}; free<=${freeAttempts}; curve base=${base} growth=${growth} max=${maxPrice}`,
  };
}

/**
 * Compute friction price for low confidence policy.
 * 
 * Pricing factors:
 * - confidence below threshold triggers friction
 * - severity = (threshold - confidence) / threshold
 * - attemptsFactor scales with retries
 * - price = base * (1 + mult * severity) * attemptsFactor
 * - Capped at maxPrice
 */
export function computeLowConfidencePrice(
  env: Env,
  params: { confidence: number | undefined; attemptInWindow: number },
): PriceResult {
  const { threshold, base, maxPrice, mult } = getConfidencePricingConfig(env);
  const c = params.confidence;

  if (c === undefined || c === null) {
    return {
      price: '0 USDC',
      required: false,
      explain: 'confidence missing; no friction',
    };
  }

  if (c >= threshold) {
    return {
      price: '0 USDC',
      required: false,
      explain: `confidence ${c.toFixed(2)} >= ${threshold}`,
    };
  }

  const severity = (threshold - c) / threshold;
  const attemptsFactor = Math.max(1, params.attemptInWindow - 1);
  const raw = base * (1 + mult * severity) * attemptsFactor;
  const v = Math.min(maxPrice, raw);
  const formatted = `${v.toFixed(6).replace(/0+$/, '').replace(/[.]$/, '')} USDC`;

  return {
    price: formatted,
    required: true,
    explain: `confidence ${c.toFixed(2)} < ${threshold}; severity=${severity.toFixed(2)} attemptsFactor=${attemptsFactor} base=${base} mult=${mult} max=${maxPrice}`,
  };
}
/**
 * Compute friction price for LLM cost policy.
 * 
 * This policy charges a markup on actual LLM costs:
 * - Lookup model pricing from provider database
 * - Calculate actual cost based on tokens
 * - Apply markup for governance overhead
 * - Apply volume discounts for high usage
 */
export function computeLLMCostPrice(
  env: Env,
  params: LLMCallContext & { attemptInWindow?: number },
): PriceResult {
  // Get markup config from env (default 20% markup)
  const markup = parseFloat(env.LLM_COST_MARKUP ?? '0.2');
  const freeThreshold = parseFloat(env.LLM_COST_FREE_THRESHOLD ?? '0.001'); // Free if under $0.001
  const maxPrice = parseFloat(env.LLM_COST_MAX ?? '1.0');

  // If user provides estimatedCost, use it directly
  if (params.estimatedCost !== undefined) {
    if (params.estimatedCost <= freeThreshold) {
      return {
        price: '0 USDC',
        required: false,
        explain: `estimatedCost $${params.estimatedCost.toFixed(6)} <= free threshold $${freeThreshold}`,
      };
    }

    const withMarkup = params.estimatedCost * (1 + markup);
    const v = Math.min(maxPrice, withMarkup);
    const formatted = `${v.toFixed(6).replace(/0+$/, '').replace(/[.]$/, '')} USDC`;

    return {
      price: formatted,
      required: true,
      explain: `estimatedCost $${params.estimatedCost.toFixed(6)} + ${markup * 100}% markup`,
    };
  }

  // Try to calculate from model and tokens
  const modelPricing = getModelPricing(params.model);
  if (!modelPricing) {
    // Unknown model - allow with warning
    return {
      price: '0 USDC',
      required: false,
      explain: `unknown model "${params.model}"; no pricing data available`,
    };
  }

  const inputTokens = params.inputTokens ?? 1000; // Default estimate
  const outputTokens = params.outputTokens ?? 500;

  const costEstimate = estimateRequestCost({
    model: params.model,
    inputTokens,
    outputTokens,
  });

  if (!costEstimate) {
    return {
      price: '0 USDC',
      required: false,
      explain: `could not estimate cost for ${params.model}`,
    };
  }

  if (costEstimate.cost <= freeThreshold) {
    return {
      price: '0 USDC',
      required: false,
      explain: `${params.model}: est $${costEstimate.cost.toFixed(6)} <= free threshold`,
    };
  }

  const withMarkup = costEstimate.cost * (1 + markup);
  const v = Math.min(maxPrice, withMarkup);
  const formatted = `${v.toFixed(6).replace(/0+$/, '').replace(/[.]$/, '')} USDC`;

  return {
    price: formatted,
    required: true,
    explain: `${params.model}: ${inputTokens} in + ${outputTokens} out = $${costEstimate.cost.toFixed(6)} + ${markup * 100}% markup`,
  };
}

/**
 * Get model information for transparency
 */
export function getModelInfo(model: string) {
  const pricing = getModelPricing(model);
  if (!pricing) {
    return null;
  }

  return {
    provider: pricing.provider,
    model: pricing.model,
    pricing: {
      inputPer1kTokens: pricing.inputPer1kTokens,
      outputPer1kTokens: pricing.outputPer1kTokens,
    },
    contextWindow: pricing.contextWindow,
    notes: pricing.notes,
  };
}