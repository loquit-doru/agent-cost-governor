/**
 * Badge SVG endpoint — shields.io-style badge showing cost saved.
 * GET /v1/badge/:workspaceId.svg
 *
 * Returns an SVG image (always 200, gray fallback on error for GitHub compat).
 * Cached for 5 minutes via Cache-Control.
 */

import { Hono } from 'hono';
import type { Env, Vars } from '../types.js';
import { getBillingStub, doUrl } from '../lib/do.js';

const badgeRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

// ── Helpers ──────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatCurrency(usd: number): string {
  if (usd >= 1000) return `$${(usd / 1000).toFixed(1)}k`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  return '$0.00';
}

/** Approximate text width (shields.io uses Verdana 11px). */
function textWidth(text: string): number {
  // Average character width ≈ 6.5px for Verdana 11px
  return Math.ceil(text.length * 6.5) + 10;
}

function renderBadge(label: string, value: string, color: string): string {
  const labelW = textWidth(label);
  const valueW = textWidth(value);
  const totalW = labelW + valueW;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20" role="img" aria-label="${escapeXml(label)}: ${escapeXml(value)}">
  <title>${escapeXml(label)}: ${escapeXml(value)}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${totalW}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelW}" height="20" fill="#555"/>
    <rect x="${labelW}" width="${valueW}" height="20" fill="${color}"/>
    <rect width="${totalW}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text aria-hidden="true" x="${labelW / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(label)}</text>
    <text x="${labelW / 2}" y="14">${escapeXml(label)}</text>
    <text aria-hidden="true" x="${labelW + valueW / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(value)}</text>
    <text x="${labelW + valueW / 2}" y="14">${escapeXml(value)}</text>
  </g>
</svg>`;
}

// ── Route ────────────────────────────────────────────────────────────

badgeRoutes.get('/v1/badge/:workspaceId.svg', async (c) => {
  const workspaceId = c.req.param('workspaceId');

  try {
    const stub = getBillingStub(c.env);
    const res = await stub.fetch(doUrl(`/workspaces/${workspaceId}/badge-data`));

    if (!res.ok) {
      // Gray "inactive" badge — never 4xx/5xx (GitHub image embed compat)
      c.header('Content-Type', 'image/svg+xml');
      c.header('Cache-Control', 'public, max-age=300');
      return c.body(renderBadge('ProceedGate', 'inactive', '#999'));
    }

    const data = await res.json() as { ok: boolean; cost_saved_usd: number; storms_blocked: number; active: boolean };

    const label = 'cost saved';
    const value = formatCurrency(data.cost_saved_usd);
    // Green gradient based on savings
    const color = data.cost_saved_usd > 100 ? '#44cc11' // bright green
      : data.cost_saved_usd > 10 ? '#97ca00'            // yellow-green
      : data.cost_saved_usd > 0 ? '#a4a61d'             // yellow
      : '#9f9f9f';                                       // gray

    c.header('Content-Type', 'image/svg+xml');
    c.header('Cache-Control', 'public, max-age=300');
    return c.body(renderBadge(label, value, color));
  } catch {
    c.header('Content-Type', 'image/svg+xml');
    c.header('Cache-Control', 'public, max-age=60');
    return c.body(renderBadge('ProceedGate', 'error', '#e05d44'));
  }
});

export { badgeRoutes };
