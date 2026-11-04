/**
 * Self-audit decision gate (2026-09-24) — the typed question the coding loop
 * asks before spending a +20-step self-audit round: does the final summary
 * claim work this run's tool receipts do not evidence? Pure over its inputs
 * apart from the decide() call; NEVER throws (a gate failure = audit runs).
 *
 * Outcome label (WI-C, 2026-09-25): a shadow decision whose audit RAN used to
 * close with actual:null ('audit ran' — 247 prod rows, `agreed` never
 * computed). The decision is now STASHED (selfAuditGateDecide) and the loop
 * records its outcome after the audit round from what the audit measurably
 * did: `unevidenced` ⇔ the round REOPENED a step that was completed before it
 * (the harness-observable signature of a premature completion claim —
 * selfAuditReopened). The gate's act/skip behaviour is unchanged.
 */

import { decide, decisionMode, decisionThreshold, recordDecisionOutcome, stashDecision, reconstructDecision, type DecisionAnswer, type DecisionQuestion, type DecisionStash } from '../platform/decision-gate';
import type { ToolReceipt } from './run-receipts';

export interface SelfAuditGateInput {
  plan: { steps: Array<{ id: string | number; status: string; text: string; note?: string | null }>; acceptanceCriteria?: string[] | null } | null;
  finalText: string;
  receipts: ToolReceipt[];
  sessionId: string;
}

// ── E8 (2026-09-25): re-posed request — receipt SUBSTANCE + per-step nouls ──
// 24 h of shadow rows showed the v1 request unanswerable as posed: receipts
// reached the gate as {tool, ok, ids} only, so Jev said "unevidenced" on 41/46
// rows, 0/50 landed in the skip band and 9/9 labels disagreed. The vendor's
// jaggedness guidance names the two defects: counting/indirection across 16
// receipts × 40 steps hidden in ONE question, and state without the facts the
// question needs. v2 (the v1 request — one holistic noul over {tool, ok, ids}
// receipts — is gone):
//   state     — plan steps as objects; the completed steps UNDER REVIEW as a
//               positional list; receipts with scrubbed args/result heads
//               (run-receipts.ts receiptHeads, in-memory only); the final
//               summary LAST.
//   questions — `unevidenced` (v1 text verbatim, kept for comparison) +
//               `claims_unbacked` + `steps_unbacked` (the compound split) +
//               one `step_<k>_evidenced` noul per reviewed step, built in
//               code (SDE-cascade pattern). Per-step questions reference the
//               step by POSITION so the question set — and the row's
//               questionsHash — depends only on the reviewed count, not on
//               the step text.
//   act       — the purpose stays SHADOW. Under v2 an act-mode skip requires
//               the v1 condition AND every per-step noul confidently
//               evidenced AND claims_unbacked confidently false
//               (selfAuditV2WouldSkip) — never more skips than v1.
//   labels    — the holistic label stays the sibling's (recordSelfAuditOutcome);
//               recordSelfAuditStepOutcomes pairs the new questions: per-step
//               ⇔ that step was NOT reopened by the audit; steps_unbacked ⇔
//               any reviewed step reopened; claims_unbacked ⇔ the composite.

/** Per-step nouls per request: DECISION_GATE_SELF_AUDIT_STEP_NOULS (0 = holistic + split only), clamped 0–40, default 12 —
 *  the logprob-readout leg runs one prefill PER question, so the cap bounds that leg's fan-out. */
export const SELF_AUDIT_STEP_NOULS_DEFAULT = 12;
export function selfAuditStepNoulCap(): number {
  const raw = Number(process.env.DECISION_GATE_SELF_AUDIT_STEP_NOULS);
  if (!Number.isFinite(raw)) return SELF_AUDIT_STEP_NOULS_DEFAULT;
  return Math.max(0, Math.min(40, Math.floor(raw)));
}

const STEP_QUESTION_RE = /^step_(\d+)_evidenced$/;
export const stepQuestionKey = (position: number): string => `step_${position}_evidenced`;

/** The completed steps the v2 request reviews, in plan order (the first `cap` completed ids). Shared by the gate and its labels. */
export function reviewedStepIds(steps: ReadonlyArray<{ id: string | number; status: string }>, cap: number = selfAuditStepNoulCap()): string[] {
  return completedStepIds(steps).slice(0, Math.max(0, cap));
}

