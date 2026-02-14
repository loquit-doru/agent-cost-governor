import { Hono } from 'hono';
import type { Env, Vars } from '../types.js';
import { facilitatorVerifySchema } from '../lib/schemas.js';
import { requireFacilitatorAuth } from '../middleware/auth.js';
import { facilitatorVerifyPayment } from '../facilitator.js';
import { writeMetric } from '../metrics.js';

const facilitatorRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

facilitatorRoutes.post('/x402/verify', async (c) => {
  const startMs = Date.now();

  const authErr = await requireFacilitatorAuth(c);
  if (authErr) {
    writeMetric(c.env, {
      indexes: ['facilitator_fail', 'unknown', 'unknown', 'unauthorized'],
      doubles: [1, Date.now() - startMs],
    });
    return authErr;
  }

  const body = await c.req.json().catch(() => null);
  const parsed = facilitatorVerifySchema.safeParse(body);

  if (!parsed.success) {
    writeMetric(c.env, {
      indexes: ['facilitator_fail', 'unknown', 'unknown', 'invalid_request'],
      doubles: [1, Date.now() - startMs],
    });
    return c.json({ ok: false, error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const result = await facilitatorVerifyPayment(c.env, parsed.data);

  if (!result.ok) {
    writeMetric(c.env, {
      indexes: ['facilitator_fail', 'unknown', 'unknown', result.error],
      doubles: [1, Date.now() - startMs],
    });
    return c.json({ ok: false, error: result.error }, result.status);
  }

  writeMetric(c.env, {
    indexes: ['facilitator_ok', 'unknown', 'unknown', 'ok'],
    doubles: [1, Date.now() - startMs],
  });

  return c.json({ ok: true, receipt: result.receipt }, 200);
});

export { facilitatorRoutes };
