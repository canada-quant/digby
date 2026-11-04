/**
 * Harness-side ADAPTERS for the compute-policy outcome labels (Module B →
 * Module A). Every label here is a FACT the harness measured — never a
 * model's self-report (docs/DEPTH_UX_SOTA_2026-09-26.md §3 cautions):
 *
 *   compute_policy    — `escalated`: the user tapped Dig deeper on the message
 *                       ≤ 30 min after it posted (the PRIMARY label, written
 *                       once per decision); `escalated_late`: a tap AFTER the
 *                       window (a SECONDARY row — cp/labels 2026-09-26; it used
 *                       to write nothing); `facts`: the finalize's harness
 *                       facts (checker spawned / merged, tool + web calls,
 *                       final length, ttft / completion / spend / council);
 *                       `reask_5m`: the same user's next human turn in the
 *                       chat ≤ 5 min after the answer; `thumbs`: a thumbs
 *                       up / down (+ reason) on the answer.
 *   drafts_agree      — SHADOW: the reconcile's verdict, read DIRECTION-AWARE
 *                       (draftsAgreeLabelMaterial — 2026-09-26 label-semantics
 *                       fix): agree ⇔ the reconcile removed / replaced no claim
 *                       of the lead's answer and flipped no polarity /
 *                       negation / recommendation; additions-only ⇒ agree; a
 *                       fallback verdict ⇒ actual null (it used to read "any
 *                       non-whitespace change = disagree", so agree was
 *                       ≈0.4% and the noul_high band could never reach the
 *                       precision bar). ACT (reconcile skipped): the compact
 *                       stash persists on metadata.check.draftsAgree and a
 *                       later thumbs / Dig-deeper tap labels it acted:true
 *                       (labelDraftsAgreeFromMetadata) so E12 auto-demote is
 *                       not blind.
 *   revision_material — the user's thumbs / escalation after the revision
 *                       ('updated') OR after a rewrite the gate WITHHELD in act
 *                       ('checked', labelled acted:true — audit 2026-09-26; a
 *                       'checked' row used to label nothing, so exactly the
 *                       in-band act decisions were invisible to auto-demote).
 *
 * The rows themselves are written by platform/decision-outcome-labels.ts
 * (labelComputePolicyOutcome / labelDraftsAgreeOutcome /
 * labelRevisionMaterialOutcome — the ONE place that knows each purpose's
 * question, actual shape and secondary-label rules). This file only turns the
 * compact stash the harness persists (metadata.depth.decision = { id, answers,
 * mode }; metadata.check.verdict.decision for revision_material) or a decision
 * the harness holds in memory into the DecisionStash those writers take.
 * Never throws.
 */
import type { DecisionAnswer, DecisionMode, DecisionStash } from '../platform/decision-gate';
import {
  COMPUTE_POLICY_ESCALATION_WINDOW_MS, COMPUTE_POLICY_REASK_WINDOW_MS, labelComputePolicyOutcome, labelDraftsAgreeOutcome, labelRevisionMaterialOutcome,
  type ComputePolicyLabel, type ComputePolicyTurnFacts, type ComputePolicyTurnStats,
} from '../platform/decision-outcome-labels';
import {
  COMPUTE_POLICY_PURPOSE, DRAFTS_AGREE_PURPOSE, DRAFTS_AGREE_QUESTION, REVISION_MATERIAL_PURPOSE, REVISION_MATERIAL_QUESTION, computePlanStash, type DepthPreset,
} from '../platform/compute-policy-gate';
import { compactDecisionStash } from './compute-policy-wiring';

export { COMPUTE_POLICY_PURPOSE, DRAFTS_AGREE_PURPOSE, REVISION_MATERIAL_PURPOSE };
export type { ComputePolicyTurnFacts, ComputePolicyTurnStats };

