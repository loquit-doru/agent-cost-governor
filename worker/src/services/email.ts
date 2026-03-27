/**
 * Email service for ProceedGate
 * Uses Resend API for transactional emails
 */

import type { Env } from '../types.js';

interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

interface SubscriptionConfirmationParams {
  to: string;
  workspaceId: string;
  apiKey: string;
  plan: string;
  months: number;
  expiresAt: string;
  totalPaid: number;
  txHash?: string;
}

interface LowCreditsAlertParams {
  to: string;
  workspaceId: string;
  creditsRemaining: number;
  plan: string;
}

interface ExpiryWarningParams {
  to: string;
  workspaceId: string;
  expiresAt: string;
  plan: string;
  daysLeft: number;
}

// Get Resend API key from env
function getResendKey(env: Env): string | null {
  const envWithResend = env as Env & { RESEND_API_KEY?: string };
  return envWithResend.RESEND_API_KEY || null;
}

export function isEmailConfigured(env: Env): boolean {
  return !!getResendKey(env);
}

// Send email via Resend
async function sendEmail(env: Env, params: SendEmailParams): Promise<{ ok: boolean; error?: string }> {
  const apiKey = getResendKey(env);

  if (!apiKey) {
    console.warn('[email] RESEND_API_KEY not set — email skipped. Set via: wrangler secret put RESEND_API_KEY');
    return { ok: false, error: 'email_not_configured' };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'ProceedGate <billing@proceedgate.dev>',
        reply_to: 'support@proceedgate.dev',
        to: [params.to],
        subject: params.subject,
        html: params.html,
        text: params.text,
        headers: {
          'X-Entity-Ref-ID': crypto.randomUUID(), // Unique ID to prevent threading issues
          'List-Unsubscribe': '<mailto:unsubscribe@proceedgate.dev>',
        },
      }),
    });

    if (!res.ok) {
      const error = await res.text();
      console.error('Resend error:', error);
      return { ok: false, error };
    }

    return { ok: true };
  } catch (err) {
    console.error('Email send error:', err);
    return { ok: false, error: String(err) };
  }
}

// Send subscription confirmation email
export async function sendSubscriptionConfirmation(
  env: Env,
  params: SubscriptionConfirmationParams
): Promise<{ ok: boolean }> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Subscription Confirmed - ProceedGate</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #0a0f1c;">
  <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <!-- Header -->
    <div style="text-align: center; margin-bottom: 40px;">
      <div style="display: inline-block; background: #00d4aa; width: 50px; height: 50px; border-radius: 12px; line-height: 50px; font-size: 24px;">✓</div>
      <h1 style="color: #ffffff; margin: 20px 0 10px 0; font-size: 28px;">Payment Confirmed!</h1>
      <p style="color: #8899aa; margin: 0;">Your ProceedGate subscription is now active</p>
    </div>

    <!-- Credentials Box -->
    <div style="background: linear-gradient(135deg, rgba(0,212,170,0.1), rgba(0,212,170,0.05)); border: 1px solid rgba(0,212,170,0.3); border-radius: 16px; padding: 30px; margin-bottom: 30px;">
      <h2 style="color: #00d4aa; margin: 0 0 20px 0; font-size: 18px;">🔑 Your API Credentials</h2>
      
      <div style="margin-bottom: 16px;">
        <div style="color: #8899aa; font-size: 12px; margin-bottom: 4px;">Workspace ID</div>
        <div style="color: #ffffff; font-family: monospace; font-size: 14px; background: rgba(0,0,0,0.3); padding: 12px; border-radius: 8px; word-break: break-all;">${params.workspaceId}</div>
      </div>
      
      <div style="margin-bottom: 16px;">
        <div style="color: #8899aa; font-size: 12px; margin-bottom: 4px;">API Key</div>
        <div style="color: #ffffff; font-family: monospace; font-size: 14px; background: rgba(0,0,0,0.3); padding: 12px; border-radius: 8px; word-break: break-all;">${params.apiKey}</div>
      </div>
      
      <div style="background: rgba(255,170,0,0.1); border: 1px solid rgba(255,170,0,0.3); border-radius: 8px; padding: 12px; margin-top: 20px;">
        <div style="color: #ffaa00; font-size: 13px;">⚠️ <strong>Save your API key!</strong> It won't be shown again.</div>
      </div>
    </div>

    <!-- Plan Details -->
    <div style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 24px; margin-bottom: 30px;">
      <h2 style="color: #ffffff; margin: 0 0 20px 0; font-size: 18px;">📋 Subscription Details</h2>
      
      <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
        <span style="color: #8899aa;">Plan</span>
        <span style="color: #ffffff; font-weight: 600;">${params.plan}</span>
      </div>
      
      <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
        <span style="color: #8899aa;">Period</span>
        <span style="color: #ffffff;">${params.months} month${params.months > 1 ? 's' : ''}</span>
      </div>
      
      <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
        <span style="color: #8899aa;">Amount Paid</span>
        <span style="color: #00d4aa; font-weight: 600;">$${params.totalPaid} USDC</span>
      </div>
      
      <div style="display: flex; justify-content: space-between;">
        <span style="color: #8899aa;">Valid Until</span>
        <span style="color: #ffffff;">${params.expiresAt}</span>
      </div>
    </div>

    <!-- Quick Start -->
    <div style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 24px; margin-bottom: 30px;">
      <h2 style="color: #ffffff; margin: 0 0 16px 0; font-size: 18px;">🚀 Quick Start</h2>
      
      <div style="background: #1a1f2e; border-radius: 8px; padding: 16px; font-family: monospace; font-size: 13px; color: #00d4aa; overflow-x: auto;">
        curl -X POST https://governor.proceedgate.dev/v1/check \\<br>
        &nbsp;&nbsp;-H "Authorization: Bearer ${params.apiKey}" \\<br>
        &nbsp;&nbsp;-H "Content-Type: application/json" \\<br>
        &nbsp;&nbsp;-d '{"action": "model_call"}'
      </div>
    </div>

    <!-- CTA Button -->
    <div style="text-align: center; margin-bottom: 30px;">
      <a href="https://proceedgate.dev/docs" style="display: inline-block; background: linear-gradient(135deg, #00d4aa, #00b894); color: #0a0f1c; text-decoration: none; padding: 16px 40px; border-radius: 12px; font-weight: 600; font-size: 16px;">Read Integration Guide</a>
    </div>

    <!-- Footer -->
    <div style="text-align: center; padding-top: 30px; border-top: 1px solid rgba(255,255,255,0.1);">
      <p style="color: #8899aa; font-size: 13px; margin: 0 0 10px 0;">Questions? Reply to this email or contact support@proceedgate.dev</p>
      <p style="color: #556677; font-size: 12px; margin: 0;">© 2024-2026 ProceedGate. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`;

  const text = `
