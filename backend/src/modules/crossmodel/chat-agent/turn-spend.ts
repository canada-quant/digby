/**
 * Per-TURN spend ledger for chat runs (WI-D, 2026-09-25).
 *
 * THE GAP: run_spend / run_tokens rows were written only by a TOP-LEVEL agent
 * loop (coding/agent.ts finalize, `topLevel = allowSubagents`). The Level 2
 * Double Checker, the Level 3 council colleagues and the one-shot reconcile
 * pass all run through runChatWorker (allowSubagents:false) — so their
 * tokens/USD were never metered: prod showed 0 deepseek-flash run_tokens rows
 * under profile=chat and every user chat run_spend row naming exactly ONE
 * model. get_spend, the spend caps and the fleet cost views under-reported
 * every Level 2/3 turn by the whole checker's cost.
 *
 * THE FIX: ONE shared UsageAccumulator per turn (cost.ts shareAcrossRuns) rides
 * every loop of the turn — lead (and its empty/seat-fallback/leak retries),
 * checker, colleagues, reconcile. Each loop holds the ledger for its lifetime
 * (runCodingAgent / runChatWorker retain → release), the turn holds one
 * reference until close(), and the settle callback writes the turn's SINGLE
 * run_spend row (meta.models = every seat that spent, meta.seats labels them:
 * 'lead' / 'cross_checker' / 'reconcile' — the reconcile pass is the LEAD model
 * in the checker worker shape and is metered under its own seat via
 * AgentRunInput.usageRole, seat-label fix 2026-09-25) plus per-model run_tokens rows. A checker that outlives the lead, or a lead
 * retry after the first loop finished, can neither be dropped nor
 * double-counted: nothing is written until the last hold drops.
 */
import { UsageAccumulator } from '../coding/cost';
import { recordRunSpend, MetricStamp } from '../platform/loop-metrics.service';
import logger from '../../../utils/logger';

export interface TurnUsageLedgerOptions {
  /** the chat id (or the anon-… sentinel) — run_spend.sessionId */
  sessionId: string;
  /** Read at SETTLE time (the run stamp is built after the vision upgrade, later than the ledger). */
  stamp: () => MetricStamp | undefined;
  /**
   * Audit 2026-10-06 T6-4: the turn's minted telemetry run id — the run_spend row then joins the turn's
   * compaction / tool-error / loop rows on loop_metrics.runId. Absent ⇒ the accumulator's own random id (as before).
   */
  runId?: string;
}

/**
 * The turn's shared ledger. Settle writes ONE recordRunSpend for the whole turn — skipped when nothing was
 * recorded (a turn that failed before any model call must not mint a $0 row
 * the way a finalized run does; the pre-WI-D path wrote nothing there either).
 */
export function createTurnUsageLedger(opts: TurnUsageLedgerOptions): UsageAccumulator {
  return new UsageAccumulator(opts.runId || undefined).shareAcrossRuns((acc) => {
    const snap = acc.snapshot();
    if (!snap.agents.length) return;
    const stamp = opts.stamp() ?? { profile: 'chat' };
    recordRunSpend(acc.runId, opts.sessionId, snap, stamp);
    logger.debug(`chat-agent: turn spend settled — ${snap.agents.map(a => `${a.role ?? 'lead'}:${a.model}`).join(', ')} $${snap.totalCostUsd.toFixed(4)} (${snap.turns} model turns)`, { source: 'chat-agent' });
  });
}
