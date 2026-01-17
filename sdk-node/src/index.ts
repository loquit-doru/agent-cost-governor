export { createProceedGateClient } from './client.js';
export { gateStep, requireGateStepOk } from './gate.js';
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
  GateStepInput,
  GateStepOk,
  GateStepResult,
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
