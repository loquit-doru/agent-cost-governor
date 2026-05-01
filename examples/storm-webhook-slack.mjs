#!/usr/bin/env node
/**
 * EXAMPLE: storm.detected webhook → Slack alert
 *
 * Runs a minimal HTTP server that receives ProceedGate webhook events
 * and forwards storm.detected to Slack via Incoming Webhooks.
 *
 * Usage:
 *   SLACK_WEBHOOK_URL=https://hooks.slack.com/... \
 *   PROCEEDGATE_WEBHOOK_SECRET=whsec_yourSecret \
 *   node examples/storm-webhook-slack.mjs
 *
 * Then configure ProceedGate to point to your server:
 *   PUT https://governor.proceedgate.dev/v1/billing/:workspaceId/webhook
 *   { "webhook_url": "https://your-server.com/webhook", "webhook_secret": "whsec_yourSecret" }
 *
 * For local testing, expose with: npx cloudflared tunnel --url http://localhost:3099
 */

import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 3099);
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL ?? '';
const WEBHOOK_SECRET = process.env.PROCEEDGATE_WEBHOOK_SECRET ?? '';

if (!SLACK_WEBHOOK_URL) {
  console.error('❌  Set SLACK_WEBHOOK_URL env var (Slack Incoming Webhook URL)');
  process.exit(1);
}

// ============================================================================
// Signature verification
// ============================================================================