/** The escalated-label window: a Dig deeper tap counts against the message's decision as the PRIMARY label only this soon after it posted. */
export const ESCALATED_LABEL_WINDOW_MS = COMPUTE_POLICY_ESCALATION_WINDOW_MS;
/** The re-ask window: the same user's next human turn in the chat this soon after the answer labels it `reask_5m`. */
export const REASK_LABEL_WINDOW_MS = COMPUTE_POLICY_REASK_WINDOW_MS;

const parseMode = (m: unknown, fallback: DecisionMode): DecisionMode => (m === 'act' || m === 'shadow' || m === 'off' ? m : fallback);

/**
 * The compact stash the harness persists (metadata.depth.decision = { id,
 * answers, mode }) — or a full DecisionStash — → the DecisionStash the Module A
 * writers take (pure; null when unusable).
 */
export function decisionFromStash(stash: unknown, mode: DecisionMode = 'shadow'): DecisionStash | null {
  const s = stash as Partial<DecisionStash> | null;
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !s.id || !s.answers || typeof s.answers !== 'object') return null;
  if (typeof s.purpose === 'string' && s.purpose) return { ...(s as DecisionStash), mode: parseMode(s.mode, mode) };
  // 2026-09-26 (audit): the compact metadata.depth.decision carries `segment` since this change — recovered here so the outcome row stamps it.
  return computePlanStash({ decisionId: s.id, mode: parseMode(s.mode, mode), answers: s.answers as Record<string, unknown>, ...(typeof s.segment === 'string' ? { segment: s.segment } : {}) });
}

/** A noul decision the harness holds in memory (decideDraftsAgree / decideRevisionMaterial) → its stash. */
function noulStash(purpose: typeof DRAFTS_AGREE_PURPOSE | typeof REVISION_MATERIAL_PURPOSE, question: string, id: string, p: number, mode: DecisionMode): DecisionStash {
  const answers: Record<string, DecisionAnswer> = { [question]: { type: 'noul', noul: p } as DecisionAnswer };
  return { id, purpose, mode, backend: 'compute-policy', answers, decidedAt: new Date(0).toISOString() };
}

