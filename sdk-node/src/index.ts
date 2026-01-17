export { createProceedGateClient } from './client.js';
export { gateStep, gateStepWithRaw, requireGateStepOk, requireGateStepOkWithRaw } from './gate.js';
export { withProceedGateGate } from './withGate.js';
export { verifyProceedToken } from './jwks.js';
export { sha256Hex, sha256CanonicalJsonHex } from './hash.js';
export { canonicalizeJson, canonicalJsonStringify } from './canonicalJson.js';
export { ProceedGateFrictionError } from './errors.js';

export type {
  Action,
  Actor,
  CheckContext,
  GateStepFriction,
  GateStepFrictionWithRaw,
  GateStepInput,
  GateStepOk,
  GateStepOkWithRaw,
  GateStepResult,
  GateStepResultWithRaw,
  GovernorCheck402,
  GovernorCheckOk,
  GovernorCheckRequest,
  GovernorRedeemOk,
  PolicyId,
  ProceedGateClient,
  ProceedGateClientOptions,
  WithProceedGateGateOptions,
  X402Headers,
} from './types.js';

export type { ProceedGateFrictionErrorParams, ProceedGateFrictionInfo } from './errors.js';
