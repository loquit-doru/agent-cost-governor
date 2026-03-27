/**
 * /costs/:agentId  —  MPP cost ledger routes.
 *
 * Proxies reads to the CostLedger Durable Object for a given agentId.
 */

import { Hono } from 'hono';
import type { Env, Vars } from '../types.js';

const costsRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

/** GET /costs/:agentId — aggregate cost summary */
costsRoutes.get('/costs/:agentId', async (c) => {
  const agentId = c.req.param('agentId');
  const stub = c.env.COST_LEDGER.get(c.env.COST_LEDGER.idFromName(agentId));
  const res = await stub.fetch(
    new Request(`http://do/summary?agentId=${encodeURIComponent(agentId)}`),
  );
  if (!res.ok) return c.json({ error: 'ledger_unavailable' }, 502);
  return c.json(await res.json());
});

/** GET /costs/:agentId/history — recent cost entries */
costsRoutes.get('/costs/:agentId/history', async (c) => {
  const agentId = c.req.param('agentId');
  const limit = c.req.query('limit') ?? '50';
  const stub = c.env.COST_LEDGER.get(c.env.COST_LEDGER.idFromName(agentId));
  const res = await stub.fetch(
    new Request(`http://do/history?limit=${encodeURIComponent(limit)}`),
  );
  if (!res.ok) return c.json({ error: 'ledger_unavailable' }, 502);
  return c.json(await res.json());
});

export { costsRoutes };