ProceedGate - Subscription Confirmed!

Your API Credentials:
- Workspace ID: ${params.workspaceId}
- API Key: ${params.apiKey}

⚠️ Save your API key! It won't be shown again.

Subscription Details:
- Plan: ${params.plan}
- Period: ${params.months} month(s)
- Amount Paid: $${params.totalPaid} USDC
- Valid Until: ${params.expiresAt}

Quick Start:
curl -X POST https://governor.proceedgate.dev/v1/check \\
  -H "Authorization: Bearer ${params.apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"action": "model_call"}'

Read the full integration guide: https://proceedgate.dev/docs

Questions? Contact support@proceedgate.dev
`;

  return sendEmail(env, {
    to: params.to,
    subject: `✅ ProceedGate ${params.plan} Subscription Confirmed`,
    html,
    text,
  });
}

// Send low credits alert
export async function sendLowCreditsAlert(
  env: Env,
  params: LowCreditsAlertParams
): Promise<{ ok: boolean }> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Low Credits Alert - ProceedGate</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #0a0f1c;">
  <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <div style="text-align: center; margin-bottom: 40px;">
      <div style="display: inline-block; background: #ffaa00; width: 50px; height: 50px; border-radius: 12px; line-height: 50px; font-size: 24px;">⚠️</div>
      <h1 style="color: #ffffff; margin: 20px 0 10px 0; font-size: 28px;">Low Credits Alert</h1>
      <p style="color: #8899aa; margin: 0;">Your ProceedGate workspace is running low on credits</p>
    </div>

    <div style="background: rgba(255,170,0,0.1); border: 1px solid rgba(255,170,0,0.3); border-radius: 16px; padding: 30px; margin-bottom: 30px; text-align: center;">
      <div style="color: #ffaa00; font-size: 48px; font-weight: 700;">${params.creditsRemaining.toLocaleString()}</div>
      <div style="color: #8899aa; font-size: 14px;">credits remaining</div>
    </div>

    <div style="text-align: center;">
      <a href="https://proceedgate.dev/pay?plan=${params.plan.toLowerCase()}" style="display: inline-block; background: linear-gradient(135deg, #00d4aa, #00b894); color: #0a0f1c; text-decoration: none; padding: 16px 40px; border-radius: 12px; font-weight: 600; font-size: 16px;">Top Up Credits</a>
    </div>
  </div>
</body>
</html>
`;

  return sendEmail(env, {
    to: params.to,
    subject: `⚠️ ProceedGate: Low credits (${params.creditsRemaining.toLocaleString()} remaining)`,
    html,
  });
}

