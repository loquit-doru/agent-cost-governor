/**
 * Alert Webhooks System
 * 
 * Sends notifications for:
 * - Budget thresholds reached
 * - Friction events (blocked actions)
 * - Anomaly detection (unusual spending patterns)
 */

export type AlertType = 
  | 'budget_threshold'
  | 'budget_exceeded'
  | 'friction_event'
  | 'anomaly_detected';

export interface AlertPayload {
  type: AlertType;
  workspace_id: string;
  timestamp: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  details: Record<string, unknown>;
}

export interface WebhookConfig {
  url: string;
  format: 'generic' | 'slack' | 'discord';
  secret?: string;
}

/**
 * Format alert for Slack
 */
function formatSlackPayload(alert: AlertPayload): object {
  const colorMap = {
    info: '#36a64f',
    warning: '#ffa500',
    critical: '#ff0000',
  };

  return {
    attachments: [
      {
        color: colorMap[alert.severity],
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: `🚨 ${alert.title}`,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: alert.message,
            },
          },
          {
            type: 'section',
            fields: [
              {
                type: 'mrkdwn',
                text: `*Workspace:*\n${alert.workspace_id}`,
              },
              {
                type: 'mrkdwn',
                text: `*Severity:*\n${alert.severity.toUpperCase()}`,
              },
              {
                type: 'mrkdwn',
                text: `*Type:*\n${alert.type}`,
              },
              {
                type: 'mrkdwn',
                text: `*Time:*\n${alert.timestamp}`,
              },
            ],
          },
          ...(Object.keys(alert.details).length > 0
            ? [
                {
                  type: 'section',
                  text: {
                    type: 'mrkdwn',
                    text: `*Details:*\n\`\`\`${JSON.stringify(alert.details, null, 2)}\`\`\``,
                  },
                },
              ]
            : []),
        ],
      },
    ],
  };
}

/**
 * Format alert for Discord
 */
function formatDiscordPayload(alert: AlertPayload): object {
  const colorMap = {
    info: 0x36a64f,
    warning: 0xffa500,
    critical: 0xff0000,
  };

  return {
    embeds: [
      {
        title: `🚨 ${alert.title}`,
        description: alert.message,
        color: colorMap[alert.severity],
        fields: [
          {
            name: 'Workspace',
            value: alert.workspace_id,
            inline: true,
          },
          {
            name: 'Severity',
            value: alert.severity.toUpperCase(),
            inline: true,
          },
          {
            name: 'Type',
            value: alert.type,
            inline: true,
          },
          ...(Object.keys(alert.details).length > 0
            ? [
                {
                  name: 'Details',
                  value: `\`\`\`json\n${JSON.stringify(alert.details, null, 2)}\`\`\``,
                  inline: false,
                },
              ]
            : []),
        ],
        timestamp: alert.timestamp,
      },
    ],
  };
}

/**
 * Send alert to webhook
 */
export async function sendAlert(
  config: WebhookConfig,
  alert: AlertPayload
): Promise<{ ok: boolean; error?: string }> {
  try {
    let payload: object;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    switch (config.format) {
      case 'slack':
        payload = formatSlackPayload(alert);
        break;
      case 'discord':
        payload = formatDiscordPayload(alert);
        break;
      default:
        payload = alert;
    }

    // Add HMAC signature if secret is configured
    if (config.secret) {
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(config.secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const signature = await crypto.subtle.sign(
        'HMAC',
        key,
        encoder.encode(JSON.stringify(payload))
      );
      headers['X-Signature-256'] = `sha256=${Array.from(new Uint8Array(signature))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')}`;
    }

    const response = await fetch(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Create budget threshold alert
 */
export function createBudgetThresholdAlert(params: {
  workspaceId: string;
  limitType: 'daily' | 'weekly' | 'monthly';
  currentUsage: number;
  limit: number;
  threshold: number;
}): AlertPayload {
  const percentUsed = ((params.currentUsage / params.limit) * 100).toFixed(1);

  return {
    type: 'budget_threshold',
    workspace_id: params.workspaceId,
    timestamp: new Date().toISOString(),
    severity: 'warning',
    title: `Budget Alert: ${params.threshold}% threshold reached`,
    message: `Your ${params.limitType} budget is ${percentUsed}% used (${params.currentUsage}/${params.limit} credits).`,
    details: {
      limit_type: params.limitType,
      current_usage: params.currentUsage,
      limit: params.limit,
      threshold_percent: params.threshold,
      percent_used: parseFloat(percentUsed),
    },
  };
}

/**
 * Create budget exceeded alert
 */
export function createBudgetExceededAlert(params: {
  workspaceId: string;
  limitType: 'daily' | 'weekly' | 'monthly';
  currentUsage: number;
  limit: number;
  blockedAction?: string;
}): AlertPayload {
  return {
    type: 'budget_exceeded',
    workspace_id: params.workspaceId,
    timestamp: new Date().toISOString(),
    severity: 'critical',
    title: `Budget Exceeded: ${params.limitType} limit reached`,
    message: `Your ${params.limitType} budget of ${params.limit} credits has been exceeded. Actions are now blocked.`,
    details: {
      limit_type: params.limitType,
      current_usage: params.currentUsage,
      limit: params.limit,
      blocked_action: params.blockedAction,
    },
  };
}

/**
 * Create friction event alert
 */
export function createFrictionAlert(params: {
  workspaceId: string;
  decisionId: string;
  action: string;
  reasonCode: string;
  frictionPrice: string;
}): AlertPayload {
  return {
    type: 'friction_event',
    workspace_id: params.workspaceId,
    timestamp: new Date().toISOString(),
    severity: 'info',
    title: 'Friction Required',
    message: `Action "${params.action}" requires friction resolution (${params.frictionPrice}).`,
    details: {
      decision_id: params.decisionId,
      action: params.action,
      reason_code: params.reasonCode,
      friction_price: params.frictionPrice,
    },
  };
}

/**
 * Create anomaly alert
 */
export function createAnomalyAlert(params: {
  workspaceId: string;
  anomalyType: string;
  description: string;
  details: Record<string, unknown>;
}): AlertPayload {
  return {
    type: 'anomaly_detected',
    workspace_id: params.workspaceId,
    timestamp: new Date().toISOString(),
    severity: 'warning',
    title: `Anomaly Detected: ${params.anomalyType}`,
    message: params.description,
    details: params.details,
  };
}
