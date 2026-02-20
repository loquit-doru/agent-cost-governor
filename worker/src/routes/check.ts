import { Hono } from 'hono';
import type { Env, Vars, GovernanceMode } from '../types.js';
import { checkSchema } from '../lib/schemas.js';
import { computeRetryFrictionPrice, computeLowConfidencePrice, computeLLMCostPrice } from '../lib/pricing.js';
import { getBillingMode, getX402Price, getX402Chain, getX402Recipient } from '../lib/config.js';
import { makeDecisionId, setProceedgateHeaders } from '../lib/utils.js';
import { signProceedToken } from '../services/signing.js';
import { putDecisionRecord, consumeWorkspaceCredits } from '../services/store.js';
import { requireWorkspaceAuth } from '../middleware/auth.js';
import { logEvent, actorKey } from '../observability.js';
import { writeMetric } from '../metrics.js';
import { webhookCreditsLow, webhookBudgetExceeded } from '../services/webhook.js';
import { sendLowCreditsAlert } from '../services/email.js';
import { getBillingStub, doUrl } from '../lib/do.js';
import { hashApiKey } from '../lib/crypto.js';
import { API_KEY_PREFIXES } from '../lib/constants.js';
import { generateReasoning, generateReasoningWithAI, aiDecideGrayZone, cachedGrayZoneDecision } from '../lib/aiReasoning.js';

const checkRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

