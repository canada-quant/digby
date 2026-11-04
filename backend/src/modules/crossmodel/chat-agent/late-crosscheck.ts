/**
 * Late cross-check reconcile — "first available answer now, updated when the
 * Double Checker finishes" (owner 2026-09-18).
 *
 * THE GAP (spark-cluster Supervisor, 20:32Z): Digby answered from context in
 * ~30 s with no tool round; the Double Checker was running its own research
 * (five web searches) and landed a complete draft at 212 s. The step-0 path
 * waited a fixed 60 s for it, gave up, shipped the single-model answer, and
 * the finished draft was thrown away — More-info showed one model and
 * nothing told the user the ensemble had degraded. 11 of 51 supervisor-chat
 * Level 2 turns in 48 h ended that way.
 *
 * THE FLOW NOW: the lead's answer ships as soon as the SHORT late-wait
 * passes (agent-profiles CROSS_CHECK_LATE_WAIT_MS — a few seconds to catch a
 * draft that is about to land), the persisted row carries
 * `metadata.pendingCrossCheck: true` and the `complete` event carries the row
 * id. This module then keeps waiting for the checker (bounded by the checker's
 * own hard cap), runs the SAME one-shot reconcile pass the inline path uses,
 * and UPDATES that message in place:
 *   - `revised`            — content/parts/followUps replaced; `metadata.revision`
 *                            records when, why and the previous text; the
 *                            checker's card joins `metadata.models` so
 *                            More-info is honest.
 *   - `unchanged`          — reconcile produced the same answer: card only.
 *   - `conversation_moved` — the user (or a machine turn) already continued
 *                            the chat: rewriting an older bubble would confuse,
 *                            so the card is attached and the text left alone
 *                            (a material change posts an `addendum` row; the
 *                            pill reads "Checked ✓" only when a reconcile ran
 *                            and found nothing material, else "interrupted").
 *   - `no_draft` / `timeout` / `reconcile_failed` — card (with its error) only.
 * Every outcome clears `pendingCrossCheck` and records ONE
 * `crosscheck_late_reconcile` metric. Never throws.
 *
 * The client polls the row while `pendingCrossCheck` is true (plain-session
 * pollPlainRevision) and swaps the bubble with an "Updated after the Double
 * Checker finished" note; a reload shows the persisted revision directly.
 */
import { stripNoActionToolNote } from './no-action-note';
import { stripUnreadStateNote } from './unread-state-note';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';
import { normalizeAssistantMarkdown } from '../markdown-normalize';
import { parseCanvasTags, parseFollowUps, stripAnswerMarkup } from '../langgraph/pipeline-utils';
import { CROSS_CHECK_HARD_MS } from '../coding/agent-profiles';
// Compute policy (cp/harness, 2026-09-26): the revision_material verdict decides
// rewrite vs "Checked ✓"; a conversation_moved reconcile lands as an ADDENDUM
// under the newer turn; every terminal outcome persists metadata.check.
import { checkStateForLateOutcome, compactDecisionStash, CHECK_ADDENDUM_KIND, type CheckStatePayload } from './compute-policy-wiring';

const SOURCE = 'late-crosscheck';
export const LATE_CROSSCHECK_MAX_WAIT_MS = CROSS_CHECK_HARD_MS;
/** The previous answer kept on the revision record (a reload can show "what changed"); bounded so metadata stays small. */
export const REVISION_PREVIOUS_MAX_CHARS = 20_000;

export type LateCrossCheckOutcome = 'revised' | 'unchanged' | 'no_draft' | 'conversation_moved' | 'reconcile_failed' | 'timeout' | 'addendum';