/** The v2 state: objects, receipt heads, the reviewed steps by position, the final LAST. Exported for tests. */
export function selfAuditGateStateV2(input: SelfAuditGateInput, cap: number = selfAuditStepNoulCap()): Record<string, unknown> {
  const steps = (input.plan?.steps ?? []).slice(0, 40);
  const reviewed = new Set(reviewedStepIds(steps, cap));
  let position = 0;
  const underReview = steps
    .filter(s => reviewed.has(String(s.id)))
    .map(s => ({ position: ++position, id: String(s.id), text: String(s.text || '').slice(0, 240) }));
  const receipts = input.receipts.slice(-16).map(r => ({
    id: String(r.id || '').slice(0, 8),
    tool: r.tool,
    ok: r.ok,
    ids: r.ids,
    args: r.argsHead ?? null,
    result: r.resultHead ?? null,
  }));
  return {
    plan_steps: steps.map(s => ({ id: String(s.id), status: s.status, text: String(s.text || '').slice(0, 240), ...(s.note ? { note: String(s.note).slice(0, 120) } : {}) })),
    acceptance_criteria: (input.plan?.acceptanceCriteria ?? []).slice(0, 12),
    completed_steps_under_review: underReview,
    receipts,
    final_summary: String(input.finalText || '').slice(0, 3000),
  };
}

/** The v1 noul — text pinned (kept verbatim in v2 for comparability). */
export const UNEVIDENCED_QUESTION: DecisionQuestion = {
  type: 'noul',
  instructions: 'The final summary claims completed work (a push, merge, deploy, fix, verification, message or file change) that the tool receipts from this run do not evidence, or marks a plan step completed that the receipts do not support.',
  criteria: {
    true: 'at least one completion claim or completed step has no matching receipt',
    false: 'every completion claim and completed step is backed by a receipt, or the summary claims no completion at all (an honest blocked / unfinished report)',
  },
};

/** The v2 question set for `reviewedCount` steps under review. Exported for tests. */
export function selfAuditQuestionsV2(reviewedCount: number): Record<string, DecisionQuestion> {
  const q: Record<string, DecisionQuestion> = {
    unevidenced: UNEVIDENCED_QUESTION,
    claims_unbacked: {
      type: 'noul',
      instructions: 'The final summary (`final_summary`) claims a completed action — a push, merge, deploy, fix, verification, message sent, ticket update or file change — that no receipt in `receipts` evidences.',
      criteria: {
        true: 'a completion claim in the summary has no receipt whose tool, args, result or ids correspond to it, or its only matching receipts are ok:false',
        false: 'every completion claim in the summary corresponds to an ok:true receipt, or the summary claims no completed action at all (an honest blocked / unfinished / in-progress report)',
      },
    },
    steps_unbacked: {
      type: 'noul',
      instructions: 'At least one step in `completed_steps_under_review` (marked completed in the plan) has no receipt in `receipts` that evidences its work.',
      criteria: {
        true: 'a reviewed step describes work that no ok:true receipt shows was done this run',
        false: 'every reviewed step has a receipt whose tool, args, result or ids show its work was done, or there are no steps under review',
      },
    },
  };
  for (let k = 1; k <= Math.max(0, reviewedCount); k++) {
    q[stepQuestionKey(k)] = {
      type: 'noul',
      instructions: `The receipts in \`receipts\` evidence the work of the completed plan step at position ${k} of \`completed_steps_under_review\` — a receipt's tool, args, result or ids show that this step's work was actually done this run.`,
      criteria: {
        true: 'an ok:true receipt corresponds to what the step says was done (the right tool, a matching path / branch / id / command, or a result that states it)',
        false: 'no receipt corresponds to the step\'s work, the only corresponding receipts are ok:false, or the step describes work that would need a receipt none of the listed tools produced',
      },
    };
  }
  return q;
}

/** The gate request: the v2 state + the holistic, split and per-step questions. */
export function selfAuditGateRequest(input: SelfAuditGateInput): { state: Record<string, unknown>; questions: Record<string, DecisionQuestion>; shape: 'v2' } {
  const cap = selfAuditStepNoulCap();
  const reviewed = reviewedStepIds(input.plan?.steps ?? [], cap);
  return { state: selfAuditGateStateV2(input, cap), questions: selfAuditQuestionsV2(reviewed.length), shape: 'v2' };
}

const noulOf = (a: DecisionAnswer | undefined): number | null => (a && a.type === 'noul' ? a.noul : null);

/**
 * What the v2 act contract would do: skip ⇔ every per-step noul ≥ τ
 * (confidently evidenced) AND claims_unbacked ≤ 1 − τ AND steps_unbacked ≤
 * 1 − τ. Null for a v1 answer set (no split questions). Shadow readout today;
 * under act it is AND-ed with the v1 condition (never more skips than v1).
 */
