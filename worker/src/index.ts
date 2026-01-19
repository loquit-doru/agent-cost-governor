/**
 * ProceedGate Governor Worker
 * 
 * A cost-control & governance primitive for autonomous agents.
 * This is the main entry point that composes all routes and middleware.
 */

import { Hono } from 'hono';
import type { Env, Vars } from './types.js';

// Middleware
import { corsMiddleware } from './middleware/cors.js';

// Routes
import { checkRoutes } from './routes/check.js';
import { redeemRoutes } from './routes/redeem.js';
import { billingRoutes } from './routes/billing.js';
import { adminRoutes } from './routes/admin.js';
import { facilitatorRoutes } from './routes/facilitator.js';
import { jwksRoutes } from './routes/jwks.js';
import { mcpRoutes } from './routes/mcp.js';

// Durable Objects (re-export)
export { DecisionStoreDO } from './decisionStoreDO.js';
export { BillingStoreDO } from './billingStoreDO.js';

// Create main app
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// Apply global middleware
app.use('*', corsMiddleware);

// Mount routes
app.route('/', jwksRoutes);
app.route('/', mcpRoutes);
app.route('/', checkRoutes);
app.route('/', redeemRoutes);
app.route('/', billingRoutes);
app.route('/', adminRoutes);
app.route('/', facilitatorRoutes);

// 404 fallback
app.notFound((c) => {
  return c.json({ error: 'not_found' }, 404);
});

// Global error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'internal_server_error' }, 500);
});

export default app;
