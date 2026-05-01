import { Hono } from 'hono';
import type { Env, Vars } from '../types.js';

export const healthRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

healthRoutes.get('/v1/health', (c) => {
  return c.json(
    {
      ok: true,
      service: 'proceedgate-governor',
      billing_mode: c.env.BILLING_MODE ?? 'unknown',
      micro_usdc_per_credit: c.env.BILLING_CREDIT_COST_MICROUSDC ?? 'unknown',
      now: new Date().toISOString(),
    },
    200,
  );
});

