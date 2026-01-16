import { Command } from 'commander';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stdin as input, stdout as output } from 'node:process';
import * as readline from 'node:readline/promises';

import type { GovernorCheckRequest, TaskFile } from './types.js';
import { canonicalJsonStringify } from './canonicalJson.js';
import { governorCheck, governorRedeem } from './governorClient.js';
import { verifyProceedToken } from './jwks.js';

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function sha256Prefixed(canonicalJson: string): string {
  return `sha256:${sha256Hex(canonicalJson)}`;
}

async function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    const ans = await rl.question(question);
    return String(ans ?? '').trim();
  } finally {
    rl.close();
  }
}

function normalizeBaseUrl(raw: string): string {
  const u = new URL(raw);
  return u.origin;
}

async function runTask(params: { taskPath: string; governor: string; mode: 'fail-open' | 'fail-closed'; txHash?: string }) {
  const governor = normalizeBaseUrl(params.governor);
  const taskRaw = await readFile(params.taskPath, 'utf-8');
  const task = JSON.parse(taskRaw) as TaskFile;

  const actorId = task.actor_id ?? `agent:${randomUUID()}`;
  const project = task.project ?? 'demo';

  console.log(`actor=${actorId}`);
  console.log(`project=${project}`);
  console.log(`governor=${governor}`);

  const taskHash = sha256Prefixed(canonicalJsonStringify(task));

  let frictionPaid = 0;
  let frictionEvents = 0;

  for (let i = 0; i < task.steps.length; i++) {
    const step = task.steps[i]!;
    const stepHash = sha256Prefixed(canonicalJsonStringify(step));

    const attempts = step.attempts ?? 1;
    const windowSeconds = step.window_seconds ?? 30;

    for (let a = 1; a <= attempts; a++) {
      const baseContext: GovernorCheckRequest['context'] = {
        attempt_in_window: a,
        window_seconds: windowSeconds,
        confidence: step.confidence,
        tool: step.tool,
        task_hash: taskHash,
        step_hash: stepHash,
      };

      const contextHash = sha256Prefixed(canonicalJsonStringify(baseContext));

      const req: GovernorCheckRequest = {
        policy_id: step.policy_id,
        action: step.action,
        actor: { id: actorId, project },
        context: {
          ...baseContext,
          context_hash: contextHash,
        },
        idempotency_key: `step:${i}:attempt:${a}`,
      };

      let res;
      try {
        res = await governorCheck(governor, req);
      } catch (e: any) {
        if (params.mode === 'fail-open') {
          console.warn(`governor unavailable; fail-open; continuing. err=${String(e?.message ?? e)}`);
          continue;
        }
        throw e;
      }

      if (res.kind === 'ok') {
        await verifyProceedToken(res.value.proceed_token, {
          issuer: governor,
          actorId,
          decisionId: res.value.decision_id,
          taskHash,
          stepHash,
          ctxHash: contextHash,
        });

        console.log(`[OK] step=${step.name} attempt=${a} token=valid`);
        continue;
      }

      // 402 flow
      frictionEvents++;
      console.log(`[402] step=${step.name} attempt=${a} reason=${res.value.reason_code}`);
      console.log(`  x402-price: ${res.x402.price}`);
      console.log(`  x402-recipient: ${res.x402.recipient}`);
      console.log(`  x402-chain: ${res.x402.chain}`);

      const tx = params.txHash ?? (await promptLine('Paste x402 tx hash (or empty to abort): '));
      if (!tx) throw new Error('aborted by user (no tx hash)');

      const redeemed = await governorRedeem(governor, res.value.decision_id, tx);

      await verifyProceedToken(redeemed.proceed_token, {
        issuer: governor,
        actorId,
        decisionId: redeemed.decision_id,
        taskHash,
        stepHash,
        ctxHash: contextHash,
      });

      console.log(`[REDEEMED] decision=${redeemed.decision_id} token=valid tx=${tx}`);

      // Best-effort parse paid amount numeric (for demo stats only)
      const m = String(res.x402.price).match(/([0-9]+(?:\.[0-9]+)?)/);
      if (m?.[1]) frictionPaid += Number(m[1]) || 0;
    }
  }

  console.log('---');
  console.log(`friction_events=${frictionEvents}`);
  console.log(`friction_paid_usdc~=${frictionPaid.toFixed(6)}`);
}

const program = new Command();

program
  .name('agent-runner')
  .description('Standalone runner that enforces Agent Cost Governor decisions.')
  .version('0.1.0');

program
  .command('run')
  .argument('<task.json>', 'task file')
  .requiredOption('--governor <url>', 'Governor base URL')
  .option('--mode <mode>', 'fail-open or fail-closed', 'fail-closed')
  .option('--tx-hash <hash>', 'Non-interactive x402 tx hash (MVP/stub)', '')
  .action(async (taskPath: string, opts: any) => {
    const mode = String(opts.mode || 'fail-closed') === 'fail-open' ? 'fail-open' : 'fail-closed';
    const txHash = String(opts.txHash || '').trim();
    await runTask({ taskPath, governor: String(opts.governor), mode, txHash: txHash || undefined });
  });

await program.parseAsync(process.argv);
