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
import { createRateLimiter } from './middleware/rateLimit.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import { securityHeadersMiddleware } from './middleware/securityHeaders.js';

// Routes
import { checkRoutes } from './routes/check.js';
import { redeemRoutes } from './routes/redeem.js';
import { billingRoutes } from './routes/billing.js';
import { subscribeRoutes } from './routes/subscribe.js';
import { adminRoutes } from './routes/admin.js';
import { facilitatorRoutes } from './routes/facilitator.js';
import { jwksRoutes } from './routes/jwks.js';
import { mcpRoutes } from './routes/mcp.js';
import { proxyRoutes } from './routes/proxy.js';
import { badgeRoutes } from './routes/badge.js';
import { costsRoutes } from './routes/costs.js';
import { sessionRoutes } from './routes/session.js';
import { agentsRoutes } from './routes/agents.js';
import { healthRoutes } from './routes/health.js';

// Durable Objects (re-export)
export { DecisionStoreDO } from './decisionStoreDO.js';
export { BillingStoreDO } from './billingStoreDO.js';
export { CostLedger } from './durable-objects/CostLedger.js';

// Create main app
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// Apply global middleware
app.use('*', requestIdMiddleware);  // Add request ID first for correlation
app.use('*', corsMiddleware);
app.use('*', securityHeadersMiddleware); // Security headers on every response

// Rate limiting for billing/subscribe endpoints (prevent spam)
const billingRateLimiter = createRateLimiter({
  limit: 30,        // 30 requests per minute per IP
  windowMs: 60_000,
  keyPrefix: 'billing',
  useWorkspaceId: false,
});

app.use('/v1/billing/*', billingRateLimiter);
app.use('/v1/subscribe/*', billingRateLimiter);

// Stricter rate limiting for admin endpoints
const adminRateLimiter = createRateLimiter({
  limit: 10,        // 10 requests per minute per IP
  windowMs: 60_000,
  keyPrefix: 'admin',
  useWorkspaceId: false,
});

app.use('/v1/admin/*', adminRateLimiter);

// Mount routes
app.route('/', jwksRoutes);
app.route('/', mcpRoutes);
app.route('/', checkRoutes);
app.route('/', redeemRoutes);
app.route('/', billingRoutes);
app.route('/', subscribeRoutes);
app.route('/', adminRoutes);
app.route('/', facilitatorRoutes);
app.route('/', proxyRoutes);
app.route('/', badgeRoutes);
app.route('/', costsRoutes);
app.route('/', sessionRoutes);
app.route('/', agentsRoutes);
app.route('/', healthRoutes);

// 404 fallback
app.notFound((c) => {
  const requestId = c.get('requestId') || 'unknown';
  return c.json({ error: 'not_found', request_id: requestId }, 404);
});

// Global error handler with request ID for correlation
app.onError((err, c) => {
  const requestId = c.get('requestId') || crypto.randomUUID();
  console.error(`[${requestId}] Unhandled error:`, err);
  return c.json({ error: 'internal_server_error', request_id: requestId }, 500);
});

export default app;