/** The revision_material verdict shape (platform/compute-policy-gate decideRevisionMaterial). */
export interface RevisionVerdict {
  material: boolean; changed: string[]; source: 'diff' | 'gate' | 'fallback'; decisionId?: string;
  /** cp/labels (2026-09-26): the gate's mode + stash ride the verdict so the persisted row (metadata.check.verdict.decision) can be labelled by a LATER thumbs / tap. */
  mode?: 'off' | 'shadow' | 'act';
  stash?: unknown;
  /** source 'diff' only (2026-09-26): the direction-aware reading (a claim of `prev` removed / replaced, or a polarity / negation / recommendation flip) — the drafts_agree label reads it; since the 2026-10-06 audit (T6-2) decideRevisionMaterial also derives a diff verdict's `material` from it (additions-only ⇒ no rewrite, no addendum). */
  contradicts?: boolean;
}

/**
 * The verdict as persisted on metadata.check.verdict (pure): material / source
 * / decisionId as before, plus — cp/labels 2026-09-26 — the gate's compact
 * decision stash when the gate answered, so a later thumbs / Dig-deeper tap
 * can write the revision_material label (compute-policy-labels
 * labelRevisionMaterialFromMetadata). A diff / fallback verdict carries none.
 */
export function revisionVerdictMeta(verdict: RevisionVerdict): Record<string, unknown> {
  const decision = verdict.stash ? compactDecisionStash(verdict.stash) : null;
  return {
    material: verdict.material, source: verdict.source,
    // Audit 2026-10-06 T6-2: the direction-aware reading rides the row — a diff verdict with material:false +
    // contradicts:false is an additions-only / stamp-drift reconcile that was NOT posted (queryable).
    ...(typeof verdict.contradicts === 'boolean' ? { contradicts: verdict.contradicts } : {}),
    ...(verdict.decisionId ? { decisionId: verdict.decisionId } : {}),
    ...(decision ? { decision } : {}),
  };
}

/** The late-path drafts_agree verdict (the gate's result + whether it ACTS: act-mode ∧ agree ∧ p ≥ the act bar). */
export interface LateDraftsAgree { act: boolean; agree: boolean | null; p: number | null; mode: string; decisionId?: string; stash?: unknown }

/** The addendum message posted under the newer turn when the user moved on and the late check changed a material claim. */
export const CHECK_ADDENDUM_HEADER = '**Update to an earlier answer** — the Double Checker finished after you moved on and a material point changed:';

