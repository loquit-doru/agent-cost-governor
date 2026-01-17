import type { GateStepFriction } from './types.js';

export class ProceedGateFrictionError extends Error {
  public readonly friction: GateStepFriction;

  constructor(friction: GateStepFriction) {
    super(`ProceedGate friction required (decision_id=${friction.decisionId})`);
    this.name = 'ProceedGateFrictionError';
    this.friction = friction;
  }
}