export function selfAuditV2WouldSkip(answers: Record<string, DecisionAnswer> | null | undefined, threshold: number): boolean | null {
  const claims = noulOf(answers?.claims_unbacked);
  const steps = noulOf(answers?.steps_unbacked);
  if (claims === null || steps === null) return null;
  if (claims > 1 - threshold || steps > 1 - threshold) return false;
  for (const [k, a] of Object.entries(answers ?? {})) {
    if (!STEP_QUESTION_RE.test(k)) continue;
    const p = noulOf(a);
    if (p === null || p < threshold) return false;
  }
  return true;
}

export interface SelfAuditGateDecision {
  /** True when the gate is in ACT mode and confidently finds nothing unevidenced. */
  skip: boolean;
  /** The decision to label AFTER the audit round (null: skipped, off, failed, or labels disabled). */
  stash: DecisionStash | null;
}

/** The gate decision + the stash the loop labels once the audit round has run. */
export async function selfAuditGateDecide(input: SelfAuditGateInput): Promise<SelfAuditGateDecision> {
  const mode = decisionMode('self_audit');
  if (mode === 'off') return { skip: false, stash: null };
  try {
    const request = selfAuditGateRequest(input);
    const r = await decide(request.state, request.questions, { purpose: 'self_audit', timeoutMs: 4000, sessionId: input.sessionId });
    if (!r) return { skip: false, stash: null };
    const p = (r.answers.unevidenced as { noul: number }).noul;
    const threshold = decisionThreshold('self_audit', 0.85);
    const v2Skip = selfAuditV2WouldSkip(r.answers, threshold);
    // E2 (2026-09-25): the RESULT's mode gates acting (an uncalibrated backend answers as 'shadow').
    // v1 contract unchanged; a v2 answer set additionally requires the split +
    // per-step nouls to agree (a false "evidenced" skips a safety pass — the
    // stricter AND can only remove skips, never add them).
    const skip = r.mode === 'act' && p <= 1 - threshold && v2Skip !== false;
    const v2Note = v2Skip === null ? '' : `; v2 would-skip:${v2Skip ? 'yes' : 'no'}`;
    if (skip) {
      recordDecisionOutcome(r, 'self_audit', { question: 'unevidenced', actual: null, acted: true, sessionId: input.sessionId, note: `audit skipped${v2Note}` });
      return { skip, stash: null };
    }
    return { skip: false, stash: stashDecision(r, 'self_audit') };
  } catch {
    return { skip: false, stash: null };
  }
}

/** True when the gate is in ACT mode and confidently finds nothing unevidenced (legacy shape). */
export async function selfAuditGateSkips(input: SelfAuditGateInput): Promise<boolean> {
  return (await selfAuditGateDecide(input)).skip;
}

type StepLike = { id: string | number; status: string };

/** Ids of the steps that were COMPLETED when the audit was granted. */
export function completedStepIds(steps: ReadonlyArray<StepLike>): string[] {
  return steps.filter(s => s.status === 'completed').map(s => String(s.id));
}

/**
 * Did the audit round REOPEN a completed step? True when any step completed
 * before the audit is no longer completed after it (reopened to pending /
 * in_progress, or blocked) — the harness-observable signature of a premature
 * completion claim. A step deleted from the plan counts too (the audit
 * withdrew it). Pure.
 */
export function selfAuditReopened(completedBefore: ReadonlyArray<string>, stepsAfter: ReadonlyArray<StepLike>): boolean {
  if (!completedBefore.length) return false;
  const after = new Map(stepsAfter.map(s => [String(s.id), s.status]));
  return completedBefore.some(id => after.get(id) !== 'completed');
}

/**
 * Harness-observable signals the agent loop collects between the audit grant
 * and the end of the audit round (E5 honest labels, 2026-09-25). Each one is a
 * DELTA measured by the loop, never a model claim.
 */
export interface SelfAuditOutcomeSignals {
  /** selfAuditReopened() over the plan after the round; null = plan unreadable after the round. */
  reopened: boolean | null;
  /** Evidence-guard REJECT-BACK rounds the loop used after the audit was granted (guardRejectBacks delta). */
  rejectBacksAfter: number;
  /** Guard-struck / guard-marker transcript parts appended after the audit was granted (a struck final, a discarded draft). */
  guardStrikesAfter: number;
  /** Steps completed when the audit was granted (forensics for the note). */
  completedBefore: number;
}

