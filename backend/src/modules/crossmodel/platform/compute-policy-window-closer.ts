/**
 * compute_policy WINDOW CLOSER (audit 2026-09-26 — hazard H1, telemetry-readiness-1 /
 * telemetry-readiness-4 / tests-gaps-5).
 *
 * The purpose's PRIMARY label is `escalated`: the user tapped Dig deeper on the
 * answer within COMPUTE_POLICY_ESCALATION_WINDOW_MS (30 min). Until this job
 * existed NOTHING ever wrote the negative (`escalated:false, windowClosed:true`),
 * so every labelled compute_policy row was a tap — a decision could only ever
 * be judged WRONG (a tap is "wanted more"), and an act flip would have been
 * demoted after the first 30 taps whatever its true precision. The offline
 * ruler papered over it with the finalize `facts` row as a stand-in negative,
 * but that row is written BEFORE the late reconcile lands (actual null on every
 * heavy answer-first turn — "depth unknown").
 *
 * This worker cron (every WINDOW_CLOSER_INTERVAL_SEC) sweeps human assistant
 * rows whose `metadata.depth.decision` is older than the window and that
 * carry NO rung (no tap): it writes the window-closed negative ONCE per row
 * through the ONE writer (decision-outcome-labels labelComputePolicyOutcome)
 * with the facts UPGRADED by the pill (`factsFromDepthMetadata`: a late
 * 'checked' / 'updated' means the draft reached the answer) and stamps
 * `metadata.depth.windowClosedAt` so the row is never re-labelled.
 *
 * The actual on an UNTAPPED decision:
 *   - the plan ACTED (gate_act): silence means the act STOOD — actual = the
 *     depth the gate predicted (a correct simple_lookup skip that also made
 *     one web search would otherwise read 'ordinary' and be judged wrong —
 *     the derivation bias telemetry-readiness-1 names);
 *   - otherwise: the facts-derived depth (the same derivation the tap uses).
 *
 * Supervisor chats and machine-origin rows get the `machine` HARNESS-PROXY label
 * instead (backlog DOI-21, 2026-09-28 — machineLabelEligible / deriveMachineDepthProxy;
 * no chip ⇒ a tap is impossible ⇒ a window-closed "negative" there is not evidence,
 * but the run facts are); the same firing runs the revision_material harness pass
 * (backlog E10 — runRevisionMaterialHarnessOnce); guests have no persisted
 * row (their facts label is stamped guest:true at finalize and the ruler keeps
 * it out of the negative rule).
 *
 * Bounded: WINDOW_CLOSER_BATCH rows per pass, rows ≤ 3 days old.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { factsFromDepthMetadata, computeDecisionFromMetadata, revisionDecisionFromMetadata } from '../chat-agent/compute-policy-labels';
import { labelTurnPlan, turnPlanFromMetadata, turnPlanLabelsDisabled, TURN_PLAN_ESCALATION_WINDOW_MS } from '../chat-agent/turn-plan-labels';
import {
  COMPUTE_POLICY_ESCALATION_WINDOW_MS, COMPUTE_POLICY_MACHINE_LABEL, computePolicyMachineLabelMinRows,
  deriveMachineDepthProxy, labelComputePolicyOutcome, labelRevisionMaterialHarnessOutcome,
} from './decision-outcome-labels';

export const WINDOW_CLOSER_JOB_ID = 'compute-policy-window-closer';
export const WINDOW_CLOSER_INTERVAL_SEC = 600;
export const WINDOW_CLOSER_BATCH = 200;
/** Rows older than this are left alone (a closer that starts late never labels ancient history). */
export const WINDOW_CLOSER_MAX_AGE_MS = 3 * 24 * 60 * 60_000;

interface CandidateRow { id: string; chatId: string; metadata: unknown; createdAt: Date; isSupervisor: boolean; isProjectSupervisor: boolean }

const asRecord = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {});

