import type { MiddlewareHandler } from 'hono';
import type { Env, Vars, AppContext } from '../types.js';
import { isOriginAllowed } from '../lib/config.js';

/**
 * CORS middleware with hardened origin validation.
 * Only allows explicitly configured origins (no wildcard subdomain matching).
 */
export const corsMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  const origin = String(c.req.header('origin') ?? '').trim();

  if (origin && isOriginAllowed(c.env, origin)) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Vary', 'Origin');
    c.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    c.header('Access-Control-Allow-Headers', 'content-type,authorization,x-api-key,x-admin-key,x402-tx-hash');
    c.header('Access-Control-Max-Age', '600');
  }

  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204);
  }

  await next();
};