export interface LateCrossCheckInput {
  chatId: string;
  messageId: string;
  /** the user's question as sent to the models */
  question: string;
  /** the lead's RAW answer (with its [FOLLOWUPS]/[CANVAS] blocks) — the reconcile pass keeps that chrome */
  draft: string;
  /**
   * Turn continuation (cohesive-chat wave 2026-09-28, review fix 7): the
   * delivered answer was REWRITTEN at the finalize (its hand-back closing
   * replaced by the continuation line) but the reconcile pass sees the
   * ORIGINAL draft — a material revision would write the hand-back back onto
   * a row whose task card says "running". When set, every revised text
   * (in-place revision AND addendum) goes through this deterministic rewrite
   * before it is persisted, and the revision carries no follow-up chips.
   */
  rewriteRevised?: (content: string) => string | Promise<string>;
  /** FSN1021 review round 5: the rewrite only re-judges harness text — keep the revision's own follow-up chips (continuation rows drop them). */
  rewriteKeepsChips?: boolean;
  /** FSN1021: compare a revision with the stored row run through the same rewrite (supervisor note scope only; elsewhere the raw row, as before). */
  rewriteBaseline?: boolean;
  /**
   * 2026-10-22 (owner-turn live-state read, unread-state-note.ts): compare with the unread-state harness line
   * stripped from BOTH sides — whether it is present is the harness's decision, never a checker change. Its own
   * flag (review 2026-10-22): rewriteBaseline is the FSN1021 note's, so SUPERVISOR_NO_ACTION_NOTE_DISABLED=1 still
   * restores the pre-FSN1021 comparison whatever this switch says.
   */
  unreadStateNoteless?: boolean;
  model: string;
  sessionId: string;
  projectId: string;
  userId: string;
  userTurnAt: Date | undefined;
  /** resolves to the checker block ('' when no usable draft) — the run's own promise */
  checkersPromise: Promise<string>;
  /** the run's live model-card map — the checker closure writes its card here when it returns */
  models: Record<string, any>;
  cardKey: string;
  /** when the lead started — the checker's card `time` is relative to this */
  startedAt: number;
  reconcile: (opts: { model: string; question: string; draft: string; block: string; sessionId: string; projectId: string; userId: string; userTurnAt: Date | undefined }) => Promise<string>;
  /** A reconcile pass the inline path already STARTED (it outran the inline bound): awaited instead of `reconcile` — never two passes for one draft. */
  preStartedReconcile?: Promise<string>;
  /**
   * Compute policy (2026-09-26): the revision_material verdict over (previous,
   * revised). material ⇒ rewrite + check 'updated' (changed[]); wording-only ⇒
   * 'checked' with NO rewrite. Absent ⇒ today's byte-diff rule (any change rewrites).
   */
  decideRevision?: (prev: string, next: string) => Promise<RevisionVerdict>;
  /**
   * drafts_agree on the LATE path (audit 2026-09-26 telemetry-readiness-6 /
   * gate-runtime-3 / tests-gaps-6): asked ONCE, before the reconcile, for a
   * draft that landed after the inline site's window — never when the inline
   * site already asked or pre-started the reconcile (`preStartedReconcile`).
   * `act` true ⇒ the reconcile pass is SKIPPED (outcome 'unchanged', pill
   * "Checked ✓"); otherwise the verdict rides `onOutcome.draftsAgree` for the
   * label. Absent ⇒ no ask (today's behaviour).
   */
  decideAgree?: (leadDraft: string, checkerBlock: string) => Promise<LateDraftsAgree>;
  /** Fires once with the terminal outcome + the check state written (labels / telemetry hooks). Never awaited. */
  onOutcome?: (o: { outcome: LateCrossCheckOutcome; check: CheckStatePayload; verdict?: RevisionVerdict; addendumMessageId?: string; draftsAgree?: LateDraftsAgree }) => void;
  now?: () => Date;
  maxWaitMs?: number;
  /** What set maxWaitMs (audit 2026-09-26): DepthBudget.maxBackgroundMs, the CROSS_CHECK_HARD_MS cap, or the kill switch — stamped on the metric so a 'timeout' names its bound. */
  boundSource?: 'depth_budget' | 'cap' | 'disabled';
}

/** Whitespace-insensitive equality — a reconcile that only re-flows text is "unchanged". */
export function sameAnswer(a: string, b: string): boolean {
  const norm = (s: string) => String(s || '').replace(/\s+/g, ' ').trim();
  return norm(a) === norm(b);
}

/**
 * The persist-side derivation the inline path applies to `raw`, for a
 * reconciled text: normalize → drop canvas blocks (the lead's canvases already
 * exist; a revision never creates new ones) → lift follow-ups → strip markup.
 * Follow-ups fall back to the original answer's chips when the revision
 * carries none (the reconcile doctrine asks for them but a model may drop them).
 */
export function deriveRevisedAnswer(reconciled: string, previousFollowUps: string[]): { content: string; followUps: string[] } {
  const normalized = normalizeAssistantMarkdown(reconciled);
  const { cleanText } = parseCanvasTags(normalized);
  const parsed = parseFollowUps(cleanText);
  const content = stripAnswerMarkup(parsed.cleanText).trim();
  const followUps = parsed.followUps.length ? parsed.followUps : previousFollowUps;
  return { content, followUps };
}

/** Replace the text parts of a persisted parts array with one text part carrying the revision. */
export function reviseParts(parts: unknown, content: string): object[] | undefined {
  if (!Array.isArray(parts) || !parts.length) return undefined;
  const nonText = parts.filter((p: any) => p && typeof p === 'object' && p.type !== 'text');
  return [...nonText, { type: 'text', text: content }];
}