/** The predicted depth choice the plan carried (the decision stash's `depth` answer). Pure. */
export function predictedDepthOf(metadata: unknown): string | null {
  const meta = asRecord(metadata);
  const a = asRecord(asRecord(asRecord(meta.depth).decision).answers).depth;
  return typeof a?.choice === 'string' && a.choice && a.choice !== 'unclear' ? a.choice : null;
}

/**
 * backlog DOI-21 (2026-09-28): the NON-HUMAN segment a candidate row belongs to —
 * 'supervisor' for a supervisor chat's row, 'machine' for a machine-origin row on
 * any other chat; null for a human turn. Pure.
 */
export function machineSegmentOf(metadata: unknown, chat: { isSupervisor?: boolean; isProjectSupervisor?: boolean }): 'supervisor' | 'machine' | null {
  if (chat.isSupervisor || chat.isProjectSupervisor) return 'supervisor';
  const meta = asRecord(metadata);
  if (meta.origin && meta.origin !== 'user') return 'machine';
  return null;
}

/** DOI-21: is this a machine-label candidate (pure)? A non-human row with a decision, no rung, not yet closed, not a harness row. */
export function machineLabelEligible(metadata: unknown, chat: { isSupervisor?: boolean; isProjectSupervisor?: boolean }): boolean {
  if (!machineSegmentOf(metadata, chat)) return false;
  const meta = asRecord(metadata);
  if (meta.kind === 'deeper_findings' || meta.kind === 'check_addendum' || meta.kind === 'council_addendum') return false;
  const depth = asRecord(meta.depth);
  if (!depth.decision || typeof depth.decision !== 'object') return false;
  if (depth.windowClosedAt) return false;
  if (Array.isArray(depth.escalations) && depth.escalations.length) return false;
  return true;
}

/** Whether a row is a closer candidate (pure): a human turn with a decision, no rung, not yet closed. */
export function windowCloserEligible(metadata: unknown, chat: { isSupervisor?: boolean; isProjectSupervisor?: boolean }): boolean {
  const meta = asRecord(metadata);
  if (chat.isSupervisor || chat.isProjectSupervisor) return false;
  if (meta.origin && meta.origin !== 'user') return false;
  if (meta.kind === 'deeper_findings' || meta.kind === 'check_addendum' || meta.kind === 'council_addendum') return false;
  const depth = asRecord(meta.depth);
  if (!depth.decision || typeof depth.decision !== 'object') return false;
  if (depth.windowClosedAt) return false;
  if (Array.isArray(depth.escalations) && depth.escalations.length) return false;
  return true;
}

/** ONE pass. Returns the ≤200-char summary line for cron_jobs.lastStatus. Never throws. */
export async function runComputePolicyWindowCloserOnce(opts: { now?: Date; batch?: number } = {}): Promise<string> {
  const summary = await runComputePolicyWindowCloserInner(opts);
  // Dynamic roster (2026-10-03): the turn_plan window-close pass rides the same firing AFTER the
  // compute_policy pass — its own query, own try/catch, own switch (TURN_PLAN_LABELS_DISABLED).
  // Never fails or gates the pass.
  const turnPlanSummary = await runTurnPlanWindowCloserOnce(opts).catch(() => '');
  return turnPlanSummary ? `${summary}; ${turnPlanSummary}` : summary;
}

