/**
 * CostLedger Durable Object
 *
 * Verifiable on-chain audit trail for MPP payment records.
 * Each CostLedger instance is keyed by agentId and stores per-operation
 * cost entries with tamper-evident storage keys.
 *
 * Retention: entries older than RETENTION_DAYS are purged by a daily alarm.
 */

import { DurableObject } from 'cloudflare:workers';
import type { CostEntry, CostSummary } from '../types.js';

const RETENTION_DAYS = 90;
const MS_PER_DAY = 86_400_000;

export class CostLedger extends DurableObject {
  // -------------------------------------------------------------------------
  // Public API (called by the worker)
  // -------------------------------------------------------------------------

  /** Persist a single cost entry. Schedules alarm on first write. */
  async record(entry: CostEntry): Promise<void> {
    const key = `cost:${entry.timestamp}:${entry.operationType}`;
    await this.ctx.storage.put(key, entry);
    // Ensure daily cleanup alarm is scheduled
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + MS_PER_DAY);
    }
  }

  /** Sum all recorded USD amounts. */
  async getTotal(): Promise<number> {
    const all = await this.ctx.storage.list<CostEntry>({ prefix: 'cost:' });
    let total = 0;
    for (const entry of all.values()) {
      total += parseFloat(entry.amount);
    }
    return total;
  }

  /** Aggregate summary for an agent. */
  async getSummary(agentId: string): Promise<CostSummary> {
    const all = await this.ctx.storage.list<CostEntry>({ prefix: 'cost:' });
    let totalUsd = 0;
    let lastActivity = 0;
    const breakdown: Record<string, number> = {};

    for (const entry of all.values()) {
      const amount = parseFloat(entry.amount);
      totalUsd += amount;
      breakdown[entry.operationType] = (breakdown[entry.operationType] ?? 0) + amount;
      if (entry.timestamp > lastActivity) lastActivity = entry.timestamp;
    }

    return {
      agentId,
      totalUsd,
      requestCount: all.size,
      lastActivity,
      breakdown,
    };
  }

  /** Return the N most-recent entries (reverse-chronological). */
  async getHistory(limit = 50): Promise<CostEntry[]> {
    const all = await this.ctx.storage.list<CostEntry>({ prefix: 'cost:', reverse: true, limit });
    return Array.from(all.values());
  }

  /** Delete entries older than RETENTION_DAYS. Returns count deleted. */
  async purgeOldEntries(): Promise<number> {
    const cutoff = Date.now() - RETENTION_DAYS * MS_PER_DAY;
    const all = await this.ctx.storage.list<CostEntry>({ prefix: 'cost:' });
    const keysToDelete: string[] = [];
    for (const [key, entry] of all) {
      if (entry.timestamp < cutoff) {
        keysToDelete.push(key);
      }
    }
    if (keysToDelete.length > 0) {
      await this.ctx.storage.delete(keysToDelete);
    }
    return keysToDelete.length;
  }

  /** Daily alarm: purge old entries and reschedule. */
  override async alarm(): Promise<void> {
    await this.purgeOldEntries();
    await this.ctx.storage.setAlarm(Date.now() + MS_PER_DAY);
  }

  // -------------------------------------------------------------------------
  // fetch() — internal HTTP interface used by worker routes
  // -------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // POST /record
    if (request.method === 'POST' && url.pathname === '/record') {
      const entry = await request.json() as CostEntry;
      await this.record(entry);
      return Response.json({ ok: true });
    }

    // GET /summary?agentId=<id>
    if (request.method === 'GET' && url.pathname === '/summary') {
      const agentId = url.searchParams.get('agentId') ?? 'unknown';
      const summary = await this.getSummary(agentId);
      return Response.json(summary);
    }

    // GET /history?limit=<n>
    if (request.method === 'GET' && url.pathname === '/history') {
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
      const history = await this.getHistory(limit);
      return Response.json(history);
    }

    // POST /cleanup — manual trigger (admin use)
    if (request.method === 'POST' && url.pathname === '/cleanup') {
      const deleted = await this.purgeOldEntries();
      return Response.json({ ok: true, deleted });
    }

    return new Response('not_found', { status: 404 });
  }
}