const asRecord = (v: unknown): Record<string, any> | null => (v && typeof v === 'object' ? v as Record<string, any> : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * The turn facts a persisted assistant row carries (metadata.depth.facts,
 * written at finalize) — with `checkerMerged` upgraded by a late pill state
 * ('checked' / 'updated' = the check completed after finalize). Pure; null
 * when the row predates cp/labels (the later labels then carry no facts and
 * derive the depth from the signal alone, exactly like the tap did).
 */
export function factsFromDepthMetadata(metadata: unknown): ComputePolicyTurnFacts | null {
  const meta = asRecord(metadata);
  const f = asRecord(meta?.depth?.facts);
  if (!f) return null;
  const checkState = String(meta?.check?.state ?? '');
  return {
    leadToolCalls: num(f.leadToolCalls), webToolCalls: num(f.webToolCalls), finalChars: num(f.finalChars),
    checkerSpawned: f.checkerSpawned === true,
    checkerMerged: f.checkerMerged === true || checkState === 'checked' || checkState === 'updated',
    ...(f.checkerEffortSent === 'high' || f.checkerEffortSent === 'max' ? { checkerEffortSent: f.checkerEffortSent } : {}),
  };
}

/** The compute_policy decision stash a persisted row carries (metadata.depth.decision). Pure. */
export function computeDecisionFromMetadata(metadata: unknown): DecisionStash | null {
  const meta = asRecord(metadata);
  return decisionFromStash(meta?.depth?.decision);
}

/**
 * The revision_material decision a persisted row carries
 * (metadata.check.verdict.decision — the compact stash late-crosscheck / the
 * inline reconcile persisted), the pill state it ended in (`state`; `updated`
 * = the revision was MATERIAL and replaced the text) and `acted` = the gate
 * itself decided wording-only (verdict.source 'gate' + material false — only
 * possible in act; the rewrite was WITHHELD and the pill read 'checked').
 * Pure; null when no gate decision was persisted (the deterministic diff
 * decided, or the row predates cp/labels).
 */
export function revisionDecisionFromMetadata(metadata: unknown): { stash: DecisionStash; updated: boolean; state: string; acted: boolean } | null {
  const meta = asRecord(metadata);
  const verdict = asRecord(meta?.check?.verdict);
  const stash = decisionFromStash(verdict?.decision);
  if (!stash || stash.purpose !== REVISION_MATERIAL_PURPOSE) return null;
  const state = String(meta?.check?.state ?? '');
  return { stash, updated: state === 'updated', state, acted: verdict?.source === 'gate' && verdict?.material === false };
}

/**
 * Label the message's compute_policy decision from a Dig-deeper tap: `escalated`
 * (the PRIMARY label; ≤ 30 min after the message posted) or `escalated_late`
 * (a SECONDARY row for a later tap — cp/labels 2026-09-26; before that a late
 * tap wrote nothing, and Module A still refuses a premature escalated:false).
 * Returns the label written, or false. Never throws.
 */
export function labelComputePolicyEscalated(opts: { decisionStash: unknown; messageCreatedAt: Date | string | null | undefined; rung: 'verify' | 'research'; sessionId?: string; now?: Date; facts?: ComputePolicyTurnFacts | null; /** the plan ACTED on this decision (metadata.depth.plan.source === 'gate_act') — audit 2026-09-26 telemetry-readiness-1: the tap row used to read acted:false even on an acted plan */ acted?: boolean; guest?: boolean; segment?: string;
  /** How `rung` was picked — the controller's `nextRungForMessage` is 'forced' (the default; today's only chip); pass 'chosen' only from an explicit user pick. A forced rung writes no research_request row (audit 2026-09-26). */
  rungChoice?: 'forced' | 'chosen';
}): false | 'escalated' | 'escalated_late' {
  try {
    const stash = decisionFromStash(opts.decisionStash);
    if (!stash) return false;
    const created = opts.messageCreatedAt ? new Date(opts.messageCreatedAt).getTime() : NaN;
    const ageMs = Number.isFinite(created) ? (opts.now ?? new Date()).getTime() - created : null;
    if (ageMs === null || ageMs < 0) return false;
    const label: ComputePolicyLabel = ageMs <= ESCALATED_LABEL_WINDOW_MS ? 'escalated' : 'escalated_late';
    labelComputePolicyOutcome(stash, {
      label, escalated: true, escalatedTo: opts.rung, rungChoice: opts.rungChoice ?? 'forced', sessionId: opts.sessionId, facts: opts.facts ?? null,
      source: label === 'escalated' ? 'dig_deeper' : 'dig_deeper_late', acted: opts.acted === true,
      ...(opts.guest !== undefined ? { guest: opts.guest } : {}), ...(opts.segment ? { segment: opts.segment } : {}),
    });
    return label;
  } catch { return false; }
}

/**
 * The finalize `facts` row (design §4 D2 — cp/labels 2026-09-26): what the
 * turn measurably did, written once per human turn's compute_policy decision.
 * Never `escalated` (Module A refuses it here — the readiness ruler keeps the
 * earliest escalated row per decision). `acted` = the plan came from the gate
 * in act; `failed` = an empty finalize evidences nothing. `escalatable:false`
 * (2026-09-26 audit) = the Dig-deeper chip was NEVER shown on this turn
 * (supervisor chat / DIG_DEEPER_DISABLED), so an `escalated:true` can never
 * arrive and the ruler's window-closed fallback would read the facts row as a
 * structural NEGATIVE — the row is written for its turn stats but tagged
 * `excludeFromFit`. Never throws.
 */
export function labelComputePolicyFacts(opts: { decisionStash: unknown; facts: ComputePolicyTurnFacts | null; requestedPreset?: DepthPreset; turn?: ComputePolicyTurnStats | null; acted?: boolean; failed?: boolean; sessionId?: string; guest?: boolean; segment?: string; escalatable?: boolean }): boolean {
  try {
    const stash = decisionFromStash(opts.decisionStash);
    if (!stash) return false;
    const excludeFromFit = opts.escalatable === false;
    labelComputePolicyOutcome(stash, {
      label: 'facts', facts: opts.facts, requestedPreset: opts.requestedPreset, turn: opts.turn ?? null,
      acted: opts.acted === true, failed: opts.failed === true, sessionId: opts.sessionId, source: 'finalize',
      ...(opts.guest !== undefined ? { guest: opts.guest } : {}), ...(opts.segment ? { segment: opts.segment } : {}),
      ...(excludeFromFit ? { excludeFromFit: true } : {}),
    });
    return true;
  } catch { return false; }
}

/**
 * `reask_5m`: the same user sent the next human turn in the chat ≤ 5 min after
 * the answer — a deterministic proxy for "not deep enough" (design §5:
 * `reask_5m` not above 19–25%). Labels the PREVIOUS turn's decision. Never throws.
 */
export function labelComputePolicyReask(opts: { decisionStash: unknown; facts: ComputePolicyTurnFacts | null; sessionId?: string; gapMs?: number; afterAddendum?: boolean }): boolean {
  try {
    const stash = decisionFromStash(opts.decisionStash);
    if (!stash) return false;
    labelComputePolicyOutcome(stash, { label: 'reask_5m', reasked: true, facts: opts.facts, sessionId: opts.sessionId, source: 'reask', ...(opts.afterAddendum ? { afterAddendum: true } : {}) });
    return true;
  } catch { return false; }
}

/**
 * `thumbs`: the user's rating on the answer (+ the reason chip). A thumbs-down
 * whose reason says "slow / too long" is not "wanted more" — Module A keeps the
 * base depth for those (THUMBS_SLOW_REASONS). Never throws.
 */
export function labelComputePolicyThumbs(opts: { decisionStash: unknown; facts: ComputePolicyTurnFacts | null; thumbs: 'up' | 'down'; reason?: string | null; sessionId?: string }): boolean {
  try {
    const stash = decisionFromStash(opts.decisionStash);
    if (!stash) return false;
    labelComputePolicyOutcome(stash, { label: 'thumbs', thumbs: opts.thumbs, thumbsReason: opts.reason ?? null, facts: opts.facts, sessionId: opts.sessionId, source: 'feedback' });
    return true;
  } catch { return false; }
}

/** The late reconcile's verdict as onOutcome hands it over (chat-agent/late-crosscheck RevisionVerdict, structurally). */
export interface DraftsAgreeReconcileVerdict { material: boolean; changed?: string[]; source: 'diff' | 'gate' | 'fallback'; contradicts?: boolean }

/**
 * What the SHADOW drafts_agree label measures (pure; 2026-09-26 label-semantics
 * fix): `material` true ⇒ the lead's answer and the checker's draft DISAGREED,
 * false ⇒ they agreed, null ⇒ unknowable (no label). Read from the reconcile's
 * VERDICT, not the outcome:
 *   - 'unchanged' with no verdict (the reconcile echoed the answer)  ⇒ false
 *   - verdict source 'gate'      (the gate judged; act only)           ⇒ verdict.material
 *   - verdict source 'diff'      (the deterministic diff fired)         ⇒ verdict.contradicts — a claim of the
 *                                lead's answer removed / replaced or a polarity / negation / recommendation flip;
 *                                additions-only ⇒ false (the reconcile adopted the checker's extra detail: no
 *                                disagreement). A verdict without `contradicts` (older shape) keeps `material`.
 *   - verdict source 'fallback'  (shadow / off / failed: "rewrite as today") ⇒ null — it says nothing about agreement
 *   - anything else without a verdict                                   ⇒ null
 */
export function draftsAgreeLabelMaterial(o: { outcome: string; verdict?: DraftsAgreeReconcileVerdict | null }): boolean | null {
  const v = o.verdict;
  if (!v) return o.outcome === 'unchanged' ? false : null;
  if (v.source === 'fallback') return null;
  if (v.source === 'gate') return v.material === true;
  if (typeof v.contradicts !== 'boolean') return v.material === true;
  return v.contradicts;
}

/** drafts_agree label: agree ⇔ the lead's answer and the checker's draft did not disagree (`material` null ⇒ actual null, no calibration signal). Never throws. */
export function labelDraftsAgree(opts: { decisionId?: string; p: number | null; mode: DecisionMode; material: boolean | null; changed: string[]; acted: boolean; sessionId?: string; stash?: DecisionStash; label?: string; source?: string }): boolean {
  try {
    if (!opts.decisionId || opts.p === null) return false;
    const stash = opts.stash ?? noulStash(DRAFTS_AGREE_PURPOSE, DRAFTS_AGREE_QUESTION, opts.decisionId, opts.p, opts.mode);
    const note = opts.material ? `reconcile changed ${opts.changed.length} material item(s): ${opts.changed.slice(0, 4).join('; ')}` : opts.material === null ? 'verdict says nothing about agreement' : undefined;
    labelDraftsAgreeOutcome(stash, { material: opts.material, acted: opts.acted, sessionId: opts.sessionId, ...(note ? { note } : {}), ...(opts.label ? { label: opts.label } : {}), ...(opts.source ? { source: opts.source } : {}) });
    return true;
  } catch { return false; }
}

/** The drafts_agree decision as decideDraftsAgree returns it (structurally — compute-policy-gate DraftsAgreeVerdict). */
export interface DraftsAgreeDecisionLike { decisionId?: string; p: number | null; mode: DecisionMode; stash?: DecisionStash }

/**
 * The compact drafts_agree record the harness persists on metadata.check.draftsAgree
 * when the decision ACTED (the reconcile was skipped on it — 2026-09-26): the
 * gate's compact stash + p + acted, so a later thumbs / Dig-deeper tap can label
 * the acted decision from the row alone (revision_material's verdict.decision does
 * the same). Pure; {} when nothing acted or no decision.
 */
export function draftsAgreeMeta(d: DraftsAgreeDecisionLike | null | undefined, acted: boolean): { draftsAgree?: Record<string, unknown> } {
  if (!acted || !d || !d.decisionId || d.p === null) return {};
  const stash = d.stash ?? noulStash(DRAFTS_AGREE_PURPOSE, DRAFTS_AGREE_QUESTION, d.decisionId, d.p, d.mode);
  const decision = compactDecisionStash(stash);
  if (!decision) return {};
  return { draftsAgree: { decisionId: d.decisionId, p: d.p, mode: d.mode, acted: true, decision } };
}

/** The ACTED drafts_agree decision a persisted row carries (metadata.check.draftsAgree). Pure; null when none acted on the row. */
export function draftsAgreeDecisionFromMetadata(metadata: unknown): { stash: DecisionStash; p: number } | null {
  const meta = asRecord(metadata);
  const da = asRecord(meta?.check?.draftsAgree);
  if (!da || da.acted !== true) return null;
  const stash = decisionFromStash(da.decision, parseMode(da.mode, 'act'));
  if (!stash || stash.purpose !== DRAFTS_AGREE_PURPOSE) return null;
  const p = (stash.answers[DRAFTS_AGREE_QUESTION] as { noul?: number } | undefined)?.noul;
  if (typeof p !== 'number') return null;
  return { stash, p };
}

export type DraftsAgreeSignal = 'thumbs_up' | 'thumbs_down' | 'escalated' | 'window_closed';

/**
 * drafts_agree from a PERSISTED row whose decision ACTED (the reconcile was
 * skipped): a thumbs-down or a Dig-deeper tap on the "Checked ✓" answer says
 * the skipped reconcile would have mattered ⇒ actual false (disagree), acted:true;
 * a thumbs-up — or a window closer's `window_closed` — ⇒ actual true. Rows
 * whose decision did not act (the shadow reconcile labelled them already)
 * label nothing here. inActBand is true for acted rows, so these rows feed
 * the E12 auto-demote window (never the offline fit, which excludes acted).
 * Never throws.
 */
export function labelDraftsAgreeFromMetadata(metadata: unknown, signal: DraftsAgreeSignal, sessionId?: string): boolean {
  try {
    const da = draftsAgreeDecisionFromMetadata(metadata);
    if (!da) return false;
    const material = signal === 'thumbs_down' || signal === 'escalated';
    return labelDraftsAgree({ decisionId: da.stash.id, p: da.p, mode: da.stash.mode, material, changed: [], acted: true, sessionId, stash: da.stash, label: signal, source: signal === 'escalated' ? 'dig_deeper' : signal === 'window_closed' ? 'window_close' : 'feedback' });
  } catch { return false; }
}

/**
 * revision_material label from a later user signal (thumbs / escalation):
 * thumbs-down or an escalation after the revision = the change mattered.
 * `acted` = the gate withheld the rewrite (act, wording-only verdict) — the
 * user then judged the UNREVISED text, so the same signals say the withheld
 * rewrite may have mattered; Module A's act-band window admits the row on it.
 * Never throws.
 */
export function labelRevisionMaterial(opts: { decisionId?: string; p: number | null; mode: DecisionMode; signal: 'thumbs_up' | 'thumbs_down' | 'escalated'; sessionId?: string; stash?: DecisionStash; acted?: boolean; note?: string }): boolean {
  try {
    if (!opts.decisionId || opts.p === null) return false;
    const stash = opts.stash ?? noulStash(REVISION_MATERIAL_PURPOSE, REVISION_MATERIAL_QUESTION, opts.decisionId, opts.p, opts.mode);
    labelRevisionMaterialOutcome(stash, { thumbsDown: opts.signal === 'thumbs_down', escalated: opts.signal === 'escalated', sessionId: opts.sessionId, acted: opts.acted === true, ...(opts.note ? { note: opts.note } : {}) });
    return true;
  } catch { return false; }
}

/** The pill states a persisted row may end in and still label revision_material: the revision landed ('updated') or the gate withheld it ('checked'). */
const REVISION_LABELLABLE_STATES: ReadonlySet<string> = new Set(['updated', 'checked']);

/**
 * revision_material from a PERSISTED row: the signal (thumbs / a Dig-deeper
 * tap) lands on a message whose metadata.check.verdict.decision carries the
 * gate's stash and whose pill read 'updated' (the revision landed) or
 * 'checked' (the gate said wording-only and the rewrite was WITHHELD — only
 * possible in act, labelled `acted:true`). Audit 2026-09-26
 * (revision-material-act-period-labels): 'checked' rows used to label nothing,
 * yet they are exactly the in-band act decisions, so the act-period auto-demote
 * / readiness window was blind for this purpose by construction. On a
 * 'checked' row the user judged the UNREVISED text: thumbs-down / a tap = the
 * withheld rewrite may have mattered (material true), thumbs-up = wording-only
 * was right (false). A row with no persisted decision (the deterministic diff
 * decided) or a pill that never completed ('checking' / 'interrupted') labels
 * nothing. Never throws.
 */
export function labelRevisionMaterialFromMetadata(metadata: unknown, signal: 'thumbs_up' | 'thumbs_down' | 'escalated', sessionId?: string): boolean {
  try {
    const rev = revisionDecisionFromMetadata(metadata);
    if (!rev) return false;
    if (!REVISION_LABELLABLE_STATES.has(rev.state)) return false;
    const p = (rev.stash.answers[REVISION_MATERIAL_QUESTION] as { noul?: number } | undefined)?.noul;
    if (typeof p !== 'number') return false;
    const note = rev.updated ? 'pill:updated' : `pill:${rev.state}${rev.acted ? ' (rewrite withheld)' : ''}`;
    return labelRevisionMaterial({ decisionId: rev.stash.id, p, mode: rev.stash.mode, signal, sessionId, stash: rev.stash, acted: rev.acted, note });
  } catch { return false; }
}