/**
 * The self_audit `actual` (E5 composite label): unevidenced ⇔ the round
 * REOPENED a completed step OR the evidence guard STRUCK the final after the
 * audit OR the loop REJECTED a final back for correction after the audit — all
 * three are the harness catching a completion claim the receipts did not
 * support, which is exactly the question the gate asked. The WI-C reopen-only
 * label had 0/9 agreement in prod because a struck / rejected final never
 * reopened a step. Components ride the note so a disagreement can be
 * attributed. null only when NO signal is observable (plan unreadable and no
 * strike / reject-back). Pure; never throws.
 */
export function labelSelfAuditOutcome(s: SelfAuditOutcomeSignals): { actual: boolean | null; note: string } {
  const reopenedTxt = s.reopened === null ? 'plan unreadable' : (s.reopened ? 'reopened a completed step' : 'no completed step reopened');
  const strike = s.guardStrikesAfter > 0;
  const reject = s.rejectBacksAfter > 0;
  const actual = s.reopened === null && !strike && !reject ? null : (s.reopened === true || strike || reject);
  const components = [
    `reopened=${s.reopened === null ? 'unknown' : s.reopened}`,
    `guard_strike=${s.guardStrikesAfter}`,
    `reject_back=${s.rejectBacksAfter}`,
  ].join(' ');
  return { actual, note: `audit ran: ${reopenedTxt}; ${components} (${s.completedBefore} completed before)` };
}

/** Record the deferred self_audit outcome; `actual` null = the audit round's result is unknown. Never throws. */
export function recordSelfAuditOutcome(stash: DecisionStash | null, actual: boolean | null, sessionId: string, note: string): void {
  try {
    recordDecisionOutcome(reconstructDecision(stash), 'self_audit', { question: 'unevidenced', actual, acted: false, sessionId, note });
  } catch { /* telemetry never breaks the run */ }
}

/**
 * E8: the deferred outcome rows for a v2 stash's split + per-step questions
 * (a v1 stash answered none → no rows). `completedBefore` is
 * completedStepIds(plan) at gate time — the reviewed steps are its first N in
 * plan order (reviewedStepIds), so position k ↔ completedBefore[k-1] with N =
 * the number of step questions the stash answered. `stepsAfter` null = the
 * plan was unreadable after the round (actual null). `compositeActual` is the
 * holistic label the caller computed (claims_unbacked pairs with it);
 * steps_unbacked pairs with "any reviewed step reopened". Never throws.
 */
export function recordSelfAuditStepOutcomes(
  stash: DecisionStash | null,
  completedBefore: ReadonlyArray<string>,
  stepsAfter: ReadonlyArray<StepLike> | null,
  sessionId: string,
  compositeActual: boolean | null,
): void {
  try {
    const decision = reconstructDecision(stash);
    if (!decision) return;
    const answered = decision.answers;
    const stepKeys = Object.keys(answered).filter((k) => STEP_QUESTION_RE.test(k));
    if (!('claims_unbacked' in answered) && !('steps_unbacked' in answered) && !stepKeys.length) return;
    const after = stepsAfter ? new Map(stepsAfter.map((s) => [String(s.id), s.status])) : null;
    const reviewed = completedBefore.slice(0, stepKeys.length);
    const reopened = after ? reviewed.filter((id) => after.get(id) !== 'completed') : null;
    const note = after ? `audit ran: ${reopened!.length} of ${reviewed.length} reviewed step(s) reopened` : 'audit ran: plan unreadable after the round';
    if ('claims_unbacked' in answered) {
      recordDecisionOutcome(decision, 'self_audit', { question: 'claims_unbacked', actual: compositeActual, acted: false, sessionId, note });
    }
    if ('steps_unbacked' in answered) {
      recordDecisionOutcome(decision, 'self_audit', { question: 'steps_unbacked', actual: reopened ? reopened.length > 0 : null, acted: false, sessionId, note });
    }
    for (const key of stepKeys) {
      const position = Number(key.match(STEP_QUESTION_RE)![1]);
      const id = reviewed[position - 1];
      // evidenced ⇔ the audit left the step completed (did NOT reopen it)
      const actual = after && id !== undefined ? after.get(id) === 'completed' : null;
      recordDecisionOutcome(decision, 'self_audit', { question: key, actual, acted: false, sessionId, note: id !== undefined ? `${note}; step ${id}` : `${note}; position ${position} unmapped` });
    }
  } catch { /* telemetry never breaks the run */ }
}
