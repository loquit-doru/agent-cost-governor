import { Hono } from 'hono';
import type { Env, Vars, AppContext } from '../types.js';
import {
  appendN8nDownloadEvent,
  clientIpFromHeaders,
  hashIpForUsage,
  scheduleBackgroundTask,
  tryExecutionCtx,
} from '../lib/usageTracking.js';

const GITHUB_RAW_BASE =
  'https://raw.githubusercontent.com/loquit-doru/agent-cost-governor/main/examples/n8n/';
const GITHUB_BLOB_BASE =
  'https://github.com/loquit-doru/agent-cost-governor/blob/main/examples/n8n/';

const N8N_ASSETS: Record<string, string> = {
  'guard-sub-workflow': 'guard-sub-workflow.json',
  'main-ai-agent-flow': 'main-ai-agent-flow.json',
  'proceedgate-guard-sub-workflow': 'proceedgate-guard-sub-workflow.json',
  'native-vs-proceedgate-guide': 'native-vs-proceedgate-guard-workflow.md',
};

const dlRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

function n8nRedirectUrl(filename: string): string {
  if (filename.endsWith('.md')) {
    return `${GITHUB_BLOB_BASE}${filename}`;
  }
  return `${GITHUB_RAW_BASE}${filename}`;
}

function scheduleN8nDownloadLog(c: AppContext, assetId: string): void {
  scheduleBackgroundTask(tryExecutionCtx(c), async () => {
    try {
      const ip = clientIpFromHeaders(c.req.raw.headers);
      await appendN8nDownloadEvent(c.env, {
        created_at: new Date().toISOString(),
        asset_id: assetId,
        user_agent: (c.req.header('user-agent') ?? '').slice(0, 200) || null,
        referrer: (c.req.header('referer') ?? c.req.header('referrer') ?? '').slice(0, 500) || null,
        ip_hash: await hashIpForUsage(ip),
      });
    } catch {
      // Non-fatal: redirect must succeed even if telemetry fails.
    }
  });
}

for (const [slug, filename] of Object.entries(N8N_ASSETS)) {
  dlRoutes.get(`/dl/n8n/${slug}`, (c) => {
    const location = n8nRedirectUrl(filename);
    scheduleN8nDownloadLog(c, slug);
    return c.redirect(location, 302);
  });
}

export { dlRoutes };
