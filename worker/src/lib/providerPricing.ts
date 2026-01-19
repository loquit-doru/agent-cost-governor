/**
 * LLM Provider Pricing Database
 * 
 * Costs per 1K tokens in USD (as of Jan 2026)
 * Updated regularly - check provider docs for latest pricing
 */

export interface ModelPricing {
  provider: string;
  model: string;
  inputPer1kTokens: number;
  outputPer1kTokens: number;
  contextWindow: number;
  notes?: string;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI models
  'gpt-4o': {
    provider: 'openai',
    model: 'gpt-4o',
    inputPer1kTokens: 0.0025,
    outputPer1kTokens: 0.01,
    contextWindow: 128000,
  },
  'gpt-4o-mini': {
    provider: 'openai',
    model: 'gpt-4o-mini',
    inputPer1kTokens: 0.00015,
    outputPer1kTokens: 0.0006,
    contextWindow: 128000,
  },
  'gpt-4-turbo': {
    provider: 'openai',
    model: 'gpt-4-turbo',
    inputPer1kTokens: 0.01,
    outputPer1kTokens: 0.03,
    contextWindow: 128000,
  },
  'gpt-4': {
    provider: 'openai',
    model: 'gpt-4',
    inputPer1kTokens: 0.03,
    outputPer1kTokens: 0.06,
    contextWindow: 8192,
  },
  'gpt-3.5-turbo': {
    provider: 'openai',
    model: 'gpt-3.5-turbo',
    inputPer1kTokens: 0.0005,
    outputPer1kTokens: 0.0015,
    contextWindow: 16385,
  },
  'o1': {
    provider: 'openai',
    model: 'o1',
    inputPer1kTokens: 0.015,
    outputPer1kTokens: 0.06,
    contextWindow: 200000,
    notes: 'reasoning model',
  },
  'o1-mini': {
    provider: 'openai',
    model: 'o1-mini',
    inputPer1kTokens: 0.003,
    outputPer1kTokens: 0.012,
    contextWindow: 128000,
    notes: 'reasoning model',
  },

  // Anthropic models
  'claude-opus-4-20250514': {
    provider: 'anthropic',
    model: 'claude-opus-4-20250514',
    inputPer1kTokens: 0.015,
    outputPer1kTokens: 0.075,
    contextWindow: 200000,
  },
  'claude-sonnet-4-20250514': {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    inputPer1kTokens: 0.003,
    outputPer1kTokens: 0.015,
    contextWindow: 200000,
  },
  'claude-3-5-sonnet-20241022': {
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-20241022',
    inputPer1kTokens: 0.003,
    outputPer1kTokens: 0.015,
    contextWindow: 200000,
  },
  'claude-3-5-haiku-20241022': {
    provider: 'anthropic',
    model: 'claude-3-5-haiku-20241022',
    inputPer1kTokens: 0.0008,
    outputPer1kTokens: 0.004,
    contextWindow: 200000,
  },
  'claude-3-opus-20240229': {
    provider: 'anthropic',
    model: 'claude-3-opus-20240229',
    inputPer1kTokens: 0.015,
    outputPer1kTokens: 0.075,
    contextWindow: 200000,
  },

  // Google models
  'gemini-2.0-flash': {
    provider: 'google',
    model: 'gemini-2.0-flash',
    inputPer1kTokens: 0.0001,
    outputPer1kTokens: 0.0004,
    contextWindow: 1000000,
  },
  'gemini-2.0-flash-thinking': {
    provider: 'google',
    model: 'gemini-2.0-flash-thinking',
    inputPer1kTokens: 0.0,
    outputPer1kTokens: 0.0,
    contextWindow: 1000000,
    notes: 'free during experimental',
  },
  'gemini-1.5-pro': {
    provider: 'google',
    model: 'gemini-1.5-pro',
    inputPer1kTokens: 0.00125,
    outputPer1kTokens: 0.005,
    contextWindow: 2000000,
  },
  'gemini-1.5-flash': {
    provider: 'google',
    model: 'gemini-1.5-flash',
    inputPer1kTokens: 0.000075,
    outputPer1kTokens: 0.0003,
    contextWindow: 1000000,
  },

  // Mistral models
  'mistral-large': {
    provider: 'mistral',
    model: 'mistral-large',
    inputPer1kTokens: 0.002,
    outputPer1kTokens: 0.006,
    contextWindow: 128000,
  },
  'mistral-small': {
    provider: 'mistral',
    model: 'mistral-small',
    inputPer1kTokens: 0.0002,
    outputPer1kTokens: 0.0006,
    contextWindow: 32000,
  },
  'codestral': {
    provider: 'mistral',
    model: 'codestral',
    inputPer1kTokens: 0.0003,
    outputPer1kTokens: 0.0009,
    contextWindow: 32000,
  },