checkRoutes.post('/v1/governor/check', async (c) => {
  const startMs = Date.now();
  const origin = new URL(c.req.url).origin;
  const body = await c.req.json().catch(() => null);
  const parsed = checkSchema.safeParse(body);

  if (!parsed.success) {
    writeMetric(c.env, {
      indexes: ['check_invalid', 'unknown', 'unknown', 'invalid_request'],
      doubles: [1, Date.now() - startMs],
    });
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const billingMode = getBillingMode(c.env);
  if (billingMode === 'credits') {
    const workspaceId = parsed.data.actor.project?.trim() || parsed.data.actor.id;

    const authErr = await requireWorkspaceAuth(c, workspaceId);
    if (authErr) return authErr;

    // ── Agent Reputation: fetch trust score for threshold modulation ───
    const stub = getBillingStub(c.env);
    let trustScore = 50; // Default: normal tier
    let trustTier: 'trusted' | 'normal' | 'untrusted' = 'normal';
    let loopMaxCountMultiplier = 1.0;
    let grayZoneOffset = 0;
    let governanceMode: GovernanceMode = 'enforce';
    try {
      const repRes = await stub.fetch(doUrl(`/workspaces/${workspaceId}/reputation`));
      if (repRes.ok) {
        const repData = await repRes.json() as {
          ok: boolean;
          reputation: {
            score: number;
            tier: 'trusted' | 'normal' | 'untrusted';
            thresholds: { loop_max_count_multiplier: number; gray_zone_offset: number };
          };
          governance_mode?: string;
        };
        trustScore = repData.reputation.score;
        trustTier = repData.reputation.tier;
        loopMaxCountMultiplier = repData.reputation.thresholds.loop_max_count_multiplier;
        grayZoneOffset = repData.reputation.thresholds.gray_zone_offset;
        if (repData.governance_mode === 'log_only') governanceMode = 'log_only';
      }
    } catch { /* reputation fetch failed — use defaults */ }

    c.header('X-Proceedgate-Trust-Score', String(trustScore));
    c.header('X-Proceedgate-Trust-Tier', trustTier);
    if (governanceMode === 'log_only') c.header('X-Proceedgate-Mode', 'log_only');

    // Loop detection - check if this action pattern is repeating too fast
    const patternHash = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`${parsed.data.action}:${parsed.data.context.task_hash || ''}:${parsed.data.context.step_hash || ''}`)
    ).then(buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16));

    // Similarity prefix: hash of just the action (groups variants like page=1, page=2)
    const similarityPrefix = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(parsed.data.action)
    ).then(buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 8));

    // Apply trust-modulated max_count: trusted agents get more lenient thresholds
    const baseMaxCount = 10;
    const effectiveMaxCount = Math.round(baseMaxCount * loopMaxCountMultiplier);

    const loopCheckRes = await stub.fetch(doUrl(`/workspaces/${workspaceId}/check-loop`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 
        pattern_hash: patternHash,
        window_ms: 60000, // 1 minute window
        max_count: effectiveMaxCount, // Trust-modulated threshold
        cost_usd: 0.05, // estimated cost per API check
        similarity_prefix: similarityPrefix,
        action: parsed.data.action,
        depth: parsed.data.context.depth ?? 0,
      }),
    });

    const loopData = await loopCheckRes.json() as {
      count: number;
      zone: 'safe' | 'gray' | 'storm';
      timing?: {
        avg_interval_ms: number;
        interval_cv: number;
        requests_per_sec: number;
        window_elapsed_ms: number;
      };
      cost_window_usd?: number;
      backoff_detected?: boolean;
      similar_pattern_count?: number;
      fingerprint_hash?: string;
      fingerprint?: {
        burst_index: number;
        entropy: number;
        fanout_ratio: number;
        avg_depth: number;
        retry_distribution: [number, number, number, number];
      };
    };

    // ─── ZONE: STORM (count > 10) — Hard block, no AI needed ──────────
    if (loopCheckRes.status === 429) {
      logEvent({
        event: 'loop_detected',
        workspace_id: workspaceId,
        actor_key: await actorKey(parsed.data.actor.id),
        action: parsed.data.action,
        pattern_hash: patternHash,
        count: loopData.count,
        zone: 'storm',
      });

      writeMetric(c.env, {
        indexes: ['check_loop_blocked', parsed.data.policy_id, parsed.data.action, 'loop_detected'],
        doubles: [1, Date.now() - startMs],
      });

      c.header('cache-control', 'no-store');
      c.header('X-Proceedgate-Loop-Detected', 'true');
      c.header('X-Proceedgate-Zone', 'storm');
      if (loopData.fingerprint_hash) c.header('X-Proceedgate-Fingerprint', loopData.fingerprint_hash);

      const reasoning = generateReasoning({
        decision: 'blocked_storm',
        action: parsed.data.action,
        actor_id: parsed.data.actor.id,
        pattern_count: loopData.count,
        window_seconds: 60,
        cost_saved_usd: 0.05,
        task_hash: parsed.data.context.task_hash,
        step_hash: parsed.data.context.step_hash,
      });

      // Log decision asynchronously
      const logBody = JSON.stringify({
        id: makeDecisionId(),
        timestamp: new Date().toISOString(),
        action: parsed.data.action,
        task_hash: parsed.data.context.task_hash || '',
        step_hash: parsed.data.context.step_hash || '',
        decision: 'blocked_storm',
        latency_ms: Date.now() - startMs,
        pattern_count: loopData.count,
        cost_saved_usd: 0.05,
        ai_reasoning: reasoning.ai_reasoning,
        zone: 'storm',
      });
      c.executionCtx.waitUntil(
        stub.fetch(doUrl(`/workspaces/${workspaceId}/log-decision`), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: logBody,
        }).catch(() => {})
      );

      // Record reputation: storm blocked
      c.executionCtx.waitUntil(
        stub.fetch(doUrl(`/workspaces/${workspaceId}/reputation`), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ blocked: true, reason: 'storm', zone: 'storm', backoff_detected: loopData.backoff_detected }),
        }).catch(() => {})
      );

      const stormBody = {
        allowed: false as boolean,
        error: 'loop_detected',
        workspace_id: workspaceId,
        reason: 'Too many identical requests detected. Possible agent loop.',
        pattern_count: loopData.count,
        zone: 'storm',
        cost_saved: '$0.05',
        cost_saved_usd: 0.05,
        message: `🚫 Blocked retry storm. You just saved $0.05`,
        hint: 'Add variation to task_hash or step_hash, or wait before retrying.',
        fingerprint_hash: loopData.fingerprint_hash ?? null,
        trust_score: trustScore,
        trust_tier: trustTier,
        ...reasoning,
      };

      if (governanceMode === 'log_only') {
        return c.json({ ...stormBody, allowed: true, enforced: false, would_block: true, would_block_status: 429 }, 200);
      }
      return c.json(stormBody, 429);
    }

    // ─── ZONE: GRAY (count 6-10) — AI decides allow/block ─────────────
    if (loopData.zone === 'gray' && loopData.timing) {
      const grayInput = {
        action: parsed.data.action,
        actor_id: parsed.data.actor.id,
        count: loopData.count,
        max_count: 10,
        avg_interval_ms: loopData.timing.avg_interval_ms,
        interval_cv: loopData.timing.interval_cv,
        requests_per_sec: loopData.timing.requests_per_sec,
        window_elapsed_ms: loopData.timing.window_elapsed_ms,
        task_hash: parsed.data.context.task_hash,
        step_hash: parsed.data.context.step_hash,
        // Smart pattern signals
        cost_window_usd: loopData.cost_window_usd,
        backoff_detected: loopData.backoff_detected,
        similar_pattern_count: loopData.similar_pattern_count,
      };
      const { decision: grayDecision, cacheHit } = await cachedGrayZoneDecision(c.env, grayInput);

      c.header('X-Proceedgate-Zone', 'gray');
      c.header('X-Proceedgate-AI-Decided', String(grayDecision.ai_decided));
      c.header('X-Proceedgate-AI-Model', grayDecision.model);
      c.header('X-Proceedgate-Cache', cacheHit ? 'hit' : 'miss');
      if (loopData.fingerprint_hash) c.header('X-Proceedgate-Fingerprint', loopData.fingerprint_hash);

      if (grayDecision.decision === 'block') {
        logEvent({
          event: 'gray_zone_blocked',
          workspace_id: workspaceId,
          actor_key: await actorKey(parsed.data.actor.id),
          action: parsed.data.action,
          pattern_hash: patternHash,
          count: loopData.count,
          zone: 'gray',
          ai_decided: grayDecision.ai_decided,
          ai_model: grayDecision.model,
        });

        writeMetric(c.env, {
          indexes: ['check_gray_blocked', parsed.data.policy_id, parsed.data.action, 'ai_block'],
          doubles: [1, Date.now() - startMs],
        });

        c.header('cache-control', 'no-store');
        c.header('X-Proceedgate-Loop-Detected', 'true');

        const logBody = JSON.stringify({
          id: makeDecisionId(),
          timestamp: new Date().toISOString(),
          action: parsed.data.action,
          task_hash: parsed.data.context.task_hash || '',
          step_hash: parsed.data.context.step_hash || '',
          decision: 'blocked_storm',
          latency_ms: Date.now() - startMs,
          pattern_count: loopData.count,
          cost_saved_usd: 0.03,
          ai_reasoning: grayDecision.reasoning,
          zone: 'gray',
          ai_decided: grayDecision.ai_decided,
        });
        c.executionCtx.waitUntil(
          stub.fetch(doUrl(`/workspaces/${workspaceId}/log-decision`), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: logBody,
          }).catch(() => {})
        );

        // Record reputation: gray zone blocked
        c.executionCtx.waitUntil(
          stub.fetch(doUrl(`/workspaces/${workspaceId}/reputation`), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ blocked: true, reason: 'gray_blocked', zone: 'gray', backoff_detected: loopData.backoff_detected }),
          }).catch(() => {})
        );

        const grayBlockBody = {
          allowed: false as boolean,
          error: 'ai_blocked',
          workspace_id: workspaceId,
          reason: grayDecision.reasoning,
          pattern_count: loopData.count,
          zone: 'gray',
          ai_decided: grayDecision.ai_decided,
          ai_model: grayDecision.model,
          cost_saved: '$0.03',
          cost_saved_usd: 0.03,
          message: `🤖 AI blocked suspicious pattern (${loopData.count} requests in gray zone)`,
          hint: 'AI analyzed timing patterns and decided to block. Vary your request timing or add variation to step_hash.',
          ai_reasoning: grayDecision.reasoning,
          reasoning_chain: [{
            step: 'gray_zone_analysis',
            observation: `${loopData.count} requests, interval CV=${loopData.timing.interval_cv.toFixed(3)}, ${loopData.timing.requests_per_sec.toFixed(2)} req/s`,
            conclusion: grayDecision.reasoning,
          }],
          confidence: grayDecision.confidence,
          model: grayDecision.model,
          trust_score: trustScore,
          trust_tier: trustTier,
        };

        if (governanceMode === 'log_only') {
          return c.json({ ...grayBlockBody, allowed: true, enforced: false, would_block: true, would_block_status: 429 }, 200);
        }
        return c.json(grayBlockBody, 429);
      }

      // AI decided to ALLOW in gray zone — log it and continue normal flow
      logEvent({
        event: 'gray_zone_allowed',
        workspace_id: workspaceId,
        actor_key: await actorKey(parsed.data.actor.id),
        action: parsed.data.action,
        count: loopData.count,
        zone: 'gray',
        ai_decided: grayDecision.ai_decided,
        ai_model: grayDecision.model,
      });

      writeMetric(c.env, {
        indexes: ['check_gray_allowed', parsed.data.policy_id, parsed.data.action, 'ai_allow'],
        doubles: [1, Date.now() - startMs],
      });

      // Gray zone allow: continue to normal credit consumption below
      // but attach the gray zone metadata to the final response later
      c.set('grayZoneDecision' as never, grayDecision as never);
    }

    // ─── ZONE: SAFE (count <= 5) or GRAY-ALLOWED — proceed to credits ─

    // ─── Custom Policy Evaluation ────────────────────────────────────
    // Fetch workspace custom policies and evaluate them against the current request
    {
      const policiesRes = await stub.fetch(doUrl(`/workspaces/${workspaceId}/policies`));
      if (policiesRes.ok) {
        const policiesData = await policiesRes.json() as {
          policies: Array<{
            id: string;
            name: string;
            rules: {
              max_requests_per_minute?: number;
              blocked_actions?: string[];
              blocked_tools?: string[];
              max_cost_per_request?: number;
              require_confidence_above?: number;
              allowed_hours?: { start: number; end: number };
            };
          }>;
        };

        for (const policy of policiesData.policies) {
          const rules = policy.rules;
          if (!rules) continue;

          // Check blocked actions
          if (rules.blocked_actions?.includes(parsed.data.action)) {
            logEvent({
              event: 'custom_policy_blocked',
              workspace_id: workspaceId,
              policy_id: policy.id,
              policy_name: policy.name,
              reason: 'blocked_action',
            });
            return c.json({
              allowed: false,
              error: 'custom_policy_blocked',
              workspace_id: workspaceId,
              policy: { id: policy.id, name: policy.name },
              reason: `Action "${parsed.data.action}" is blocked by policy "${policy.name}"`,
              message: `🛑 Blocked by custom policy: ${policy.name}`,
            }, 403);
          }

          // Check blocked tools
          const tool = parsed.data.context.tool;
          if (tool && rules.blocked_tools?.includes(tool)) {
            logEvent({
              event: 'custom_policy_blocked',
              workspace_id: workspaceId,
              policy_id: policy.id,
              policy_name: policy.name,
              reason: 'blocked_tool',
            });
            return c.json({
              allowed: false,
              error: 'custom_policy_blocked',
              workspace_id: workspaceId,
              policy: { id: policy.id, name: policy.name },
              reason: `Tool "${tool}" is blocked by policy "${policy.name}"`,
              message: `🛑 Blocked by custom policy: ${policy.name}`,
            }, 403);
          }

          // Check cost limit per request
          if (rules.max_cost_per_request !== undefined && parsed.data.context.cost_estimate !== undefined) {
            if (parsed.data.context.cost_estimate > rules.max_cost_per_request) {
              return c.json({
                allowed: false,
                error: 'custom_policy_blocked',
                workspace_id: workspaceId,
                policy: { id: policy.id, name: policy.name },
                reason: `Cost estimate $${parsed.data.context.cost_estimate} exceeds policy limit $${rules.max_cost_per_request}`,
                message: `🛑 Blocked by custom policy: ${policy.name}`,
              }, 403);
            }
          }

          // Check minimum confidence
          if (rules.require_confidence_above !== undefined && parsed.data.context.confidence !== undefined) {
            if (parsed.data.context.confidence < rules.require_confidence_above) {
              return c.json({
                allowed: false,
                error: 'custom_policy_blocked',
                workspace_id: workspaceId,
                policy: { id: policy.id, name: policy.name },
                reason: `Confidence ${parsed.data.context.confidence} below required ${rules.require_confidence_above}`,
                message: `🛑 Blocked by custom policy: ${policy.name}`,
              }, 403);
            }
          }

          // Check time-of-day restrictions
          if (rules.allowed_hours) {
            const hour = new Date().getUTCHours();
            const { start, end } = rules.allowed_hours;
            const inWindow = start <= end
              ? (hour >= start && hour < end)
              : (hour >= start || hour < end); // Handles overnight ranges like 22-06
            if (!inWindow) {
              return c.json({
                allowed: false,
                error: 'custom_policy_blocked',
                workspace_id: workspaceId,
                policy: { id: policy.id, name: policy.name },
                reason: `Current UTC hour ${hour} outside allowed ${start}-${end}`,
                message: `🛑 Blocked by custom policy: ${policy.name}`,
              }, 403);
            }
          }
        }
      }
    }

    const consumed = await consumeWorkspaceCredits(c.env, workspaceId, 1, {
      action: parsed.data.action,
    });
    if (!consumed.ok) {
      logEvent({
        event: 'billing_consume_fail',
        workspace_id: workspaceId,
        actor_key: await actorKey(parsed.data.actor.id),
        error: consumed.error,
      });

      writeMetric(c.env, {
        indexes: ['billing_consume_fail', parsed.data.policy_id, parsed.data.action, consumed.error],
        doubles: [1, Date.now() - startMs],
      });

      // Track blocked request for "cost saved" metric
      const stub = getBillingStub(c.env);
      stub.fetch(doUrl(`/workspaces/${workspaceId}/block`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ 
          reason: consumed.error || 'insufficient_credits',
          estimated_cost_usd: 0.01, // Conservative estimate per blocked API call
          action: parsed.data.action,
        }),
      }).catch(() => {}); // Fire and forget

      // Send budget.exceeded webhook if a budget limit was hit
      if (consumed.limitType) {
        const webhookRes = await stub.fetch(doUrl(`/workspaces/${workspaceId}/webhook`));
        if (webhookRes.ok) {
          const webhookConfig = await webhookRes.json() as { ok: boolean; webhook_url?: string; webhook_secret?: string };
          if (webhookConfig.ok && webhookConfig.webhook_url) {
            webhookBudgetExceeded(c.env, {
              webhookUrl: webhookConfig.webhook_url,
              webhookSecret: webhookConfig.webhook_secret,
              workspaceId,
              limitType: consumed.limitType as 'daily' | 'weekly' | 'monthly',
              limit: 0, // Limit value not returned from DO, use 0 as signal
              usage: consumed.currentUsage ?? 0,
            }).catch(err => console.error('Budget exceeded webhook failed:', err));
          }
        }
      }

      c.header('cache-control', 'no-store');
      c.header('X-Proceedgate-Billing-Mode', 'credits');

      const creditsReasoning = generateReasoning({
        decision: 'blocked_credits',
        action: parsed.data.action,
        actor_id: parsed.data.actor.id,
        credits_remaining: consumed.credits,
      });

      const creditsBlockBody = {
          allowed: false as boolean,
          error: 'insufficient_credits',
          workspace_id: workspaceId,
          credits_remaining: consumed.credits,
          cost_saved: '$0.01',
          cost_saved_usd: 0.01,
          message: '🚫 Blocked. You just saved $0.01 by not burning more credits.',
          billing: {
            quote_url: '/v1/billing/quote',
            redeem_url: '/v1/billing/redeem',
            balance_url: `/v1/billing/balance?workspace_id=${encodeURIComponent(workspaceId)}`,
          },
          ...creditsReasoning,
        };

      if (governanceMode === 'log_only') {
        return c.json({ ...creditsBlockBody, allowed: true, enforced: false, would_block: true, would_block_status: 402 }, 200);
      }
      return c.json(creditsBlockBody, 402);
    }

    // Send credits.low webhook + email if this is the first time crossing the threshold
    if (consumed.creditsLowNotify && consumed.maxCredits) {
      const stub = getBillingStub(c.env);
      const webhookRes = await stub.fetch(doUrl(`/workspaces/${workspaceId}/webhook`));
      if (webhookRes.ok) {
        const webhookConfig = await webhookRes.json() as { ok: boolean; webhook_url?: string; webhook_secret?: string };
        if (webhookConfig.ok && webhookConfig.webhook_url) {
          webhookCreditsLow(c.env, {
            webhookUrl: webhookConfig.webhook_url,
            webhookSecret: webhookConfig.webhook_secret,
            workspaceId,
            creditsRemaining: consumed.credits,
            thresholdPercent: 20,
            maxCredits: consumed.maxCredits,
          }).catch(err => console.error('Credits low webhook failed:', err));
        }
      }

      // Send low credits email alert (fire-and-forget)
      c.executionCtx.waitUntil(
        (async () => {
          try {
            const emailRes = await stub.fetch(doUrl(`/workspaces/${workspaceId}/email`));
            if (emailRes.ok) {
              const emailData = await emailRes.json() as { ok: boolean; email?: string | null };
              if (emailData.email) {
                const subRes = await stub.fetch(doUrl(`/workspaces/${workspaceId}/subscription`));
                const subData = subRes.ok ? await subRes.json() as { plan?: string } : { plan: 'starter' };
                await sendLowCreditsAlert(c.env, {
                  to: emailData.email,
                  workspaceId,
                  creditsRemaining: consumed.credits,
                  plan: subData.plan ?? 'starter',
                });
              }
            }
          } catch (err) {
            console.error('Low credits email failed:', err);
          }
        })()
      );
    }

    // Record reputation: credits consumed successfully (fire-and-forget)
    c.executionCtx.waitUntil(
      stub.fetch(doUrl(`/workspaces/${workspaceId}/reputation`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blocked: false, zone: loopData.zone ?? 'safe', backoff_detected: loopData.backoff_detected }),
      }).catch(() => {})
    );
  }

  const decisionId = makeDecisionId();
  const attempt = parsed.data.context.attempt_in_window;
  const confidence = parsed.data.context.confidence;

  let priceInfo: { price: string; required: boolean; explain: string };
  let reasonCode: string = 'none';

  if (parsed.data.policy_id === 'retry_friction_v1') {
    priceInfo = computeRetryFrictionPrice(c.env, attempt);
    reasonCode = priceInfo.required ? 'retry_friction' : 'none';
  } else if (parsed.data.policy_id === 'llm_cost_v1') {
    priceInfo = computeLLMCostPrice(c.env, {
      model: parsed.data.context.model ?? 'unknown',
      provider: parsed.data.context.provider,
      inputTokens: parsed.data.context.input_tokens,
      outputTokens: parsed.data.context.output_tokens,
      estimatedCost: parsed.data.context.cost_estimate,
      attemptInWindow: attempt,
    });
    reasonCode = priceInfo.required ? 'llm_cost' : 'none';
  } else {
    priceInfo = computeLowConfidencePrice(c.env, { confidence, attemptInWindow: attempt });
    reasonCode = priceInfo.required ? 'low_confidence' : 'none';
  }

  if (!priceInfo.required) {
    const signed = await signProceedToken({
      env: c.env,
      origin,
      actorId: parsed.data.actor.id,
      decisionId,
      policyId: parsed.data.policy_id,
      action: parsed.data.action,
      taskHash: parsed.data.context.task_hash,
      stepHash: parsed.data.context.step_hash,
      contextHash: parsed.data.context.context_hash,
    });

    setProceedgateHeaders(c, {
      decisionId,
      policyId: parsed.data.policy_id,
      reasonCode: 'none',
    });

    logEvent({
      event: 'governor_check_ok',
      decision_id: decisionId,
      policy_id: parsed.data.policy_id,
      action: parsed.data.action,
      reason_code: 'none',
      actor_key: await actorKey(parsed.data.actor.id),
      task_hash: parsed.data.context.task_hash ?? '',
      step_hash: parsed.data.context.step_hash ?? '',
      context_hash: parsed.data.context.context_hash ?? '',
    });

    writeMetric(c.env, {
      indexes: ['check_ok', parsed.data.policy_id, parsed.data.action, 'none'],
      doubles: [1, Date.now() - startMs],
    });

    const allowReasoning = generateReasoning({
      decision: 'allowed',
      action: parsed.data.action,
      actor_id: parsed.data.actor.id,
    });

    return c.json(
      {
        allowed: true,
        decision_id: decisionId,
        proceed_token: signed.token,
        expires_in_seconds: signed.expiresInSeconds,
        reason_code: 'none',
        policy: {
          policy_id: parsed.data.policy_id,
          friction_required: false,
          friction_price: '0 USDC',
        },
        ...allowReasoning,
      },
      200,
    );
  }

  // Friction required - return 402
  const x402Price = getX402Price(c.env, priceInfo.price);
  const recipient = getX402Recipient(c.env);
  const chain = getX402Chain(c.env);

  c.header('x402-price', x402Price);
  c.header('x402-recipient', recipient);
  c.header('x402-chain', chain);
  c.header('cache-control', 'no-store');

  const nowMs = Date.now();
  await putDecisionRecord(c.env, {
    decisionId,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + 10 * 60 * 1000, // 10 minutes for human to pay
    actorId: parsed.data.actor.id,
    policyId: parsed.data.policy_id,
    action: parsed.data.action,
    taskHash: parsed.data.context.task_hash,
    stepHash: parsed.data.context.step_hash,
    contextHash: parsed.data.context.context_hash,
    price: x402Price,
    chain,
    recipient,
  });

  setProceedgateHeaders(c, {
    decisionId,
    policyId: parsed.data.policy_id,
    reasonCode,
    frictionPrice: x402Price,
  });

  logEvent({
    event: 'governor_check_402',
    decision_id: decisionId,
    policy_id: parsed.data.policy_id,
    action: parsed.data.action,
    reason_code: reasonCode,
    actor_key: await actorKey(parsed.data.actor.id),
    task_hash: parsed.data.context.task_hash ?? '',
    step_hash: parsed.data.context.step_hash ?? '',
    context_hash: parsed.data.context.context_hash ?? '',
    friction_price: x402Price,
    chain,
    recipient,
  });

  writeMetric(c.env, {
    indexes: ['check_402', parsed.data.policy_id, parsed.data.action, reasonCode],
    doubles: [1, Date.now() - startMs],
  });

  const frictionReasoning = generateReasoning({
    decision: 'friction_required',
    action: parsed.data.action,
    actor_id: parsed.data.actor.id,
    friction_price: x402Price,
    policy_id: parsed.data.policy_id,
    attempt,
  });

  return c.json(
    {
      allowed: false,
      decision_id: decisionId,
      reason_code: reasonCode,
      policy: {
        policy_id: parsed.data.policy_id,
        friction_required: true,
        friction_price: x402Price,
        explain: priceInfo.explain,
      },
      redeem: {
        method: 'POST',
        url: '/v1/governor/redeem',
        requires_header: 'x402-tx-hash',
      },
      ...frictionReasoning,
    },
    402,
  );
});

