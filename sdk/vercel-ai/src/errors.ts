/**
 * ProceedGate error types for Vercel AI SDK integration
 */

export class ProceedGateFrictionError extends Error {
  readonly code = 'PROCEEDGATE_FRICTION' as const;
  readonly decisionId?: string;
  readonly friction?: {
    price: string;
    reason: string;
    chain: string;
  };

  constructor(
    message: string,
    decisionId?: string,
    friction?: { price: string; reason: string; chain: string },
  ) {
    super(message);
    this.name = 'ProceedGateFrictionError';
    this.decisionId = decisionId;
    this.friction = friction;
  }
}

export class ProceedGateBudgetError extends Error {
  readonly code = 'PROCEEDGATE_BUDGET_EXCEEDED' as const;
  readonly spent: number;
  readonly budget: number;

  constructor(spent: number, budget: number) {
    super(`Budget exceeded: $${spent.toFixed(2)} / $${budget.toFixed(2)}`);
    this.name = 'ProceedGateBudgetError';
    this.spent = spent;
    this.budget = budget;
  }
}
