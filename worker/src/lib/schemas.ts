import { z } from 'zod';
import { POLICY_IDS, ACTIONS } from '../types.js';

export const checkSchema = z.object({
  policy_id: z.enum(POLICY_IDS),
  action: z.enum(ACTIONS),
  actor: z.object({
    id: z.string().min(1).max(200),
    project: z.string().min(0).max(200).optional(),
    wallet: z.string().max(100).optional(), // ERC-8004 agent wallet address (optional)
  }),
  context: z
    .object({
      attempt_in_window: z.number().int().min(1).max(1_000_000),
      window_seconds: z.number().int().min(1).max(86_400).optional(),
      confidence: z.number().min(0).max(1).optional(),
      tool: z.string().max(200).optional(),
      task_hash: z.string().max(200).optional(),
      step_hash: z.string().max(200).optional(),
      context_hash: z.string().max(200).optional(),
      depth: z.number().int().min(0).max(100).optional(),
      // LLM cost policy fields
      model: z.string().max(200).optional(),
      provider: z.string().max(200).optional(),
      input_tokens: z.number().int().min(0).max(10_000_000).optional(),
      output_tokens: z.number().int().min(0).max(10_000_000).optional(),
      cost_estimate: z.number().min(0).max(10_000).optional(),
      session_id: z.string().max(200).optional(),
    })
    .strict(),
  idempotency_key: z.string().max(200).optional(),
});

export const redeemSchema = z.object({
  decision_id: z.string().min(1).max(200),
});

export const billingQuoteSchema = z.object({
  workspace_id: z.string().min(1).max(200),
  credits: z.number().int().min(1).max(10_000_000),
});

export const billingRedeemSchema = z.object({
  quote_id: z.string().min(1).max(200),
  tx_hash: z.string().min(1).max(200),
});

export const workspaceCreateSchema = z.object({
  workspace_id: z.string().min(1).max(200).optional(),
});

export const workspaceAdminSchema = z.object({
  workspace_id: z.string().min(1).max(200),
});

export const facilitatorVerifySchema = z.object({
  tx_hash: z.string().min(1).max(200),
  required_price: z.string().min(1).max(50),
  required_chain: z.string().min(1).max(50),
  required_recipient: z.string().min(1).max(100),
  decision_id: z.string().min(1).max(200).optional(),
});

export const budgetSetSchema = z.object({
  workspace_id: z.string().min(1).max(200),
  daily_limit: z.number().min(0).max(100_000_000).optional(),
  weekly_limit: z.number().min(0).max(100_000_000).optional(),
  monthly_limit: z.number().min(0).max(100_000_000).optional(),
  alert_threshold: z.number().min(0).max(1).optional(),
  webhook_url: z.string().url().max(2048).optional(),
});

export type CheckInput = z.infer<typeof checkSchema>;
export type RedeemInput = z.infer<typeof redeemSchema>;
export type BillingQuoteInput = z.infer<typeof billingQuoteSchema>;
export type BillingRedeemInput = z.infer<typeof billingRedeemSchema>;
export type WorkspaceCreateInput = z.infer<typeof workspaceCreateSchema>;
export type WorkspaceAdminInput = z.infer<typeof workspaceAdminSchema>;
export type FacilitatorVerifyInput = z.infer<typeof facilitatorVerifySchema>;
export type BudgetSetInput = z.infer<typeof budgetSetSchema>;