// ============================================================================
// /v1/demo/check - Public demo endpoint (no auth needed)
// ============================================================================
// Lets anyone test loop detection from the website.
// Uses a fixed "demo-public" workspace internally.
// Rate limited per IP via the standard middleware.
// Uses real Workers AI (Llama 3.1 8B) for reasoning when available.
// Every decision is logged for real-time dashboard.
// ============================================================================

const demoCheckSchema = z.object({
  action: z.string().max(200).optional().default('tool_call'),
  task_hash: z.string().max(200).optional().default('demo-task'),
  step_hash: z.string().max(200).optional().default('demo-step'),
});

checkRoutes.post('/v1/demo/check', async (c) => {
  const startMs = Date.now();
  const body = await c.req.json().catch(() => null);
  const parsed = demoCheckSchema.safeParse(body ?? {});

  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const { action, task_hash, step_hash } = parsed.data;
  const demoWs = 'demo-public';

  // Loop detection — same logic as the real endpoint
  const stub = getBillingStub(c.env);
  const patternHash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${action}:${task_hash}:${step_hash}`),
  ).then(buf =>
    Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 16),
  );

  // Similarity prefix: hash of just the action (groups parameter variants)
  const similarityPrefix = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(action),
  ).then(buf =>
    Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 8),
  );

  const loopCheckRes = await stub.fetch(doUrl(`/workspaces/${demoWs}/check-loop`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pattern_hash: patternHash,
      window_ms: 60_000,
      max_count: 10,
      cost_usd: 0.05,
      similarity_prefix: similarityPrefix,
      action,
    }),
  });

  if (loopCheckRes.status === 429) {
    const loopData = (await loopCheckRes.json()) as { count: number; zone: string; timing?: { avg_interval_ms: number; interval_cv: number; requests_per_sec: number; window_elapsed_ms: number }; cost_window_usd?: number; backoff_detected?: boolean; similar_pattern_count?: number; fingerprint_hash?: string };
    const latencyMs = Date.now() - startMs;

    writeMetric(c.env, {
      indexes: ['demo_loop_blocked', 'demo', action, 'loop_detected'],
      doubles: [1, latencyMs],
    });

    // Real AI reasoning (Workers AI) with template fallback
    const reasoning = await generateReasoningWithAI(c.env, {
      decision: 'blocked_storm',
      action,
      actor_id: 'demo-user',
      pattern_count: loopData.count,
      window_seconds: 60,
      cost_saved_usd: 0.05,
      task_hash,
      step_hash,
    });

    // Log this decision — waitUntil guarantees the DO call completes
    const decisionId = crypto.randomUUID();
    c.executionCtx.waitUntil(
      stub.fetch(doUrl(`/workspaces/${demoWs}/log-decision`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: decisionId,
          timestamp: new Date().toISOString(),
          action,
          task_hash,
          step_hash,
          decision: 'blocked_storm',
          latency_ms: latencyMs,
          pattern_count: loopData.count,
          cost_saved_usd: 0.05,
          ai_reasoning: reasoning.ai_reasoning,
          zone: 'storm',
        }),
      }).catch((err) => console.error('log-decision failed:', err))
    );

    return c.json(
      {
        allowed: false,
        demo: true,
        decision_id: decisionId,
        error: 'loop_detected',
        reason: 'Too many identical requests. ProceedGate caught the storm!',
        pattern_count: loopData.count,
        zone: 'storm',
        cost_saved_usd: 0.05,
        message: '🚫 Blocked retry storm. You just saved $0.05',
        hint: 'Change task_hash/step_hash to vary the pattern, or wait 60 s.',
        ...reasoning,
      },
      429,
    );
  }

  // ─── GRAY ZONE: AI decides (count 6-10) for demo ──────────────────
  const loopData = (await loopCheckRes.json()) as { count: number; zone: string; timing?: { avg_interval_ms: number; interval_cv: number; requests_per_sec: number; window_elapsed_ms: number }; cost_window_usd?: number; backoff_detected?: boolean; similar_pattern_count?: number; fingerprint_hash?: string };

  if (loopData.zone === 'gray' && loopData.timing) {
    const { decision: grayDecision } = await cachedGrayZoneDecision(c.env, {
      action,
      actor_id: 'demo-user',
      count: loopData.count,
      max_count: 10,
      avg_interval_ms: loopData.timing.avg_interval_ms,
      interval_cv: loopData.timing.interval_cv,
      requests_per_sec: loopData.timing.requests_per_sec,
      window_elapsed_ms: loopData.timing.window_elapsed_ms,
      task_hash,
      step_hash,
      // Smart pattern signals
      cost_window_usd: loopData.cost_window_usd,
      backoff_detected: loopData.backoff_detected,
      similar_pattern_count: loopData.similar_pattern_count,
    });

    if (grayDecision.decision === 'block') {
      const latencyMs = Date.now() - startMs;

      writeMetric(c.env, {
        indexes: ['demo_gray_blocked', 'demo', action, 'ai_block'],
        doubles: [1, latencyMs],
      });

      const decisionId = crypto.randomUUID();
      c.executionCtx.waitUntil(
        stub.fetch(doUrl(`/workspaces/${demoWs}/log-decision`), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: decisionId,
            timestamp: new Date().toISOString(),
            action,
            task_hash,
            step_hash,
            decision: 'blocked_storm',
            latency_ms: latencyMs,
            pattern_count: loopData.count,
            cost_saved_usd: 0.03,
            ai_reasoning: grayDecision.reasoning,
            zone: 'gray',
            ai_decided: grayDecision.ai_decided,
          }),
        }).catch((err) => console.error('log-decision failed:', err))
      );

      return c.json(
        {
          allowed: false,
          demo: true,
          decision_id: decisionId,
          error: 'ai_blocked',
          reason: grayDecision.reasoning,
          pattern_count: loopData.count,
          zone: 'gray',
          ai_decided: grayDecision.ai_decided,
          ai_model: grayDecision.model,
          cost_saved_usd: 0.03,
          message: `🤖 AI blocked suspicious pattern (${loopData.count} requests in gray zone)`,
          hint: 'AI analyzed your timing patterns. Vary your request intervals to appear more human-like.',
          ai_reasoning: grayDecision.reasoning,
          confidence: grayDecision.confidence,
          model: grayDecision.model,
        },
        429,
      );
    }

    // Gray zone allowed — fall through to normal allowed response
    // but add gray zone metadata
  }

  const latencyMs = Date.now() - startMs;

  writeMetric(c.env, {
    indexes: ['demo_check_ok', 'demo', action, 'allowed'],
    doubles: [1, latencyMs],
  });

  // Real AI reasoning (Workers AI) with template fallback
  const allowReasoning = await generateReasoningWithAI(c.env, {
    decision: 'allowed',
    action,
    actor_id: 'demo-user',
  });

  // Log this decision — waitUntil guarantees the DO call completes
  const decisionId = crypto.randomUUID();
  c.executionCtx.waitUntil(
    stub.fetch(doUrl(`/workspaces/${demoWs}/log-decision`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: decisionId,
        timestamp: new Date().toISOString(),
        action,
        task_hash,
        step_hash,
        decision: 'allowed',
        latency_ms: latencyMs,
        ai_reasoning: allowReasoning.ai_reasoning,
      }),
    }).catch((err) => console.error('log-decision failed:', err))
  );

  return c.json(
    {
      allowed: true,
      demo: true,
      decision_id: decisionId,
      action,
      task_hash,
      step_hash,
      pattern_hash: patternHash,
      zone: loopData.zone,
      pattern_count: loopData.count,
      ...(loopData.timing ? { timing: loopData.timing } : {}),
      // Smart pattern signals
      ...(loopData.cost_window_usd !== undefined ? { cost_window_usd: loopData.cost_window_usd } : {}),
      ...(loopData.backoff_detected !== undefined ? { backoff_detected: loopData.backoff_detected } : {}),
      ...(loopData.similar_pattern_count !== undefined ? { similar_pattern_count: loopData.similar_pattern_count } : {}),
      ...(loopData.fingerprint_hash ? { fingerprint_hash: loopData.fingerprint_hash } : {}),
      message: loopData.zone === 'gray'
        ? `✅ AI allowed your request (${loopData.count} requests — gray zone, but timing looks human).`
        : '✅ Request allowed through the gate.',
      hint: loopData.zone === 'gray'
        ? `AI analyzed ${loopData.count} requests and decided they look legitimate. ${10 - loopData.count} more identical requests before hard block.`
        : 'Click rapidly (>10×) with the same task_hash to trigger storm detection.',
      ...allowReasoning,
    },
    200,
  );
});

// ============================================================================
// /v1/demo/stats - Real-time dashboard data (public, no auth)
// ============================================================================
// Returns aggregated stats from the demo workspace for the live dashboard.
// All data is REAL — sourced from Durable Object storage.
// ============================================================================

checkRoutes.get('/v1/demo/stats', async (c) => {
  const demoWs = 'demo-public';
  const stub = getBillingStub(c.env);

  // Fetch stats, decision log, and storm chart in parallel
  const [statsRes, logRes, stormRes] = await Promise.all([
    stub.fetch(doUrl(`/workspaces/${demoWs}/stats`)),
    stub.fetch(doUrl(`/workspaces/${demoWs}/decision-log?limit=50`)),
    stub.fetch(doUrl(`/workspaces/${demoWs}/storm-chart`)),
  ]);

  const stats = await statsRes.json() as Record<string, unknown>;
  const log = await logRes.json() as { decisions: unknown[]; total_count: number };
  const storm = await stormRes.json() as { buckets: unknown[] };

  return c.json({
    ok: true,
    total_decisions: log.total_count,
    storms_blocked: (stats as { blocked_requests?: number }).blocked_requests ?? 0,
    cost_saved_usd: (stats as { cost_saved_usd?: number }).cost_saved_usd ?? 0,
    blocked_by_reason: (stats as { blocked_by_reason?: Record<string, number> }).blocked_by_reason ?? {},
    last_blocked_at: (stats as { last_blocked_at?: string }).last_blocked_at ?? null,
    decisions: log.decisions,
    storm_chart: storm.buckets,
    data_source: 'real-time Durable Object storage',
  });
});

// ============================================================================
// /v1/check/simple - Simplified billing-only check endpoint
// ============================================================================
// This endpoint is for customers who only need credit-based billing
// without the full policy/friction system.
// Workspace is automatically derived from the API key.
// ============================================================================

import { z } from 'zod';

const simpleCheckSchema = z.object({
  user_id: z.string().min(1),
  action: z.string().optional().default('api_call'),
  cost: z.number().int().min(1).max(1000).optional().default(1),
  metadata: z.record(z.unknown()).optional(),
});

checkRoutes.post('/v1/check/simple', async (c) => {
  const startMs = Date.now();

  // 1. Extract and validate API key
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({
      ok: false,
      error: 'missing_authorization',
      hint: 'Include Authorization header: Authorization: Bearer pg_ws_...',
      docs: 'https://docs.proceedgate.dev/authentication',
    }, 401);
  }

  const apiKey = authHeader.slice(7).trim();
  if (!apiKey.startsWith(API_KEY_PREFIXES.WORKSPACE)) {
    return c.json({
      ok: false,
      error: 'invalid_api_key_format',
      hint: `API key should start with ${API_KEY_PREFIXES.WORKSPACE}`,
      docs: 'https://docs.proceedgate.dev/authentication',
    }, 401);
  }

  // 2. Parse body
  const body = await c.req.json().catch(() => null);
  const parsed = simpleCheckSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({
      ok: false,
      error: 'invalid_request',
      hint: 'Required: { "user_id": "your-user-id" }',
      issues: parsed.error.issues,
      docs: 'https://docs.proceedgate.dev/api/check-simple',
    }, 400);
  }

  // 3. Look up workspace from API key
  const apiKeyHash = await hashApiKey(apiKey);
  const stub = getBillingStub(c.env);

  const lookupRes = await stub.fetch(doUrl('/keys/lookup'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key_hash: apiKeyHash }),
  });

  if (!lookupRes.ok) {
    return c.json({
      ok: false,
      error: 'workspace_not_found',
      hint: 'The API key is not associated with any workspace.',
      docs: 'https://docs.proceedgate.dev/errors/workspace-not-found',
    }, 404);
  }

  const { workspace_id: workspaceId } = await lookupRes.json() as { workspace_id: string };

  // 4. Consume credits (use cost from request, default 1)
  const creditCost = parsed.data.cost || 1;
  const consumed = await consumeWorkspaceCredits(c.env, workspaceId, creditCost, {
    action: parsed.data.action || 'simple_check',
  });

  if (!consumed.ok) {
    logEvent({
      event: 'simple_check_fail',
      workspace_id: workspaceId,
      user_id: parsed.data.user_id,
      error: consumed.error,
    });

    writeMetric(c.env, {
      indexes: ['simple_check_fail', workspaceId, parsed.data.action, consumed.error],
      doubles: [1, Date.now() - startMs],
    });

    // Track blocked request for "cost saved" metric
    stub.fetch(doUrl(`/workspaces/${workspaceId}/block`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 
        reason: consumed.error || 'insufficient_credits',
        estimated_cost_usd: 0.01,
        action: parsed.data.action,
      }),
    }).catch(() => {}); // Fire and forget

    // Send budget.exceeded webhook if a budget limit was hit
    if (consumed.limitType) {
      const webhookRes = await stub.fetch(doUrl(`/workspaces/${workspaceId}/webhook`));
      if (webhookRes.ok) {
        const webhookConfig = await webhookRes.json() as { ok: boolean; webhook_url?: string; webhook_secret?: string };
        if (webhookConfig.ok && webhookConfig.webhook_url) {
          webhookBudgetExceeded(c.env, {
            webhookUrl: webhookConfig.webhook_url,
            webhookSecret: webhookConfig.webhook_secret,
            workspaceId,
            limitType: consumed.limitType as 'daily' | 'weekly' | 'monthly',
            limit: 0,
            usage: consumed.currentUsage ?? 0,
          }).catch(err => console.error('Budget exceeded webhook failed:', err));
        }
      }
    }

    return c.json({
      ok: false,
      allowed: false,
      error: 'insufficient_credits',
      workspace_id: workspaceId,
      credits_remaining: consumed.credits,
      cost_saved: '$0.01',
      cost_saved_usd: 0.01,
      message: '🚫 Blocked. You just saved $0.01 by not burning more credits.',
      upgrade: {
        message: 'You have run out of credits. Top up to continue.',
        quote_url: `/v1/billing/quote?workspace_id=${encodeURIComponent(workspaceId)}&credits=10000`,
        balance_url: `/v1/billing/balance?workspace_id=${encodeURIComponent(workspaceId)}`,
        docs: 'https://docs.proceedgate.dev/billing/top-up',
      },
    }, 402);
  }

  // 5. Trigger credits.low webhook if needed
  if (consumed.creditsLowNotify && consumed.maxCredits) {
    const webhookRes = await stub.fetch(doUrl(`/workspaces/${workspaceId}/webhook`));
    if (webhookRes.ok) {
      const webhookConfig = await webhookRes.json() as { ok: boolean; webhook_url?: string; webhook_secret?: string };
      if (webhookConfig.ok && webhookConfig.webhook_url) {
        webhookCreditsLow(c.env, {
          webhookUrl: webhookConfig.webhook_url,
          webhookSecret: webhookConfig.webhook_secret,
          workspaceId,
          creditsRemaining: consumed.credits,
          thresholdPercent: 20,
          maxCredits: consumed.maxCredits,
        }).catch(err => console.error('Credits low webhook failed:', err));
      }
    }
  }

  // 6. Log success
  logEvent({
    event: 'simple_check_ok',
    workspace_id: workspaceId,
    user_id: parsed.data.user_id,
    action: parsed.data.action,
    credits_remaining: consumed.credits,
  });

  writeMetric(c.env, {
    indexes: ['simple_check_ok', workspaceId, parsed.data.action, 'success'],
    doubles: [1, Date.now() - startMs],
  });

  // 7. Return success
  return c.json({
    ok: true,
    allowed: true,
    workspace_id: workspaceId,
    user_id: parsed.data.user_id,
    credits_remaining: consumed.credits,
    credits_used: creditCost,
  }, 200);
});

export { checkRoutes };