async function verifySignature(body, signatureHeader, secret) {
  if (!secret) return true; // skip verification if no secret configured
  if (!signatureHeader?.startsWith('sha256=')) return false;

  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const expectedBuf = Buffer.from('sha256=' + expected, 'utf8');
  const actualBuf = Buffer.from(signatureHeader, 'utf8');

  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

// ============================================================================
// Slack message builders
// ============================================================================

function buildStormSlackMessage(data) {
  const severity = data.alert_severity ?? 'high';
  const emoji = severity === 'critical' ? '🚨' : severity === 'high' ? '⚠️' : '🔔';
  const color = severity === 'critical' ? '#ef4444' : severity === 'high' ? '#f97316' : '#eab308';

  const costSaved = (data.estimated_cost_saved_usd ?? 0).toFixed(2);
  const blockCount = data.block_count ?? 0;
  const workspaceId = data.workspace_id ?? 'unknown';
  const requestHash = (data.request_hash ?? '').slice(0, 20) + '…';
  const totalMs = data.total_blocked_ms ?? 0;

  let fingerprintText = '';
  if (data.fingerprint) {
    const f = data.fingerprint;
    fingerprintText = `\n*Fingerprint:* burst=${f.burst_index?.toFixed(2) ?? 'n/a'}, entropy=${f.entropy?.toFixed(3) ?? 'n/a'}, fanout=${f.fanout_ratio?.toFixed(1) ?? 'n/a'}`;
  }

  return {
    text: `${emoji} *Retry storm detected* on workspace \`${workspaceId}\``,
    attachments: [
      {
        color,
        fields: [
          { title: 'Workspace', value: `\`${workspaceId}\``, short: true },
          { title: 'Severity', value: severity.toUpperCase(), short: true },
          { title: 'Requests blocked', value: `${blockCount}`, short: true },
          { title: 'Cost saved', value: `$${costSaved} USD`, short: true },
          { title: 'Window duration', value: `${(totalMs / 1000).toFixed(1)}s`, short: true },
          { title: 'Request hash', value: requestHash, short: true },
        ],
        footer: `ProceedGate storm.detected${fingerprintText}`,
        footer_icon: 'https://proceedgate.pages.dev/favicon.ico',
        ts: Math.floor(Date.now() / 1000),
      },
    ],
  };
}

function buildCreditsLowSlackMessage(data) {
  const remaining = data.credits_remaining ?? 0;
  const usagePct = data.usage_percent ?? 0;

  return {
    text: `💸 *Credits low* on workspace \`${data.workspace_id}\``,
    attachments: [
      {
        color: '#f97316',
        fields: [
          { title: 'Credits remaining', value: `${remaining}`, short: true },
          { title: 'Usage', value: `${usagePct}%`, short: true },
        ],
        footer: 'ProceedGate credits.low',
        ts: Math.floor(Date.now() / 1000),
      },
    ],
  };
}

function buildSubscriptionExpiringSlackMessage(data) {
  return {
    text: `⏰ *Subscription expiring* — workspace \`${data.workspace_id}\` expires in ${data.days_remaining} day(s)`,
    attachments: [
      {
        color: '#6366f1',
        fields: [
          { title: 'Workspace', value: `\`${data.workspace_id}\``, short: true },
          { title: 'Days remaining', value: `${data.days_remaining}`, short: true },
          { title: 'Expires at', value: data.expires_at, short: false },
        ],
        footer: 'ProceedGate subscription.expiring',
        ts: Math.floor(Date.now() / 1000),
      },
    ],
  };
}

// ============================================================================
// Slack sender
// ============================================================================

async function sendToSlack(message) {
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Slack returned ${res.status}: ${text}`);
  }
}

// Dedup: track recent storm hashes to avoid duplicate alerts within 60s
const recentStorms = new Map(); // hash → timestamp

function isDuplicate(event, data) {
  if (event !== 'storm.detected') return false;
  const key = `${data.workspace_id}:${data.request_hash}`;
  const last = recentStorms.get(key) ?? 0;
  if (Date.now() - last < 60_000) return true;
  recentStorms.set(key, Date.now());
  // Cleanup old entries
  for (const [k, ts] of recentStorms) {
    if (Date.now() - ts > 300_000) recentStorms.delete(k);
  }
  return false;
}

// ============================================================================
// HTTP server
// ============================================================================

const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/webhook') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  // Read body
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString('utf8');

  // Verify signature
  const sig = req.headers['x-proceedgate-signature'] ?? '';
  const valid = await verifySignature(rawBody, sig, WEBHOOK_SECRET);
  if (!valid) {
    console.warn('⚠️  Invalid webhook signature');
    res.writeHead(401);
    res.end('Unauthorized');
    return;
  }

  // Parse payload
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    res.writeHead(400);
    res.end('Bad JSON');
    return;
  }

  const { event, data = {} } = payload;
  console.log(`📬 Received event: ${event} (workspace: ${data.workspace_id ?? 'unknown'})`);

  // Route to Slack message builder
  try {
    let slackMsg = null;

    if (event === 'storm.detected') {
      if (isDuplicate(event, data)) {
        console.log('   ↳ Duplicate storm within 60s — skipped');
        res.writeHead(200);
        res.end('ok');
        return;
      }
      slackMsg = buildStormSlackMessage(data);
    } else if (event === 'credits.low') {
      slackMsg = buildCreditsLowSlackMessage(data);
    } else if (event === 'subscription.expiring') {
      slackMsg = buildSubscriptionExpiringSlackMessage(data);
    } else {
      // Unknown event — just acknowledge
      console.log(`   ↳ Unhandled event type: ${event}`);
      res.writeHead(200);
      res.end('ok');
      return;
    }

    await sendToSlack(slackMsg);
    console.log(`   ↳ ✅ Forwarded to Slack`);
    res.writeHead(200);
    res.end('ok');
  } catch (err) {
    console.error(`   ↳ ❌ Failed to forward to Slack: ${err.message}`);
    // Always return 200 to ProceedGate — don't cause retries
    res.writeHead(200);
    res.end('ok');
  }
});

server.listen(PORT, () => {
  console.log(`\n🚀 ProceedGate → Slack webhook bridge running on http://localhost:${PORT}/webhook`);
  console.log(`   SLACK_WEBHOOK_URL: ${SLACK_WEBHOOK_URL ? '✅ set' : '❌ missing'}`);
  console.log(`   Signature verification: ${WEBHOOK_SECRET ? '✅ enabled' : '⚠️  disabled (no secret)'}`);
  console.log(`\nHandled events:`);
  console.log(`   storm.detected        → 🚨 Slack alert with cost saved, severity, fingerprint`);
  console.log(`   credits.low           → 💸 Slack alert with remaining credits`);
  console.log(`   subscription.expiring → ⏰ Slack reminder\n`);
  console.log(`To expose publicly for testing:`);
  console.log(`   npx cloudflared tunnel --url http://localhost:${PORT}\n`);
});