const timeoutAfter = (ms: number) => new Promise<'__timeout__'>((res) => setTimeout(() => res('__timeout__'), ms).unref?.());

/**
 * Message ids whose late reconcile is IN FLIGHT on this process. The blue-green
 * drain counts them as active work (`GET /drain-status` adds
 * pendingLateCrossCheckCount to activeRuns — the run itself has already
 * finished and released its live-run slot, so without this the old colour was
 * torn down mid-wait and the row stayed `pendingCrossCheck: true` forever, the
 * client polling a revision that could never come). The SIGTERM ritual calls
 * abandonPendingLateCrossChecks so any survivor is closed honestly.
 */
const pendingLate = new Set<string>();

export function pendingLateCrossCheckCount(): number {
  return pendingLate.size;
}

/** Shutdown: clear the pending flag on every in-flight late reconcile (best-effort, bounded by the caller). */
export async function abandonPendingLateCrossChecks(reason = 'shutdown'): Promise<number> {
  const ids = [...pendingLate];
  pendingLate.clear();
  let n = 0;
  for (const id of ids) {
    try {
      const row = await prisma.crossModelMessage.findUnique({ where: { id }, select: { metadata: true } });
      const meta = (row?.metadata && typeof row.metadata === 'object') ? row.metadata as Record<string, any> : {};
      await prisma.crossModelMessage.update({
        where: { id },
        data: { metadata: { ...meta, pendingCrossCheck: false, crossCheck: { outcome: 'interrupted', reason, at: new Date().toISOString() }, check: checkStateForLateOutcome('interrupted') } as object },
      });
      n++;
    } catch (err: any) {
      logger.warn(`${SOURCE}: could not clear pendingCrossCheck on ${id.slice(0, 8)} at ${reason}: ${err?.message ?? err}`, { source: SOURCE });
    }
  }
  if (n) logger.info(`${SOURCE}: ${n} in-flight late cross-check(s) abandoned (${reason}) — flags cleared so clients stop polling`, { source: SOURCE });
  return n;
}

