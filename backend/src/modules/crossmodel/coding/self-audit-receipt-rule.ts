/**
 * Self-audit churn containment (tt-rd audit 2026-09-27, findings
 * self-audit-churn-1/2/6) — the DETERMINISTIC half of the coding loop's
 * pre-finish self-audit decision. Dependency-light leaf: pure functions over
 * {plan, receipts, verify state} plus env readers; the ONLY side-effecting
 * export (receiptRuleAutoDemoted) reads a store flag through a dynamic import
 * and fails open to "not demoted".
 *
 * WHY (verified in the audit, 14 d of prod rows):
 *   - the harness audit round fired on ~100 % of eligible finishes and found
 *     nothing 95 % of the time (fleet 4,857 rounds on 7,009 coding runs;
 *     unevidenced actual=true 20 / false 396); the only skip mechanism was
 *     the Jev `self_audit` purpose — shadow and anti-predictive (AUROC 0.232);
 *   - lanes on a recurring cadence ended their OWN plan with a "Self-audit …"
 *     step, then took the harness round on top (ddd26be0: 224 audits / 244
 *     runs) because the cross-run dedupe signature embedded the step TEXT,
 *     which carried firing / window ids that changed every tick;
 *   - the 2026-09-27 backtest measured the deterministic rule "every
 *     completed step under review is receipt-joined ∧ the last verify passed"
 *     at 54.1 % coverage with 2.4 % reopen [1.0, 5.6] against a ~1.8 % base —
 *     it lived only in scripts/framework-audit/backtest-agent-decisions.js.
 *
 * WHAT (all kill-switched, all fail-open to the audit FIRING):
 *   1. DUPLICATE-STEP skip — the lane's own completed self-audit / re-verify
 *      step + ≥1 ok evidence-bearing receipt this run ⇒ the audit already
 *      happened; the harness round is a second pass (unconditional).
 *   2. TEXT-INSENSITIVE dedupe signature — goal + acceptance criteria +
 *      id:status per step (never step text), so a firing-number edit does not
 *      re-arm.
 *   3. RECEIPT RULE — the backtest's ECT step 0, ported verbatim (receiptJoin /
 *      stepNouns / KIND_RULES). Mode SELF_AUDIT_RECEIPT_RULE_MODE=shadow|act
 *      (default shadow — every decision is recorded, nothing skipped).
 *      In act, a 1-in-10
 *      CONTROL sample (runId hex tail) still runs the round with control:true
 *      so the reopen rate keeps being labelled; a store flag written by the
 *      demotion evaluator (evaluateReceiptRuleDemotion — control reopen rate
 *      above base + 2 pt over ≥ 30 control rows) forces act → shadow.
 *
 * Fixer 2026-09-27 (review of the first cut):
 *   - finding 3: a BLOCKED step is the audit round's other job ("re-confirm
 *     each BLOCKED step's blocker is still real"), so the rule never skips a
 *     blocked-plan board — reason `blocked_steps`, `blockedSteps` on the verdict.
 *   - finding 4: the verify-TREE comparison needs a real git capture; the
 *     caller (agent.ts) takes it ONLY in act and ONLY once every cheaper term
 *     passes, through verify-state.ts captureWorktreeTree (no environmental-red
 *     pickup); in act an UNKNOWN tree never skips (`requireTreeMatch` →
 *     `verify_tree_unknown`), in shadow it is simply not compared
 *     (`treeCompared:false` on the verdict / row).
 *   - finding 5: every evaluated round that RUNS (shadow, or act with a
 *     non-skip verdict) gets a harness outcome label — loop_metrics
 *     `self_audit_shadow {wouldSkip, reopened, …}` — and
 *     evaluateReceiptRulePromotion / checkReceiptRulePromotion turn those rows
 *     into the promotion readout (store key `readiness`); control rows stay
 *     the act-period demotion bar. The flip itself remains the env.
 */

import type { ToolReceipt } from './run-receipts';
import { isEvidenceToolName } from './evidence-tools';

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