async function runComputePolicyWindowCloserInner(opts: { now?: Date; batch?: number } = {}): Promise<string> {
  const now = opts.now ?? new Date();
  const batch = Math.max(1, Math.min(1000, Math.floor(opts.batch ?? WINDOW_CLOSER_BATCH)));
  const cutoff = new Date(now.getTime() - COMPUTE_POLICY_ESCALATION_WINDOW_MS);
  const floor = new Date(now.getTime() - WINDOW_CLOSER_MAX_AGE_MS);
  let rows: CandidateRow[] = [];
  try {
    rows = await prisma.$queryRaw<CandidateRow[]>`
      SELECT m."id", m."chatId", m."metadata", m."createdAt", c."isSupervisor", c."isProjectSupervisor"
      FROM "crossmodel_messages" m
      JOIN "crossmodel_chats" c ON c."id" = m."chatId"
      WHERE m."role" = 'assistant'
        AND m."createdAt" < ${cutoff}
        AND m."createdAt" > ${floor}
        AND m."metadata" -> 'depth' -> 'decision' IS NOT NULL
        AND m."metadata" -> 'depth' ->> 'windowClosedAt' IS NULL
      ORDER BY m."createdAt" ASC
      LIMIT ${batch}`;
  } catch (err: any) {
    logger.warn(`${WINDOW_CLOSER_JOB_ID}: candidate query failed — pass skipped: ${err?.message ?? err}`);
    return `query failed: ${String(err?.message ?? err).slice(0, 120)}`;
  }
  let closed = 0; let skipped = 0; let failed = 0; let machineLabelled = 0;
  // backlog DOI-21: the machine-label ramp — rows are excludeFromFit until this many exist (one count per pass).
  const machineMinRows = computePolicyMachineLabelMinRows();
  let machineRowsExisting: number | null = null;
  if (rows.some(r => machineLabelEligible(r.metadata, r))) {
    try {
      machineRowsExisting = await prisma.loopMetric.count({
        where: { kind: 'decision_gate', AND: [{ meta: { path: ['purpose'], equals: 'compute_policy' } }, { meta: { path: ['label'], equals: COMPUTE_POLICY_MACHINE_LABEL } }] },
      });
    } catch (err: any) {
      logger.warn(`${WINDOW_CLOSER_JOB_ID}: machine-label count failed (${err?.message ?? err}) — this pass's machine rows stay excluded from the fit`);
      machineRowsExisting = null;
    }
  }
  for (const row of rows) {
    try {
      const meta = asRecord(row.metadata);
      const depth = asRecord(meta.depth);
      const stampClosed = async (reason: string) => {
        await prisma.crossModelMessage.update({ where: { id: row.id }, data: { metadata: { ...meta, depth: { ...depth, windowClosedAt: now.toISOString(), windowClosedReason: reason } } as object } });
      };
      // backlog DOI-21: a supervisor / machine row gets the harness-proxy `machine` label instead of 'ineligible'.
      if (machineLabelEligible(row.metadata, row)) {
        const stash = computeDecisionFromMetadata(row.metadata);
        if (!stash) { await stampClosed('no_decision'); skipped += 1; continue; }
        const segment = machineSegmentOf(row.metadata, row) ?? 'machine';
        const facts = factsFromDepthMetadata(row.metadata);
        const checkState = typeof asRecord(meta.check).state === 'string' ? String(asRecord(meta.check).state) : undefined;
        const proxy = deriveMachineDepthProxy(facts, checkState);
        const ramp = machineRowsExisting === null || machineRowsExisting + machineLabelled < machineMinRows;
        labelComputePolicyOutcome(stash, {
          label: COMPUTE_POLICY_MACHINE_LABEL, source: 'window_close', facts, sessionId: row.chatId, segment,
          acted: asRecord(depth.plan).source === 'gate_act', actualOverride: proxy,
          ...(checkState ? { turn: { checkState } } : {}), ...(ramp ? { excludeFromFit: true } : {}),
        });
        await stampClosed('machine_labelled');
        machineLabelled += 1;
        continue;
      }
      if (!windowCloserEligible(row.metadata, row)) { await stampClosed('ineligible'); skipped += 1; continue; }
      const stash = computeDecisionFromMetadata(row.metadata);
      if (!stash) { await stampClosed('no_decision'); skipped += 1; continue; }
      const acted = asRecord(depth.plan).source === 'gate_act';
      const predicted = predictedDepthOf(row.metadata);
      labelComputePolicyOutcome(stash, {
        label: 'escalated', escalated: false, windowClosed: true, source: 'window_close',
        facts: factsFromDepthMetadata(row.metadata), acted, sessionId: row.chatId, segment: 'user',
        ...(acted && predicted ? { actualOverride: predicted } : {}),
      });
      await stampClosed('labelled');
      closed += 1;
    } catch (err: any) {
      failed += 1;
      logger.warn(`${WINDOW_CLOSER_JOB_ID}: row ${row.id.slice(0, 8)} failed: ${err?.message ?? err}`);
    }
  }
  // backlog E10: the revision_material harness pass rides the same firing (own query, own try/catch — never fails this pass).
  const revision = await runRevisionMaterialHarnessOnce({ now, batch });
  const summary = `closed ${closed}, skipped ${skipped}, failed ${failed} of ${rows.length} candidate(s) older than ${Math.round(COMPUTE_POLICY_ESCALATION_WINDOW_MS / 60_000)} min${machineLabelled ? `, machine-labelled ${machineLabelled}` : ''}${revision ? `; ${revision}` : ''}`;
  if (rows.length || machineLabelled || revision) logger.info(`${WINDOW_CLOSER_JOB_ID}: ${summary}`);
  return summary;
}