// Send expiry warning
export async function sendExpiryWarning(
  env: Env,
  params: ExpiryWarningParams
): Promise<{ ok: boolean }> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Subscription Expiring - ProceedGate</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #0a0f1c;">
  <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <div style="text-align: center; margin-bottom: 40px;">
      <div style="display: inline-block; background: #ff6b6b; width: 50px; height: 50px; border-radius: 12px; line-height: 50px; font-size: 24px;">⏰</div>
      <h1 style="color: #ffffff; margin: 20px 0 10px 0; font-size: 28px;">Subscription Expiring Soon</h1>
      <p style="color: #8899aa; margin: 0;">Your ProceedGate ${params.plan} plan expires in ${params.daysLeft} days</p>
    </div>

    <div style="background: rgba(255,107,107,0.1); border: 1px solid rgba(255,107,107,0.3); border-radius: 16px; padding: 30px; margin-bottom: 30px; text-align: center;">
      <div style="color: #ff6b6b; font-size: 48px; font-weight: 700;">${params.daysLeft}</div>
      <div style="color: #8899aa; font-size: 14px;">days left</div>
      <div style="color: #556677; font-size: 13px; margin-top: 8px;">Expires: ${params.expiresAt}</div>
    </div>

    <div style="text-align: center;">
      <a href="https://proceedgate.dev/pay?plan=${params.plan.toLowerCase()}&renew=true" style="display: inline-block; background: linear-gradient(135deg, #00d4aa, #00b894); color: #0a0f1c; text-decoration: none; padding: 16px 40px; border-radius: 12px; font-weight: 600; font-size: 16px;">Renew Subscription</a>
    </div>
  </div>
</body>
</html>
`;

  return sendEmail(env, {
    to: params.to,
    subject: `⏰ ProceedGate: Subscription expires in ${params.daysLeft} days`,
    html,
  });
}

// Weekly savings report
interface WeeklySavingsParams {
  to: string;
  workspaceId: string;
  plan: string;
  costSavedUsd: number;
  stormsBlocked: number;
  totalChecks: number;
  topActions: Array<{ action: string; count: number }>;
  weekStart: string;
  weekEnd: string;
}

// Send free tier welcome email (dedicated template, no payment details)
export async function sendFreeWelcomeEmail(
  env: Env,
  params: { to: string; workspaceId: string; apiKey: string }
): Promise<{ ok: boolean; error?: string }> {
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#09090b;">
<div style="max-width:560px;margin:0 auto;padding:40px 20px;">
  <div style="text-align:center;margin-bottom:32px;">
    <div style="display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;background:#2dd4bf;border-radius:10px;font-size:22px;margin-bottom:16px;">✓</div>
    <h1 style="color:#fafafa;margin:0 0 8px;font-size:24px;letter-spacing:-.02em;">You're in — ProceedGate Free</h1>
    <p style="color:#a1a1aa;margin:0;font-size:14px;">2,000 free checks/month. No credit card.</p>
  </div>

  <div style="background:rgba(45,212,191,.07);border:1px solid rgba(45,212,191,.25);border-radius:12px;padding:24px;margin-bottom:24px;">
    <p style="color:#a1a1aa;font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin:0 0 16px;">Your credentials</p>
    <div style="margin-bottom:12px;">
      <div style="color:#71717a;font-size:11px;margin-bottom:4px;">Workspace ID</div>
      <div style="color:#fafafa;font-family:monospace;font-size:13px;background:rgba(0,0,0,.4);padding:10px 12px;border-radius:6px;word-break:break-all;">${params.workspaceId}</div>
    </div>
    <div style="margin-bottom:16px;">
      <div style="color:#71717a;font-size:11px;margin-bottom:4px;">API Key</div>
      <div style="color:#fafafa;font-family:monospace;font-size:13px;background:rgba(0,0,0,.4);padding:10px 12px;border-radius:6px;word-break:break-all;">${params.apiKey}</div>
    </div>
    <div style="background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.25);border-radius:6px;padding:10px 12px;font-size:12px;color:#fbbf24;">
      Save your API key — it won't be shown again.
    </div>
  </div>

  <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:20px;margin-bottom:24px;">
    <p style="color:#a1a1aa;font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin:0 0 12px;">First check call</p>
    <pre style="margin:0;font-family:monospace;font-size:12px;color:#4ade80;white-space:pre-wrap;overflow-x:auto;">curl -X POST https://governor.proceedgate.dev/v1/check \\
  -H "Authorization: Bearer ${params.apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"agent_id":"my-agent","task_hash":"sha256-of-task","action":"tool_call"}'</pre>
  </div>

  <div style="text-align:center;padding:8px 0 32px;">
    <a href="https://proceedgate.dev/dashboard.html" style="display:inline-block;background:#2dd4bf;color:#09090b;font-weight:600;font-size:14px;padding:12px 28px;border-radius:8px;text-decoration:none;">Open Dashboard →</a>
  </div>

  <p style="color:#52525b;font-size:12px;text-align:center;margin:0;">
    Questions? Reply to this email or check <a href="https://proceedgate.dev/docs.html" style="color:#2dd4bf;">docs.proceedgate.dev</a>
  </p>
</div>
</body>
</html>`;

  return sendEmail(env, {
    to: params.to,
    subject: 'Your ProceedGate API key',
    html,
    text: `Welcome to ProceedGate Free!\n\nWorkspace ID: ${params.workspaceId}\nAPI Key: ${params.apiKey}\n\nFirst check:\ncurl -X POST https://governor.proceedgate.dev/v1/check -H "Authorization: Bearer ${params.apiKey}" -H "Content-Type: application/json" -d '{"agent_id":"my-agent","task_hash":"sha256-of-task","action":"tool_call"}'\n\nDashboard: https://proceedgate.dev/dashboard.html\n`,
  });
}