// ── Switches ────────────────────────────────────────────────────────────────

export type ReceiptRuleMode = 'shadow' | 'act';

/** SELF_AUDIT_RECEIPT_RULE_MODE=shadow|act (default shadow). Invalid values read as shadow. */
export function selfAuditReceiptRuleEnvMode(): ReceiptRuleMode {
  const s = String(process.env.SELF_AUDIT_RECEIPT_RULE_MODE ?? '').trim().toLowerCase();
  return s === 'act' ? 'act' : 'shadow';
}

// ── Dedupe signature ────────────────────────────────────────────────────────

type PlanLike = {
  goal?: string | null;
  acceptanceCriteria?: string[] | null;
  steps: ReadonlyArray<{ id: string | number; status: string; text?: string | null }>;
};

/**
 * The cross-run self-audit dedupe signature. Text-insensitive by default:
 * goal + acceptance criteria + `id:status` per step. A lane that re-titles its
 * steps every firing ("Self-audit F186 …" → "F187") keeps the same signature;
 * a status change, a new/removed step, a new goal or new criteria re-arm.
 */
export function selfAuditPlanSig(plan: PlanLike): string {
  const head = `g=${String(plan.goal ?? '').trim()}|ac=${(plan.acceptanceCriteria ?? []).map(c => String(c).trim()).join('␟')}`;
  return `${head}|${plan.steps.map(s => `${s.id}:${s.status}`).join('|')}`;
}

// ── Duplicate lane-authored audit step ──────────────────────────────────────

/** A plan step whose TEXT says it is an audit / re-verification pass (the lane's own "SA2"). */
export const SELF_AUDIT_STEP_RE = /\bself[ -]?audit|\bre-?(?:probe|verif(?:y|ied|ication))|\baudit pass\b|\bSA[23]\b/i;

export interface DuplicateStepVerdict {
  /** The harness round would be a SECOND audit this firing. */
  duplicate: boolean;
  /** The completed lane-authored audit step (last one in plan order), if any. */
  stepId: string | null;
  /** ok evidence-bearing receipts this run (the lane's audit pass left evidence). */
  evidenceReceipts: number;
}

/**
 * Did the lane already audit itself this run? True when a COMPLETED plan step
 * reads as a self-audit / re-verify step AND this run minted ≥ 1 ok
 * evidence-bearing receipt (isEvidenceToolName — update_plan / search_memory
 * / ask_user prove nothing). A receipt-less "audit" step is narration, not an
 * audit, and does NOT skip the round. Pure.
 */
export function laneAuditedThisRun(plan: PlanLike | null | undefined, receipts: ReadonlyArray<ToolReceipt> | null | undefined): DuplicateStepVerdict {
  const steps = plan?.steps ?? [];
  let stepId: string | null = null;
  for (const s of steps) {
    if (s.status === 'completed' && SELF_AUDIT_STEP_RE.test(String(s.text ?? ''))) stepId = String(s.id);
  }
  const evidenceReceipts = (receipts ?? []).filter(r => r && r.ok && isEvidenceToolName(r.tool)).length;
  return { duplicate: stepId !== null && evidenceReceipts > 0, stepId, evidenceReceipts };
}

// ── Receipt rule (the backtest's ECT step 0, ported) ────────────────────────

const STOP = new Set(['the', 'and', 'with', 'from', 'that', 'this', 'into', 'then', 'for', 'over', 'each', 'when', 'after', 'before', 'file', 'files', 'step', 'steps', 'run', 'runs', 'test', 'tests', 'code', 'verify', 'commit', 'push', 'branch', 'open', 'merge', 'update', 'create', 'add', 'read', 'write', 'check', 'confirm', 'ensure', 'make', 'sure', 'goal', 'plan', 'done', 'complete', 'completed', 'work', 'via', 'using', 'todo', 'lane', 'session', 'chat', 'report', 'note', 'also', 'only', 'same', 'all', 'any']);