  // Groq (fast inference)
  'llama-3.3-70b-versatile': {
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    inputPer1kTokens: 0.00059,
    outputPer1kTokens: 0.00079,
    contextWindow: 128000,
  },
  'llama-3.1-8b-instant': {
    provider: 'groq',
    model: 'llama-3.1-8b-instant',
    inputPer1kTokens: 0.00005,
    outputPer1kTokens: 0.00008,
    contextWindow: 131072,
  },
  'mixtral-8x7b-32768': {
    provider: 'groq',
    model: 'mixtral-8x7b-32768',
    inputPer1kTokens: 0.00024,
    outputPer1kTokens: 0.00024,
    contextWindow: 32768,
  },

  // Cohere
  'command-r-plus': {
    provider: 'cohere',
    model: 'command-r-plus',
    inputPer1kTokens: 0.0025,
    outputPer1kTokens: 0.01,
    contextWindow: 128000,
  },
  'command-r': {
    provider: 'cohere',
    model: 'command-r',
    inputPer1kTokens: 0.00015,
    outputPer1kTokens: 0.0006,
    contextWindow: 128000,
  },

  // Together AI (open models)
  'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo': {
    provider: 'together',
    model: 'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo',
    inputPer1kTokens: 0.0035,
    outputPer1kTokens: 0.0035,
    contextWindow: 130815,
  },
  'deepseek-ai/DeepSeek-V3': {
    provider: 'together',
    model: 'deepseek-ai/DeepSeek-V3',
    inputPer1kTokens: 0.0005,
    outputPer1kTokens: 0.001,
    contextWindow: 65536,
  },
};

// Aliases for common model names
export const MODEL_ALIASES: Record<string, string> = {
  // OpenAI
  'gpt4': 'gpt-4',
  'gpt4o': 'gpt-4o',
  'gpt4-turbo': 'gpt-4-turbo',
  'gpt35': 'gpt-3.5-turbo',
  'gpt-3.5': 'gpt-3.5-turbo',

  // Anthropic  
  'claude-3-opus': 'claude-3-opus-20240229',
  'claude-3.5-sonnet': 'claude-3-5-sonnet-20241022',
  'claude-3.5-haiku': 'claude-3-5-haiku-20241022',
  'claude-opus': 'claude-opus-4-20250514',
  'claude-sonnet': 'claude-sonnet-4-20250514',
  'claude-4-opus': 'claude-opus-4-20250514',
  'claude-4-sonnet': 'claude-sonnet-4-20250514',

  // Google
  'gemini-pro': 'gemini-1.5-pro',
  'gemini-flash': 'gemini-2.0-flash',
  'gemini': 'gemini-2.0-flash',

  // Mistral
  'mistral': 'mistral-small',

  // Generic
  'llama-70b': 'llama-3.3-70b-versatile',
  'llama-8b': 'llama-3.1-8b-instant',
  'deepseek': 'deepseek-ai/DeepSeek-V3',
};

/**
 * Get pricing for a model
 */
export function getModelPricing(modelId: string): ModelPricing | null {
  // Try direct lookup
  if (MODEL_PRICING[modelId]) {
    return MODEL_PRICING[modelId];
  }

  // Try alias
  const alias = MODEL_ALIASES[modelId.toLowerCase()];
  if (alias && MODEL_PRICING[alias]) {
    return MODEL_PRICING[alias];
  }

  // Try case-insensitive search
  const lowerModel = modelId.toLowerCase();
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (key.toLowerCase() === lowerModel) {
      return pricing;
    }
  }

  return null;
}

/**
 * Estimate cost for a request
 */
export function estimateRequestCost(params: {
  model: string;
  inputTokens: number;
  outputTokens: number;
}): { cost: number; breakdown: { input: number; output: number } } | null {
  const pricing = getModelPricing(params.model);
  if (!pricing) {
    return null;
  }

  const inputCost = (params.inputTokens / 1000) * pricing.inputPer1kTokens;
  const outputCost = (params.outputTokens / 1000) * pricing.outputPer1kTokens;

  return {
    cost: inputCost + outputCost,
    breakdown: {
      input: inputCost,
      output: outputCost,
    },
  };
}

/**
 * Get all models for a provider
 */
export function getProviderModels(provider: string): ModelPricing[] {
  return Object.values(MODEL_PRICING).filter(
    (p) => p.provider.toLowerCase() === provider.toLowerCase()
  );
}

/**
 * List all supported providers
 */
export function getSupportedProviders(): string[] {
  const providers = new Set<string>();
  for (const pricing of Object.values(MODEL_PRICING)) {
    providers.add(pricing.provider);
  }
  return Array.from(providers).sort();
}