export async function runLateCrossCheck(input: LateCrossCheckInput): Promise<{ outcome: LateCrossCheckOutcome }> {
  const now = input.now ?? (() => new Date());
  const t0 = Date.now();
  const maxWait = input.maxWaitMs ?? LATE_CROSSCHECK_MAX_WAIT_MS;
  let outcome: LateCrossCheckOutcome = 'no_draft';
  let checkerTimeMs: number | undefined;
  let reconcileMs: number | undefined;
  // Why a reconcile_failed happened (firing 25, 2026-09-26): the metric used to carry only
  // {outcome, checkerTimeMs, reconcileMs, waitedMs}, so a failed reconcile left a count the
  // audit could aggregate but NOBODY could triage — the reason died in a scrolling warn log,
  // and `.catch(() => '')` made a THROWING reconcile indistinguishable from an empty one.
  // Bounded to 200 chars; stamped into the metric meta and the message's crossCheck card.
  let failReason: string | undefined;
  let draftsAgree: LateDraftsAgree | undefined;
  // Compute policy: the pill state persisted with every terminal outcome
  // (metadata.check) + the revision verdict that produced it (hoisted so the
  // crosscheck_late_reconcile row can carry it — audit gate-runtime-4).
  let verdict: RevisionVerdict | undefined;
  pendingLate.add(input.messageId);
  try {
    const raced = await Promise.race([input.checkersPromise.catch(() => ''), timeoutAfter(Math.max(1_000, maxWait - (Date.now() - input.startedAt)))]);
    const block = raced === '__timeout__' ? '' : String(raced || '');
    if (raced === '__timeout__') outcome = 'timeout';
    const card = input.models?.[input.cardKey];
    if (card && typeof card.time === 'number') checkerTimeMs = card.time;

    const row = await prisma.crossModelMessage.findUnique({
      where: { id: input.messageId },
      select: { id: true, chatId: true, content: true, metadata: true, parts: true },
    }) as { id: string; chatId: string; content: string; metadata: any; parts: unknown } | null;
    if (!row) {
      logger.warn(`${SOURCE}: message ${input.messageId.slice(0, 8)} vanished before the late reconcile — nothing to update`, { source: SOURCE });
      pendingLate.delete(input.messageId);
      return { outcome: 'no_draft' };
    }
    const oldMeta = (row.metadata && typeof row.metadata === 'object') ? row.metadata as Record<string, any> : {};
    const modelsMeta = { ...(oldMeta.models || {}), ...(card ? { [input.cardKey]: card } : {}) };
    let changed: string[] = [];
    let addendumMessageId: string | undefined;
    // conversation_moved only (review 2026-09-26 M7): true iff a reconcile RAN
    // and found nothing material to tell (no change / wording-only) — the one
    // case that honestly reads "Checked ✓". No reconcile, an empty reconcile
    // or a failed addendum persist leave it false ⇒ 'interrupted'.
    let movedCheckCompleted = false;
    const baseMeta = (extra: Record<string, unknown>) => ({
      ...oldMeta,
      models: modelsMeta,
      pendingCrossCheck: false,
      crossCheck: { outcome, ...(checkerTimeMs != null ? { checkerTimeMs } : {}), ...(reconcileMs != null ? { reconcileMs } : {}), ...(failReason ? { reason: failReason } : {}), at: now().toISOString() },
      check: { ...checkStateForLateOutcome(outcome, changed, { movedCheckCompleted }), ...(verdict ? { verdict: revisionVerdictMeta(verdict) } : {}), ...(addendumMessageId ? { addendumMessageId } : {}), at: now().toISOString() },
      ...extra,
    });
    // drafts_agree on the late path: ONE ask per draft, only when the inline
    // site did not already ask / pre-start (never two decisions per draft).
    if (block && input.decideAgree && !input.preStartedReconcile) {
      try { draftsAgree = await input.decideAgree(input.draft, block); } catch { draftsAgree = undefined; }
    }
    // ONE reconcile pass for the draft (pre-started or fresh); '' on failure.
    // A confident late AGREE in act skips the pass: the delivered answer stands
    // as "Checked ✓" (the same contract as the inline site).
    const runReconcile = async (): Promise<string> => {
      if (draftsAgree?.act) { reconcileMs = 0; return row.content; }
      const r0 = Date.now();
      const reconciled = input.preStartedReconcile
        ? await input.preStartedReconcile.catch(() => '')
        : await input.reconcile({
          model: input.model, question: input.question, draft: input.draft, block,
          sessionId: input.sessionId, projectId: input.projectId, userId: input.userId, userTurnAt: input.userTurnAt,
        }).catch(() => '');
      reconcileMs = Date.now() - r0;
      return reconciled;
    };
    // Review fix 7: a continuation-rewritten row keeps its continuation closing
    // through any revision (and drops the chips — the delivered row has none).
    const applyRewrite = async (r: { content: string; followUps: string[] }): Promise<{ content: string; followUps: string[] }> => {
      if (!input.rewriteRevised || !r.content) return r;
      try { return { content: await input.rewriteRevised(r.content), followUps: input.rewriteKeepsChips ? r.followUps : [] }; } catch { return r; }
    };
    // FSN1021 review: the revision is compared with the stored row run through the SAME rewrite, so a rewrite that
    // only re-shapes harness text (the no-action line, the continuation closing) never reads as a material change.
    const baseline = await (async () => {
      if (!input.rewriteRevised || !input.rewriteBaseline || !row.content) return row.content;
      try { return await input.rewriteRevised(row.content); } catch { return row.content; }
    })();
    // FSN1021 (note scope only — rewriteBaseline): whether the harness line is present is the harness's decision, never a checker change.
    // 2026-10-22: the unread-state line the same way, keyed on its own flag.
    const noteless = (c: string): string => {
      const t = input.rewriteBaseline ? stripNoActionToolNote(c) : c;
      return input.unreadStateNoteless ? stripUnreadStateNote(t) : t;
    };
    // The revision_material verdict — the injected gate, else today's byte rule (any change is material).
    const judge = async (prev: string, next: string): Promise<RevisionVerdict> => {
      if (!input.decideRevision) return { material: true, changed: [], source: 'fallback' };
      try { return await input.decideRevision(prev, next); } catch { return { material: true, changed: [], source: 'fallback' }; }
    };

    if (block) {
      const latest = await prisma.crossModelMessage.findFirst({
        where: { chatId: row.chatId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      const previousFollowUps: string[] = Array.isArray(oldMeta.followUps) ? oldMeta.followUps : [];
      if (latest && latest.id !== row.id) {
        outcome = 'conversation_moved';
        // Compute policy (2026-09-26): the user moved on — never rewrite the
        // older bubble; when the check changed a MATERIAL claim, post a short
        // ADDENDUM under the newer turn instead. No verdict function = card only.
        if (input.decideRevision) {
          const reconciled = await runReconcile();
          if (reconciled.trim()) {
            const revised = await applyRewrite(deriveRevisedAnswer(reconciled, previousFollowUps));
            if (revised.content && !sameAnswer(noteless(revised.content), noteless(baseline))) {
              verdict = await judge(noteless(baseline), noteless(revised.content));
              changed = verdict.changed;
              if (verdict.material) {
                const addendum = await prisma.crossModelMessage.create({
                  data: {
                    chatId: row.chatId, role: 'assistant',
                    content: `${CHECK_ADDENDUM_HEADER}\n\n${revised.content}`,
                    metadata: {
                      kind: CHECK_ADDENDUM_KIND, addendumFor: row.id, engine: 'agent', mode: oldMeta.mode,
                      models: modelsMeta, modelLabels: oldMeta.modelLabels,
                      check: { state: 'updated', changed, at: now().toISOString() },
                    } as object,
                  },
                }).catch((err: any) => { logger.warn(`${SOURCE}: addendum persist failed for ${row.id.slice(0, 8)}: ${err?.message ?? err}`, { source: SOURCE }); return null; });
                if (addendum) {
                  addendumMessageId = (addendum as any).id;
                  outcome = 'addendum';
                  await prisma.crossModelChat.update({ where: { id: row.chatId }, data: { updatedAt: now() } }).catch(() => {});
                } else {
                  // A material correction the user never received: the pill must not read "Checked ✓".
                  failReason = 'addendum persist failed';
                }
              } else {
                movedCheckCompleted = true; // wording-only: the check completed, nothing to tell — "Checked ✓"
              }
            } else {
              movedCheckCompleted = true; // the reconcile changed nothing — "Checked ✓"
            }
          } else {
            failReason = input.preStartedReconcile ? 'pre-started reconcile resolved empty' : 'reconcile resolved empty';
          }
        }
      } else {
        const reconciled = await runReconcile();
        if (!reconciled.trim()) {
          outcome = 'reconcile_failed';
          failReason = input.preStartedReconcile ? 'pre-started reconcile resolved empty' : 'reconcile resolved empty';
        } else {
          const revised = await applyRewrite(deriveRevisedAnswer(reconciled, previousFollowUps));
          if (!revised.content || sameAnswer(noteless(revised.content), noteless(baseline))) {
            outcome = 'unchanged';
          } else {
            verdict = await judge(noteless(baseline), noteless(revised.content));
            changed = verdict.changed;
            if (!verdict.material) {
              // Wording-only rewrite: "Checked ✓", the delivered text stands.
              outcome = 'unchanged';
            } else {
            outcome = 'revised';
            const revisedParts = reviseParts(row.parts, revised.content);
            await prisma.crossModelMessage.update({
              where: { id: row.id },
              data: {
                content: revised.content,
                ...(revisedParts ? { parts: revisedParts as unknown as object[] } : {}),
                metadata: baseMeta({
                  ...(revised.followUps.length ? { followUps: revised.followUps } : {}),
                  revision: {
                    at: now().toISOString(),
                    reason: 'double_checker',
                    ...(checkerTimeMs != null ? { checkerTimeMs } : {}),
                    ...(changed.length ? { changed } : {}),
                    previousContent: String(row.content || '').slice(0, REVISION_PREVIOUS_MAX_CHARS),
                  },
                }) as object,
              },
            });
            await prisma.crossModelChat.update({ where: { id: row.chatId }, data: { updatedAt: now() } }).catch(() => {});
            }
          }
        }
      }
    }
    if (outcome !== 'revised') {
      await prisma.crossModelMessage.update({ where: { id: row.id }, data: { metadata: baseMeta({}) as object } }).catch((err: any) => {
        logger.warn(`${SOURCE}: card-only metadata update failed for ${row.id.slice(0, 8)}: ${err?.message ?? err}`, { source: SOURCE });
      });
    }
    try { input.onOutcome?.({ outcome, ...(draftsAgree ? { draftsAgree } : {}), check: checkStateForLateOutcome(outcome, changed, { movedCheckCompleted }), verdict, addendumMessageId }); } catch { /* hooks never break the pass */ }
    logger.info(`${SOURCE}: ${outcome} for message ${row.id.slice(0, 8)} (chat ${row.chatId.slice(0, 8)}; checker ${checkerTimeMs ?? '?'} ms; waited ${Date.now() - t0} ms${verdict ? `; revision ${verdict.material ? 'material' : 'wording-only'} via ${verdict.source}` : ''})`, { source: SOURCE });
  } catch (err: any) {
    outcome = 'reconcile_failed';
    failReason = String(err?.message ?? err).slice(0, 200);
    logger.warn(`${SOURCE}: late reconcile failed for ${input.messageId.slice(0, 8)} (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
    await prisma.crossModelMessage.update({
      where: { id: input.messageId },
      data: { metadata: { ...((await prisma.crossModelMessage.findUnique({ where: { id: input.messageId }, select: { metadata: true } }).catch(() => null))?.metadata as object || {}), pendingCrossCheck: false, crossCheck: { outcome, ...(failReason ? { reason: failReason } : {}), at: now().toISOString() }, check: { ...checkStateForLateOutcome('reconcile_failed'), at: now().toISOString() } } as object },
    }).catch(() => {});
    try { input.onOutcome?.({ outcome, ...(draftsAgree ? { draftsAgree } : {}), check: checkStateForLateOutcome('reconcile_failed') }); } catch { /* never */ }
  }
  pendingLate.delete(input.messageId);
  recordLoopMetric({
    kind: LOOP_METRIC_KINDS.CROSSCHECK_LATE_RECONCILE,
    sessionId: input.chatId,
    value: checkerTimeMs,
    unit: 'ms',
    meta: {
      outcome, ...(checkerTimeMs != null ? { checkerTimeMs } : {}), ...(reconcileMs != null ? { reconcileMs } : {}), waitedMs: Date.now() - t0, ...(failReason ? { reason: failReason } : {}),
      // Audit gate-runtime-4: the revision_material verdict on the row (material
      // / source / decisionId) so a one-query readout tells a diff-decided
      // reconcile from a gate-decided one without joining the message row.
      ...(verdict ? { material: verdict.material, verdictSource: verdict.source, ...(typeof verdict.contradicts === 'boolean' ? { contradicts: verdict.contradicts } : {}), ...(verdict.decisionId ? { decisionId: verdict.decisionId } : {}) } : {}),
      // The wait bound this pass ran under + what set it; a 'timeout' outcome IS the background bound firing.
      maxWaitMs: maxWait, ...(input.boundSource ? { boundSource: input.boundSource } : {}), ...(outcome === 'timeout' ? { backgroundTimeout: true } : {}),
    },
  });
  return { outcome };
}