/** Nouns a step names: paths, PR numbers, shas, dotted/underscored identifiers, long words. Pure. */
export function stepNouns(text: string): string[] {
  const s = String(text || '');
  const out = new Set<string>();
  for (const m of s.matchAll(/[\w./-]+\.[A-Za-z0-9]{1,6}\b/g)) out.add(m[0].toLowerCase());
  for (const m of s.matchAll(/#(\d{1,6})\b/g)) out.add(`#${m[1]}`);
  for (const m of s.matchAll(/\b[0-9a-f]{7,40}\b/g)) out.add(m[0].toLowerCase());
  for (const m of s.matchAll(/\b[A-Za-z][\w-]*[_-][\w-]+\b/g)) out.add(m[0].toLowerCase());
  for (const m of s.matchAll(/\b[A-Za-z]{5,}\b/g)) { const w = m[0].toLowerCase(); if (!STOP.has(w)) out.add(w); }
  return [...out];
}

const KIND_RULES: Array<[RegExp, string[]]> = [
  [/\b(commit|committed)\b/i, ['git_commit', 'run_command']],
  [/\b(push|pushed)\b/i, ['git_push', 'run_command']],
  [/\b(pull request|PR\b|open(?:ed)? a PR|merge)/i, ['open_pull_request', 'run_command']],
  [/\b(verify|verified|verification|tests? pass)/i, ['verify', 'run_command']],
  [/\b(send|sent|message|notify|report(?:ed)? up)\b/i, ['send_chat_message', 'notify_user']],
  [/\b(schedul|re-?arm|cadence)/i, ['schedule_message', 'update_schedule']],
  [/\b(ticket|feedback)\b/i, ['file_feedback', 'update_feedback']],
];

export interface StepReceiptJoin { id: string; receipted: boolean; receiptIds: string[] }

/**
 * Deterministic step → receipt pre-join: a completed step is RECEIPTED when an
 * ok:true receipt's tool matches the step's action kind (run_command excluded
 * — too generic), or the receipt's args / result heads / ids mention one of
 * the step's nouns (≥ 4 chars). Byte-for-byte the backtest's receiptJoin. Pure.
 */
export function receiptJoin(
  steps: ReadonlyArray<{ id: string | number; text?: string | null }>,
  receipts: ReadonlyArray<ToolReceipt> | null | undefined,
): StepReceiptJoin[] {
  const okReceipts = (receipts ?? []).filter(r => r && r.ok);
  const texts = okReceipts.map(r => `${r.tool} ${r.argsHead || ''} ${r.resultHead || ''} ${JSON.stringify(r.ids || {})}`.toLowerCase());
  return steps.map(s => {
    const nouns = stepNouns(String(s.text ?? '')).filter(n => n.length >= 4);
    const kinds = KIND_RULES.filter(([re]) => re.test(String(s.text ?? ''))).flatMap(([, tools]) => tools);
    const matched: string[] = [];
    okReceipts.forEach((r, i) => {
      const byNoun = nouns.some(n => texts[i].includes(n));
      const byKind = kinds.includes(r.tool) && r.tool !== 'run_command';
      if (byNoun || byKind) matched.push(String(r.id || '').slice(0, 8));
    });
    return { id: String(s.id), receipted: matched.length > 0, receiptIds: matched.slice(0, 6) };
  });
}

export interface ReceiptRuleInput {
  plan: PlanLike | null | undefined;
  receipts: ReadonlyArray<ToolReceipt> | null | undefined;
  /** The session's last recorded verify (null = none recorded — counts as OK, exactly like the backtest). */
  lastVerify: { passed: boolean; unverified?: boolean; environmental?: boolean; tree?: string | null } | null | undefined;
  /** The CURRENT worktree tree hash when one could be captured (null = unknown → a recorded tree is not compared
   *  unless `requireTreeMatch`). */
  currentTree?: string | null;
  /** Fixer 2026-09-27 (finding 4): true in ACT — a recorded verify tree with an UNKNOWN current tree is a
   *  non-skip (`verify_tree_unknown`); false / absent (shadow) leaves it uncompared. */
  requireTreeMatch?: boolean;
  /** Evidence-guard reject-back rounds this run — any means the loop already caught an unbacked claim. */
  guardRejectBacks: number;
}

export interface ReceiptRuleVerdict {
  /** The deterministic rule says the round is skippable. */
  skip: boolean;
  /** Completed steps reviewed (all of them — no cap, the rule is cheap). */
  steps: number;
  /** Blocked steps on the board (fixer 2026-09-27, finding 3: any ⇒ never skip). */
  blockedSteps: number;
  /** How many of them joined an ok receipt. */
  receipted: number;
  unreceiptedStepIds: string[];
  verifyOk: boolean;
  /** True when a recorded verify tree was compared against a KNOWN current tree (fixer 2026-09-27, finding 4). */
  treeCompared: boolean;
  /** Why it did not skip (empty when skip). */
  reasons: string[];
}

/**
 * The receipt rule: EVERY completed step joins an ok receipt (receiptJoin) ∧
 * the last verify, if any, PASSED (not hollow, not environmental, and its
 * recorded tree — when both sides are known — equals the current worktree
 * tree) ∧ no evidence-guard reject-back this run ∧ at least one completed
 * step ∧ NO blocked step (fixer 2026-09-27, finding 3 — the blocker re-probe
 * is the round's other job). Pure; never throws.
 */
export function receiptRuleWouldSkip(input: ReceiptRuleInput): ReceiptRuleVerdict {
  const reasons: string[] = [];
  const steps = input.plan?.steps ?? [];
  const completed = steps.filter(s => s.status === 'completed');
  const blockedSteps = steps.filter(s => s.status === 'blocked').length;
  const join = receiptJoin(completed, input.receipts);
  const unreceipted = join.filter(j => !j.receipted).map(j => j.id);
  if (!completed.length) reasons.push('no_completed_steps');
  if (unreceipted.length) reasons.push('unreceipted_steps');
  if (blockedSteps > 0) reasons.push('blocked_steps');
  const lv = input.lastVerify;
  let verifyOk = true;
  let treeCompared = false;
  if (lv) {
    if (!lv.passed) { verifyOk = false; reasons.push('last_verify_failed'); }
    else if (lv.unverified || lv.environmental) { verifyOk = false; reasons.push('last_verify_hollow'); }
    else if (lv.tree && input.currentTree) {
      treeCompared = true;
      if (lv.tree !== input.currentTree) { verifyOk = false; reasons.push('verify_tree_stale'); }
    }
    else if (lv.tree && !input.currentTree && input.requireTreeMatch) { verifyOk = false; reasons.push('verify_tree_unknown'); }
  }
  if (input.guardRejectBacks > 0) reasons.push('guard_reject_back');
  return {
    skip: reasons.length === 0,
    steps: completed.length,
    blockedSteps,
    receipted: join.length - unreceipted.length,
    unreceiptedStepIds: unreceipted,
    verifyOk,
    treeCompared,
    reasons,
  };
}

/** 1-in-10 control sample keyed on the run id's hex tail (falls back to the session id). Pure. */
export function selfAuditControlSample(runId: string | null | undefined, fallbackId: string): boolean {
  const id = String(runId || fallbackId || '');
  const tail = id.replace(/[^0-9a-f]/gi, '').slice(-2);
  const n = parseInt(tail, 16);
  return Number.isFinite(n) && n % 10 === 0;
}

// ── Auto-demotion (act → shadow on a bad control reopen rate) ───────────────

/** The fleet base reopen rate the backtest measured (1.8 %) + the 2 pt margin. */
export const RECEIPT_RULE_BASE_REOPEN = 0.018;
export const RECEIPT_RULE_DEMOTE_MARGIN = 0.02;
export const RECEIPT_RULE_DEMOTE_MIN_ROWS = 30;

export interface ReceiptRuleDemotionVerdict { demote: boolean; n: number; reopenRate: number; bar: number }

/**
 * Pure demotion evaluator over the CONTROL rows (the 1-in-10 rounds the rule
 * would have skipped but ran anyway): demote when n ≥ 30 and the control
 * reopen rate exceeds base + margin. Same shape as the decision-gate
 * auto-demote (a measured act-period rate against a bar), without Wilson —
 * the sample is small and the bar is deliberately conservative.
 */
export function evaluateReceiptRuleDemotion(controlRows: ReadonlyArray<{ reopened: boolean | null }>): ReceiptRuleDemotionVerdict {
  const labelled = controlRows.filter(r => r.reopened !== null);
  const n = labelled.length;
  const reopened = labelled.filter(r => r.reopened === true).length;
  const reopenRate = n ? reopened / n : 0;
  const bar = RECEIPT_RULE_BASE_REOPEN + RECEIPT_RULE_DEMOTE_MARGIN;
  return { demote: n >= RECEIPT_RULE_DEMOTE_MIN_ROWS && reopenRate > bar, n, reopenRate, bar };
}

// ── Promotion readout (fixer 2026-09-27, finding 5) ──────────────────────────
// The SHADOW rows (self_audit_shadow — every evaluated round that RAN, labelled
// with the harness reopen signal) are what a shadow → act decision must rest
// on; before this the readout was the offline backtest alone. Ready ⇔ at least
// RECEIPT_RULE_PROMOTE_MIN_ROWS labelled wouldSkip:true rows AND their reopen
// rate is at or under the same bar the demotion uses. The readout is a store
// stamp; the flip itself stays SELF_AUDIT_RECEIPT_RULE_MODE=act (an owner /
// env decision — never automatic).

export const RECEIPT_RULE_PROMOTE_MIN_ROWS = 200;

export interface ReceiptRulePromotionVerdict { ready: boolean; n: number; reopened: number; reopenRate: number; bar: number; reasons: string[] }

/** Pure promotion evaluator over shadow rows: wouldSkip:true ∧ labelled only. */
export function evaluateReceiptRulePromotion(shadowRows: ReadonlyArray<{ wouldSkip: boolean; reopened: boolean | null }>): ReceiptRulePromotionVerdict {
  const labelled = shadowRows.filter(r => r.wouldSkip === true && r.reopened !== null);
  const n = labelled.length;
  const reopened = labelled.filter(r => r.reopened === true).length;
  const reopenRate = n ? reopened / n : 0;
  const bar = RECEIPT_RULE_BASE_REOPEN + RECEIPT_RULE_DEMOTE_MARGIN;
  const reasons: string[] = [];
  if (n < RECEIPT_RULE_PROMOTE_MIN_ROWS) reasons.push(`labelled wouldSkip rows ${n} < ${RECEIPT_RULE_PROMOTE_MIN_ROWS}`);
  if (n > 0 && reopenRate > bar) reasons.push(`reopen rate ${(reopenRate * 100).toFixed(1)} % > bar ${(bar * 100).toFixed(1)} %`);
  return { ready: reasons.length === 0, n, reopened, reopenRate, bar, reasons };
}

export const RECEIPT_RULE_STORE_NS = ['instance', 'self-audit-receipt-rule'];
export const RECEIPT_RULE_STORE_KEY = 'state';
export const RECEIPT_RULE_READINESS_KEY = 'readiness';

/**
 * Promotion readout (called fire-and-forget, SAMPLED 1-in-10 by round id after
 * a shadow row is written): reads the last 30 days of self_audit_shadow rows,
 * evaluates, and stamps ['instance','self-audit-receipt-rule']/readiness. Never
 * flips the mode. Best-effort, never throws; hermetic under NODE_ENV=test.
 */
export async function checkReceiptRulePromotion(): Promise<ReceiptRulePromotionVerdict | null> {
  if (process.env.NODE_ENV === 'test' && !onFlag(process.env.SELF_AUDIT_RECEIPT_RULE_STORE_IN_TEST)) return null;
  try {
    const { default: prisma } = await import('../../../config/database');
    const rows = await prisma.loopMetric.findMany({
      where: { kind: 'self_audit_shadow', createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
      select: { meta: true },
      orderBy: { createdAt: 'desc' },
      take: 2000,
    });
    const verdict = evaluateReceiptRulePromotion(rows.map((r: { meta: unknown }) => {
      const m = (r.meta && typeof r.meta === 'object' ? r.meta : {}) as { wouldSkip?: unknown; reopened?: unknown };
      return { wouldSkip: m.wouldSkip === true, reopened: typeof m.reopened === 'boolean' ? m.reopened : null };
    }));
    const { storePut } = await import('../memory/context-store');
    await storePut(RECEIPT_RULE_STORE_NS, RECEIPT_RULE_READINESS_KEY, { ...verdict, at: new Date().toISOString() });
    return verdict;
  } catch { return null; }
}

/**
 * Store-backed demotion flag (written by checkReceiptRuleDemotion). Read
 * through a dynamic import so the pure half of this module stays
 * dependency-free for tests; ANY failure reads as "not demoted" — but the
 * CALLER still treats an unreadable store as shadow only when the rule is in
 * act (see selfAuditReceiptRuleMode). Under NODE_ENV=test the store is never
 * consulted (hermeticity — the same contract as decision-gate-modes).
 */
export async function receiptRuleAutoDemoted(): Promise<{ demoted: boolean; reason?: string }> {
  if (process.env.NODE_ENV === 'test' && !onFlag(process.env.SELF_AUDIT_RECEIPT_RULE_STORE_IN_TEST)) return { demoted: false };
  try {
    const { storeGet } = await import('../memory/context-store');
    const row = await storeGet<{ demoted?: boolean; reason?: string }>(RECEIPT_RULE_STORE_NS, RECEIPT_RULE_STORE_KEY);
    return row?.demoted ? { demoted: true, reason: row.reason } : { demoted: false };
  } catch { return { demoted: false }; }
}

/**
 * The EFFECTIVE mode: env act only when the store has not demoted it.
 * Shadow needs no store read. Never throws.
 */
export async function selfAuditReceiptRuleMode(): Promise<{ mode: ReceiptRuleMode; source: 'env' | 'auto_demoted' }> {
  const env = selfAuditReceiptRuleEnvMode();
  if (env !== 'act') return { mode: env, source: 'env' };
  const d = await receiptRuleAutoDemoted();
  return d.demoted ? { mode: 'shadow', source: 'auto_demoted' } : { mode: 'act', source: 'env' };
}

/**
 * Demotion check (called fire-and-forget after a CONTROL round is labelled):
 * reads the last 30 days of self_audit_control rows, evaluates, and writes
 * the store flag on a breach. Best-effort, never throws; a demotion is
 * one-way (an owner clears the row to re-arm act).
 */
export async function checkReceiptRuleDemotion(): Promise<ReceiptRuleDemotionVerdict | null> {
  if (process.env.NODE_ENV === 'test' && !onFlag(process.env.SELF_AUDIT_RECEIPT_RULE_STORE_IN_TEST)) return null;
  try {
    const { default: prisma } = await import('../../../config/database');
    const rows = await prisma.loopMetric.findMany({
      where: { kind: 'self_audit_control', createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
      select: { meta: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const verdict = evaluateReceiptRuleDemotion(rows.map((r: { meta: unknown }) => {
      const m = (r.meta && typeof r.meta === 'object' ? r.meta : {}) as { reopened?: unknown };
      return { reopened: typeof m.reopened === 'boolean' ? m.reopened : null };
    }));
    if (verdict.demote) {
      const { storePut } = await import('../memory/context-store');
      await storePut(RECEIPT_RULE_STORE_NS, RECEIPT_RULE_STORE_KEY, {
        demoted: true,
        at: new Date().toISOString(),
        reason: `control reopen rate ${(verdict.reopenRate * 100).toFixed(1)} % over ${verdict.n} rows exceeds bar ${(verdict.bar * 100).toFixed(1)} %`,
      });
    }
    return verdict;
  } catch { return null; }
}
