import type { MiddlewareHandler } from 'hono';
import type { Env, Vars } from '../types.js';

/**
 * Request ID middleware.
 * Adds a unique request ID to each request for correlation in logs.
 */
export const requestIdMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('X-Request-ID', requestId);
  await next();
};
