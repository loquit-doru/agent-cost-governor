import { Hono } from 'hono';
import type { Env, Vars } from '../types.js';
import { getOrCreateSigningKey } from '../services/signing.js';

const jwksRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

// JWKS endpoint for public key discovery
jwksRoutes.get('/.well-known/jwks.json', async (c) => {
  const { publicJwk } = await getOrCreateSigningKey(c.env);
  c.header('cache-control', 'public, max-age=300');
  return c.json({ keys: [publicJwk] }, 200);
});

// Health check endpoint
jwksRoutes.get('/health', (c) => {
  return c.json({ ok: true }, 200);
});

// Status endpoint with more details
jwksRoutes.get('/v1/status', (c) => {
  return c.json(
    {
      ok: true,
      service: 'proceedgate-governor',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    },
    200,
  );
});

export { jwksRoutes };