export async function sendWeeklySavingsReport(
  env: Env,
  params: WeeklySavingsParams
): Promise<{ ok: boolean }> {
  const topActionsHtml = params.topActions.length > 0
    ? params.topActions.map(a =>
      `<tr><td style="color:#c8d6e5;padding:6px 12px;border-bottom:1px solid rgba(255,255,255,0.05)">${a.action}</td>` +
      `<td style="color:#00d4aa;padding:6px 12px;border-bottom:1px solid rgba(255,255,255,0.05);text-align:right">${a.count}×</td></tr>`
    ).join('')
    : '<tr><td colspan="2" style="color:#556677;padding:12px;text-align:center">No blocked actions this week</td></tr>';

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Weekly Savings Report - ProceedGate</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background-color:#0a0f1c;">
  <div style="max-width:600px;margin:0 auto;padding:40px 20px;">
    <div style="text-align:center;margin-bottom:40px;">
      <div style="display:inline-block;background:#00d4aa;width:50px;height:50px;border-radius:12px;line-height:50px;font-size:24px;">💰</div>
      <h1 style="color:#ffffff;margin:20px 0 10px 0;font-size:28px;">Your Weekly Savings Report</h1>
      <p style="color:#8899aa;margin:0;">${params.weekStart} — ${params.weekEnd}</p>
    </div>

    <div style="background:rgba(0,212,170,0.1);border:1px solid rgba(0,212,170,0.3);border-radius:16px;padding:30px;margin-bottom:20px;text-align:center;">
      <div style="color:#8899aa;font-size:14px;margin-bottom:8px;">Cost saved this week</div>
      <div style="color:#00d4aa;font-size:52px;font-weight:700;">$${params.costSavedUsd.toFixed(2)}</div>
    </div>

    <div style="display:flex;gap:12px;margin-bottom:30px;">
      <div style="flex:1;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:20px;text-align:center;">
        <div style="color:#ff6b6b;font-size:32px;font-weight:700;">${params.stormsBlocked}</div>
        <div style="color:#8899aa;font-size:13px;">Storms blocked</div>
      </div>
      <div style="flex:1;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:20px;text-align:center;">
        <div style="color:#74b9ff;font-size:32px;font-weight:700;">${params.totalChecks}</div>
        <div style="color:#8899aa;font-size:13px;">Total checks</div>
      </div>
    </div>

    <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:20px;margin-bottom:30px;">
      <h3 style="color:#ffffff;margin:0 0 12px 0;font-size:16px;">Top Blocked Actions</h3>
      <table style="width:100%;border-collapse:collapse;">
        ${topActionsHtml}
      </table>
    </div>

    <div style="text-align:center;margin-bottom:20px;">
      <a href="https://proceedgate.dev/dashboard?ws=${encodeURIComponent(params.workspaceId)}" style="display:inline-block;background:linear-gradient(135deg,#00d4aa,#00b894);color:#0a0f1c;text-decoration:none;padding:16px 40px;border-radius:12px;font-weight:600;font-size:16px;">View Dashboard</a>
    </div>

    <p style="color:#556677;font-size:12px;text-align:center;">
      Workspace: ${params.workspaceId} · ${params.plan} plan<br>
      <a href="mailto:unsubscribe@proceedgate.dev?subject=Unsubscribe%20${params.workspaceId}" style="color:#556677;">Unsubscribe</a>
    </p>
  </div>
</body>
</html>
`;

  return sendEmail(env, {
    to: params.to,
    subject: `💰 ProceedGate: You saved $${params.costSavedUsd.toFixed(2)} this week`,
    html,
  });
}