// ── backlog E10 (2026-09-28): the revision_material HARNESS-LABEL pass ───────
// Rows whose metadata.check.verdict carries the gate's decision stash and are
// older than the escalation window get ONE harness row (label 'harness') from
// the persisted verdict's `source` (decision-outcome-labels
// revisionMaterialHarnessActual) and are stamped
// metadata.check.verdict.harnessLabelledAt so they are never re-labelled. A
// human signal (thumbs / Dig deeper) writes its own 'human' row before or after
// this — the fit prefers it (OUTCOME_LABEL_FOR_FIT). Bounded like the closer.
interface RevisionCandidateRow { id: string; chatId: string; metadata: unknown; createdAt: Date }

/** ONE pass over revision_material rows. Returns a short summary ('' when there is nothing to do). Never throws. */
export async function runRevisionMaterialHarnessOnce(opts: { now?: Date; batch?: number } = {}): Promise<string> {
  const now = opts.now ?? new Date();
  const batch = Math.max(1, Math.min(1000, Math.floor(opts.batch ?? WINDOW_CLOSER_BATCH)));
  const cutoff = new Date(now.getTime() - COMPUTE_POLICY_ESCALATION_WINDOW_MS);
  const floor = new Date(now.getTime() - WINDOW_CLOSER_MAX_AGE_MS);
  let rows: RevisionCandidateRow[] = [];
  try {
    rows = await prisma.$queryRaw<RevisionCandidateRow[]>`
      SELECT m."id", m."chatId", m."metadata", m."createdAt"
      FROM "crossmodel_messages" m
      WHERE m."role" = 'assistant'
        AND m."createdAt" < ${cutoff}
        AND m."createdAt" > ${floor}
        AND m."metadata" -> 'check' -> 'verdict' -> 'decision' IS NOT NULL
        AND m."metadata" -> 'check' -> 'verdict' ->> 'harnessLabelledAt' IS NULL
      ORDER BY m."createdAt" ASC
      LIMIT ${batch}`;
  } catch (err: any) {
    logger.warn(`${WINDOW_CLOSER_JOB_ID}: revision_material candidate query failed — pass skipped: ${err?.message ?? err}`);
    return `revision query failed: ${String(err?.message ?? err).slice(0, 100)}`;
  }
  if (!rows.length) return '';
  let labelled = 0; let skipped = 0; let failed = 0;
  for (const row of rows) {
    try {
      const meta = asRecord(row.metadata);
      const check = asRecord(meta.check);
      const verdict = asRecord(check.verdict);
      // A row the closer query matched but that carries no revision_material stash (another purpose's decision) is left alone, unstamped.
      const rev = revisionDecisionFromMetadata(row.metadata);
      if (!rev) { skipped += 1; continue; }
      const changed = Array.isArray(verdict.changed) ? verdict.changed.length : undefined;
      const ok = labelRevisionMaterialHarnessOutcome(rev.stash, { source: verdict.source, material: verdict.material, changed, sessionId: row.chatId, note: `pill:${rev.state || '—'}` });
      await prisma.crossModelMessage.update({ where: { id: row.id }, data: { metadata: { ...meta, check: { ...check, verdict: { ...verdict, harnessLabelledAt: now.toISOString() } } } as object } });
      if (ok) labelled += 1; else skipped += 1;
    } catch (err: any) {
      failed += 1;
      logger.warn(`${WINDOW_CLOSER_JOB_ID}: revision row ${row.id.slice(0, 8)} failed: ${err?.message ?? err}`);
    }
  }
  return `revision_material harness-labelled ${labelled}, skipped ${skipped}, failed ${failed} of ${rows.length}`;
}

