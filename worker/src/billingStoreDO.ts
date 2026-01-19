export type BillingQuoteRecord = {
  quoteId: string;
  workspaceId: string;
  credits: number;
  requiredPrice: string;
  chain: string;
  recipient: string;
  createdAtMs: number;
  expiresAtMs: number;
  redeemedAtMs?: number;
  txHash?: string;
};

type WorkspaceBalance = {
  workspaceId: string;
  credits: number;
  updatedAtMs: number;
};

type WorkspaceAuth = {
  workspaceId: string;
  apiKeyHash: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type BudgetConfig = {
  workspaceId: string;
  dailyLimit?: number;
  weeklyLimit?: number;
  monthlyLimit?: number;
  alertThreshold?: number; // 0-100 percentage
  webhookUrl?: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type UsageRecord = {
  workspaceId: string;
  date: string; // YYYY-MM-DD
  credits: number;
  actions: Record<string, number>; // action type -> count
  tools: Record<string, number>; // tool name -> count
};

type PutQuoteBody = { record: BillingQuoteRecord };

type ConsumeBody = { n: number; action?: string; tool?: string };

type RedeemBody = { tx_hash: string };

type SetKeyBody = { api_key_hash: string };
type VerifyKeyBody = { api_key_hash: string };

type SetBudgetBody = {
  daily_limit?: number;
  weekly_limit?: number;
  monthly_limit?: number;
  alert_threshold?: number;
  webhook_url?: string;
};

function normalizeHex0x(input: string): string {
  const s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  return s.startsWith('0x') ? s : `0x${s}`;
}

function normalizeKeyHash(input: string): string {
  const s = String(input || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) return '';
  return s;
}

export class BillingStoreDO {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  private async getQuote(quoteId: string): Promise<BillingQuoteRecord | null> {
    const record = (await this.state.storage.get<BillingQuoteRecord>(`quote:${quoteId}`)) ?? null;
    if (!record) return null;

    if (Date.now() >= record.expiresAtMs) {
      await this.state.storage.delete(`quote:${quoteId}`);
      return null;
    }

    return record;
  }

  private async getBalance(workspaceId: string): Promise<WorkspaceBalance> {
    const existing = (await this.state.storage.get<WorkspaceBalance>(`ws:${workspaceId}`)) ?? null;
    if (existing) return existing;

    const fresh: WorkspaceBalance = {
      workspaceId,
      credits: 0,
      updatedAtMs: Date.now(),
    };
    await this.state.storage.put(`ws:${workspaceId}`, fresh);
    return fresh;
  }

  private async putBalance(balance: WorkspaceBalance): Promise<void> {
    balance.updatedAtMs = Date.now();
    await this.state.storage.put(`ws:${balance.workspaceId}`, balance);
  }

  private async getAuth(workspaceId: string): Promise<WorkspaceAuth | null> {
    const auth = (await this.state.storage.get<WorkspaceAuth>(`auth:${workspaceId}`)) ?? null;
    return auth;
  }

  private async setAuth(workspaceId: string, apiKeyHash: string): Promise<void> {
    const nowMs = Date.now();
    const existing = await this.getAuth(workspaceId);
    const record: WorkspaceAuth = {
      workspaceId,
      apiKeyHash,
      createdAtMs: existing?.createdAtMs ?? nowMs,
      updatedAtMs: nowMs,
    };
    await this.state.storage.put(`auth:${workspaceId}`, record);
  }

  private async deleteAuth(workspaceId: string): Promise<void> {
    await this.state.storage.delete(`auth:${workspaceId}`);
  }

  // Budget management
  private async getBudget(workspaceId: string): Promise<BudgetConfig | null> {
    return (await this.state.storage.get<BudgetConfig>(`budget:${workspaceId}`)) ?? null;
  }

  private async setBudget(workspaceId: string, config: SetBudgetBody): Promise<BudgetConfig> {
    const existing = await this.getBudget(workspaceId);
    const nowMs = Date.now();
    
    const updated: BudgetConfig = {
      workspaceId,
      dailyLimit: config.daily_limit ?? existing?.dailyLimit,
      weeklyLimit: config.weekly_limit ?? existing?.weeklyLimit,
      monthlyLimit: config.monthly_limit ?? existing?.monthlyLimit,
      alertThreshold: config.alert_threshold ?? existing?.alertThreshold,
      webhookUrl: config.webhook_url ?? existing?.webhookUrl,
      createdAtMs: existing?.createdAtMs ?? nowMs,
      updatedAtMs: nowMs,
    };

    await this.state.storage.put(`budget:${workspaceId}`, updated);
    return updated;
  }

  // Usage tracking
  private getDateKey(): string {
    return new Date().toISOString().split('T')[0]!; // YYYY-MM-DD
  }

  private async getUsage(workspaceId: string, date: string): Promise<UsageRecord> {
    const key = `usage:${workspaceId}:${date}`;
    const existing = await this.state.storage.get<UsageRecord>(key);
    if (existing) return existing;

    return {
      workspaceId,
      date,
      credits: 0,
      actions: {},
      tools: {},
    };
  }

  private async recordUsage(workspaceId: string, n: number, action?: string, tool?: string): Promise<void> {
    const date = this.getDateKey();
    const usage = await this.getUsage(workspaceId, date);

    usage.credits += n;
    if (action) {
      usage.actions[action] = (usage.actions[action] ?? 0) + 1;
    }
    if (tool) {
      usage.tools[tool] = (usage.tools[tool] ?? 0) + 1;
    }

    await this.state.storage.put(`usage:${workspaceId}:${date}`, usage);
  }

  private async getUsageForPeriod(workspaceId: string, days: number): Promise<number> {
    let total = 0;
    const today = new Date();

    for (let i = 0; i < days; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateKey = date.toISOString().split('T')[0]!;
      const usage = await this.getUsage(workspaceId, dateKey);
      total += usage.credits;
    }

    return total;
  }

  private async checkBudgetLimits(workspaceId: string, toConsume: number): Promise<{ ok: boolean; error?: string; limit?: string; usage?: number }> {
    const budget = await this.getBudget(workspaceId);
    if (!budget) return { ok: true }; // No budget = no limits

    const today = this.getDateKey();
    const todayUsage = await this.getUsage(workspaceId, today);

    // Check daily limit
    if (budget.dailyLimit !== undefined) {
      if (todayUsage.credits + toConsume > budget.dailyLimit) {
        return { 
          ok: false, 
          error: 'daily_limit_exceeded',
          limit: 'daily',
          usage: todayUsage.credits,
        };
      }
    }

    // Check weekly limit
    if (budget.weeklyLimit !== undefined) {
      const weekUsage = await this.getUsageForPeriod(workspaceId, 7);
      if (weekUsage + toConsume > budget.weeklyLimit) {
        return { 
          ok: false, 
          error: 'weekly_limit_exceeded',
          limit: 'weekly',
          usage: weekUsage,
        };
      }
    }

    // Check monthly limit
    if (budget.monthlyLimit !== undefined) {
      const monthUsage = await this.getUsageForPeriod(workspaceId, 30);
      if (monthUsage + toConsume > budget.monthlyLimit) {
        return { 
          ok: false, 
          error: 'monthly_limit_exceeded',
          limit: 'monthly',
          usage: monthUsage,
        };
      }
    }

    return { ok: true };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    // Internal DO API:
    // - PUT  /quotes/:id { record }
    // - GET  /quotes/:id
    // - POST /quotes/:id/redeem { tx_hash }
    // - GET  /workspaces/:id
    // - POST /workspaces/:id/consume { n }
    // - PUT  /workspaces/:id/key { api_key_hash }
    // - DELETE /workspaces/:id/key
    // - POST /workspaces/:id/verify { api_key_hash }
    // - GET  /workspaces/:id/auth
    if (parts.length < 2) return new Response('not_found', { status: 404 });

    if (parts[0] === 'quotes') {
      const quoteId = parts[1]!;

      if (request.method === 'PUT' && parts.length === 2) {
        const body = (await request.json().catch(() => null)) as PutQuoteBody | null;
        if (!body?.record || body.record.quoteId !== quoteId) {
          return new Response('invalid_request', { status: 400 });
        }

        await this.state.storage.put(`quote:${quoteId}`, body.record);
        return new Response('ok', { status: 200 });
      }

      if (request.method === 'GET' && parts.length === 2) {
        const record = await this.getQuote(quoteId);
        if (!record) return new Response('not_found', { status: 404 });
        return Response.json({ record }, { status: 200 });
      }

      if (request.method === 'POST' && parts.length === 3 && parts[2] === 'redeem') {
        const body = (await request.json().catch(() => null)) as RedeemBody | null;
        const txHash = normalizeHex0x(body?.tx_hash || '');
        if (!txHash) return new Response('invalid_request', { status: 400 });

        const record = await this.getQuote(quoteId);
        if (!record) return new Response('not_found', { status: 404 });
        if (record.redeemedAtMs) return new Response('already_redeemed', { status: 409 });

        const existingTx = (await this.state.storage.get<string>(`tx:${txHash}`)) ?? '';
        if (existingTx) return new Response('tx_already_used', { status: 409 });

        // Mark quote redeemed + credit workspace.
        record.redeemedAtMs = Date.now();
        record.txHash = txHash;
        await this.state.storage.put(`quote:${quoteId}`, record);
        await this.state.storage.put(`tx:${txHash}`, quoteId);

        const bal = await this.getBalance(record.workspaceId);
        bal.credits = Math.max(0, bal.credits) + record.credits;
        await this.putBalance(bal);

        return Response.json({ ok: true, workspace_id: record.workspaceId, credits: bal.credits }, { status: 200 });
      }

      return new Response('method_not_allowed', { status: 405 });
    }

    if (parts[0] === 'workspaces') {
      const workspaceId = parts[1]!;

      if (request.method === 'GET' && parts.length === 2) {
        const bal = await this.getBalance(workspaceId);
        return Response.json({ workspace_id: workspaceId, credits: bal.credits }, { status: 200 });
      }

      if (request.method === 'GET' && parts.length === 3 && parts[2] === 'auth') {
        const auth = await this.getAuth(workspaceId);
        if (!auth) return new Response('not_found', { status: 404 });
        return Response.json(
          {
            workspace_id: workspaceId,
            has_key: true,
            created_at: new Date(auth.createdAtMs).toISOString(),
            updated_at: new Date(auth.updatedAtMs).toISOString(),
          },
          { status: 200 },
        );
      }

      if (request.method === 'POST' && parts.length === 3 && parts[2] === 'consume') {
        const body = (await request.json().catch(() => null)) as ConsumeBody | null;
        const n = Number(body?.n);
        if (!Number.isFinite(n) || n <= 0) return new Response('invalid_request', { status: 400 });

        // Check budget limits first
        const budgetCheck = await this.checkBudgetLimits(workspaceId, n);
        if (!budgetCheck.ok) {
          return Response.json({
            ok: false,
            error: budgetCheck.error,
            limit_type: budgetCheck.limit,
            current_usage: budgetCheck.usage,
          }, { status: 402 });
        }

        const bal = await this.getBalance(workspaceId);
        if (bal.credits < n) {
          return Response.json({ ok: false, error: 'insufficient_credits', credits: bal.credits }, { status: 402 });
        }

        bal.credits -= n;
        await this.putBalance(bal);
        
        // Record usage
        await this.recordUsage(workspaceId, n, body?.action, body?.tool);

        return Response.json({ ok: true, credits: bal.credits }, { status: 200 });
      }

      if (request.method === 'PUT' && parts.length === 3 && parts[2] === 'key') {
        const body = (await request.json().catch(() => null)) as SetKeyBody | null;
        const h = normalizeKeyHash(body?.api_key_hash || '');
        if (!h) return new Response('invalid_request', { status: 400 });

        await this.setAuth(workspaceId, h);
        return new Response('ok', { status: 200 });
      }

      if (request.method === 'DELETE' && parts.length === 3 && parts[2] === 'key') {
        await this.deleteAuth(workspaceId);
        return new Response('ok', { status: 200 });
      }

      if (request.method === 'POST' && parts.length === 3 && parts[2] === 'verify') {
        const body = (await request.json().catch(() => null)) as VerifyKeyBody | null;
        const h = normalizeKeyHash(body?.api_key_hash || '');
        if (!h) return new Response('invalid_request', { status: 400 });

        const auth = await this.getAuth(workspaceId);
        if (!auth) return new Response('not_found', { status: 404 });

        if (auth.apiKeyHash !== h) {
          return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
        }

        return Response.json({ ok: true }, { status: 200 });
      }

      // Budget management
      if (request.method === 'GET' && parts.length === 3 && parts[2] === 'budget') {
        const budget = await this.getBudget(workspaceId);
        if (!budget) {
          return Response.json({ 
            workspace_id: workspaceId, 
            has_budget: false,
            message: 'No budget configured'
          }, { status: 200 });
        }
        return Response.json({
          workspace_id: workspaceId,
          has_budget: true,
          daily_limit: budget.dailyLimit,
          weekly_limit: budget.weeklyLimit,
          monthly_limit: budget.monthlyLimit,
          alert_threshold: budget.alertThreshold,
          webhook_url: budget.webhookUrl ? '***configured***' : undefined,
          created_at: new Date(budget.createdAtMs).toISOString(),
          updated_at: new Date(budget.updatedAtMs).toISOString(),
        }, { status: 200 });
      }

      if (request.method === 'PUT' && parts.length === 3 && parts[2] === 'budget') {
        const body = (await request.json().catch(() => null)) as SetBudgetBody | null;
        if (!body) return new Response('invalid_request', { status: 400 });

        const budget = await this.setBudget(workspaceId, body);
        return Response.json({
          workspace_id: workspaceId,
          daily_limit: budget.dailyLimit,
          weekly_limit: budget.weeklyLimit,
          monthly_limit: budget.monthlyLimit,
          alert_threshold: budget.alertThreshold,
          updated_at: new Date(budget.updatedAtMs).toISOString(),
        }, { status: 200 });
      }

      if (request.method === 'DELETE' && parts.length === 3 && parts[2] === 'budget') {
        await this.state.storage.delete(`budget:${workspaceId}`);
        return Response.json({ ok: true }, { status: 200 });
      }

      // Usage reporting
      if (request.method === 'GET' && parts.length === 3 && parts[2] === 'usage') {
        const period = new URL(request.url).searchParams.get('period') || 'today';
        
        let days: number;
        switch (period) {
          case 'today': days = 1; break;
          case 'week': days = 7; break;
          case 'month': days = 30; break;
          case 'all': days = 365; break;
          default: days = 1;
        }

        const today = new Date();
        const usageByDay: Array<{ date: string; credits: number; actions: Record<string, number>; tools: Record<string, number> }> = [];
        let totalCredits = 0;
        const totalActions: Record<string, number> = {};
        const totalTools: Record<string, number> = {};

        for (let i = 0; i < days; i++) {
          const date = new Date(today);
          date.setDate(date.getDate() - i);
          const dateKey = date.toISOString().split('T')[0]!;
          const usage = await this.getUsage(workspaceId, dateKey);
          
          usageByDay.push({
            date: dateKey,
            credits: usage.credits,
            actions: usage.actions,
            tools: usage.tools,
          });

          totalCredits += usage.credits;
          for (const [action, count] of Object.entries(usage.actions)) {
            totalActions[action] = (totalActions[action] ?? 0) + count;
          }
          for (const [tool, count] of Object.entries(usage.tools)) {
            totalTools[tool] = (totalTools[tool] ?? 0) + count;
          }
        }

        return Response.json({
          workspace_id: workspaceId,
          period,
          start_date: usageByDay[usageByDay.length - 1]?.date,
          end_date: usageByDay[0]?.date,
          total_credits_used: totalCredits,
          total_cost_usd: totalCredits * 0.00001, // 1 credit = $0.00001
          breakdown: {
            by_action: totalActions,
            by_tool: totalTools,
            by_day: usageByDay.reverse(),
          },
        }, { status: 200 });
      }

      return new Response('method_not_allowed', { status: 405 });
    }

    return new Response('not_found', { status: 404 });
  }
}
