import type { MiddlewareHandler } from 'hono';
import type { Env, Vars } from '../types.js';

/**
 * Security headers middleware.
 * Adds standard hardening headers to every response.
 */
export const securityHeadersMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  await next();

  // Prevent clickjacking
  c.header('X-Frame-Options', 'DENY');

  // Prevent MIME-type sniffing
  c.header('X-Content-Type-Options', 'nosniff');

  // Minimal referrer (no full URL leak)
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');

  // API only — no need for browser features
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // XSS filter (legacy browsers)
  c.header('X-XSS-Protection', '1; mode=block');

  // HSTS — 1 year, include subdomains
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  // CSP for JSON API — only allow self
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
};