// ── Dynamic roster (2026-10-03): the turn_plan WINDOW-CLOSE pass ─────────────
// An answer whose metadata.depth.turnPlan carries a decision stash and that is
// older than the 30-min escalation window gets its PRIMARY turn_plan row: never
// tapped ⇒ the predicted lane held (label 'escalated', signal window_closed); a
// tapped answer was labelled at the tap, so it is only stamped. Each row is
// stamped depth.turnPlan.windowClosedAt so it is never labelled twice. Bounded
// like the closer (≤ 3 days back, ≤ batch rows per pass). Never throws.
interface TurnPlanCandidateRow { id: string; chatId: string; metadata: unknown; createdAt: Date }

export async function runTurnPlanWindowCloserOnce(opts: { now?: Date; batch?: number } = {}): Promise<string> {
  if (turnPlanLabelsDisabled()) return '';
  const now = opts.now ?? new Date();
  const batch = Math.max(1, Math.min(1000, Math.floor(opts.batch ?? WINDOW_CLOSER_BATCH)));
  const cutoff = new Date(now.getTime() - TURN_PLAN_ESCALATION_WINDOW_MS);
  const floor = new Date(now.getTime() - WINDOW_CLOSER_MAX_AGE_MS);
  let rows: TurnPlanCandidateRow[] = [];
  try {
    rows = await prisma.$queryRaw<TurnPlanCandidateRow[]>`
      SELECT m."id", m."chatId", m."metadata", m."createdAt"
      FROM "crossmodel_messages" m
      WHERE m."role" = 'assistant'
        AND m."createdAt" < ${cutoff}
        AND m."createdAt" > ${floor}
        AND m."metadata" -> 'depth' -> 'turnPlan' -> 'stash' IS NOT NULL
        AND m."metadata" -> 'depth' -> 'turnPlan' ->> 'windowClosedAt' IS NULL
      ORDER BY m."createdAt" ASC
      LIMIT ${batch}`;
  } catch (err: any) {
    logger.warn(`${WINDOW_CLOSER_JOB_ID}: turn_plan candidate query failed — pass skipped: ${err?.message ?? err}`);
    return '';
  }
  let labelled = 0; let tapped = 0; let failed = 0;
  for (const row of rows) {
    try {
      const meta = asRecord(row.metadata);
      const depth = asRecord(meta.depth);
      const tp = asRecord(depth.turnPlan);
      const wasTapped = Array.isArray(depth.escalations) && depth.escalations.length > 0;
      if (!wasTapped && turnPlanFromMetadata(row.metadata)) {
        if (labelTurnPlan(row.metadata, 'window_closed', { sessionId: row.chatId })) labelled += 1;
      } else if (wasTapped) {
        tapped += 1;
      }
      await prisma.crossModelMessage.update({ where: { id: row.id }, data: { metadata: { ...meta, depth: { ...depth, turnPlan: { ...tp, windowClosedAt: now.toISOString(), windowClosedReason: wasTapped ? 'tapped' : 'labelled' } } } as object } });
    } catch (err: any) {
      failed += 1;
      logger.warn(`${WINDOW_CLOSER_JOB_ID}: turn_plan row ${row.id.slice(0, 8)} failed: ${err?.message ?? err}`);
    }
  }
  return rows.length ? `turn_plan closed ${labelled}, tapped ${tapped}, failed ${failed} of ${rows.length}` : '';
}
