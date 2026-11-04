/**
 * Compute-policy label HOOKS that need the database (cp/labels, 2026-09-26 —
 * docs/DEPTH_UX_SOTA_2026-09-26.md §4 D2 "write labels"): the two
 * user-behaviour labels whose signal arrives on a LATER request than the turn
 * they label —
 *
 *   reask_5m — the same user's next human turn in the same chat ≤ 5 min after
 *              the answer (a deterministic proxy for "not deep enough");
 *              labels the PREVIOUS turn's compute_policy decision. Called from
 *              the harness right before it persists the new user row (the one
 *              chokepoint every human send surface passes — web, Telegram,
 *              iMessage, queue drains); one indexed read on (chatId, createdAt).
 *   thumbs   — a thumbs_up / thumbs_down (+ reason) on an assistant row that
 *              carries metadata.depth.decision; ALSO the revision_material
 *              label when the row's pill reads 'updated' and the gate's
 *              decision was persisted (metadata.check.verdict.decision).
 *              Called from POST /api/crossmodel/feedback after the row is saved.
 *
 * Both are fire-and-forget: `void` at the call site, every branch inside a
 * try/catch, never on the request path's critical section, never a throw.
 * The return value is a short reason string for tests / logs only.
 *
 * Harness rows (audit h4-reask-5m, 2026-09-26): the chat's newest row is not
 * always the answer the user is reacting to — a late-check ADDENDUM
 * (`kind:'check_addendum'`, no `depth`), the deploy shutdown note
 * (`origin:'shutdown_requeue'`) or a status card (`origin:'session_status' /
 * 'project_status'`) can sit between the answer and the re-ask. `reaskVerdict`
 * steps over those by EXPLICIT kind / origin only and labels the first
 * remaining row as "the answer" (stamping `extra.afterAddendum:true` when an
 * addendum was stepped over — the user may be reacting to the correction). It
 * never skips ahead past a non-harness assistant row without a decision: that
 * would mislabel an older turn.
 */
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import {
  REASK_LABEL_WINDOW_MS, computeDecisionFromMetadata, factsFromDepthMetadata,
  labelComputePolicyReask, labelComputePolicyThumbs, labelRevisionMaterialFromMetadata, labelDraftsAgreeFromMetadata,
} from './compute-policy-labels';
import { labelTurnPlan } from './turn-plan-labels';

type Row = { role: string; createdAt: Date; metadata: unknown };

/** Pure: is `prevUserRow` (the user row before the answer) the same human as `authorId`? Rows without authorId are the chat owner's (pre-f89d1213 rows). */
export function sameHumanAuthor(prevUserRow: { metadata: unknown } | null | undefined, authorId: string | null | undefined): boolean {
  if (!prevUserRow) return true;
  const meta = prevUserRow.metadata && typeof prevUserRow.metadata === 'object' ? prevUserRow.metadata as Record<string, unknown> : {};
  if (typeof meta.origin === 'string' && meta.origin && meta.origin !== 'user') return false; // a machine turn's answer — no human re-asked it
  const prev = typeof meta.authorId === 'string' && meta.authorId ? meta.authorId : null;
  return !prev || !authorId || prev === authorId;
}

/** Harness-authored assistant rows that may sit between the answer and the re-ask (explicit kinds / origins only). */
const HARNESS_ROW_KINDS: ReadonlySet<string> = new Set(['check_addendum', 'council_addendum']);
const HARNESS_ROW_ORIGINS: ReadonlySet<string> = new Set(['shutdown_requeue', 'session_status', 'project_status']);
/** How many rows the hook reads before `sentAt`: the answer + its user row + up to two harness rows in between. */
export const REASK_ROWS_TAKE = 4;

function metaOf(row: Row | undefined): Record<string, any> {
  return row?.metadata && typeof row.metadata === 'object' ? row.metadata as Record<string, any> : {};
}

/** Pure: is this a harness-authored row the re-ask verdict may step over? Kind / origin match only — never "any assistant row without a decision". */
export function isHarnessRow(row: Row | undefined): boolean {
  if (!row || row.role !== 'assistant') return false;
  const meta = metaOf(row);
  return (typeof meta.kind === 'string' && HARNESS_ROW_KINDS.has(meta.kind))
    || (typeof meta.origin === 'string' && HARNESS_ROW_ORIGINS.has(meta.origin));
}

/**
 * Pure verdict over the chat's last rows before the new send (newest first):
 * after stepping over leading HARNESS rows (addendum / shutdown note / status
 * card — `isHarnessRow`), the next row must be an ASSISTANT row that posted
 * ≤ 5 min before `sentAt` and carries a compute_policy decision, and the user
 * row before it must be the same human (or unstamped). The window is measured
 * from the ANSWER row, not the harness row. Returns why not.
 */
export function reaskVerdict(rows: ReadonlyArray<Row>, sentAt: Date, authorId: string | null | undefined): { label: true; ageMs: number; index: number; afterAddendum: boolean } | { label: false; reason: string } {
  let index = 0;
  let afterAddendum = false;
  while (index < rows.length && isHarnessRow(rows[index])) {
    if (metaOf(rows[index]).kind === 'check_addendum') afterAddendum = true;
    index++;
  }
  const last = rows[index];
  if (!last) return { label: false, reason: index > 0 ? 'only_harness_rows' : 'no_prior_rows' };
  if (last.role !== 'assistant') return { label: false, reason: 'last_row_not_assistant' };
  const meta = metaOf(last);
  if (meta.kind === 'deeper_findings') return { label: false, reason: 'deeper_findings_row' };
  const ageMs = sentAt.getTime() - new Date(last.createdAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return { label: false, reason: 'bad_clock' };
  if (ageMs > REASK_LABEL_WINDOW_MS) return { label: false, reason: 'outside_window' };
  if (!computeDecisionFromMetadata(last.metadata)) return { label: false, reason: 'no_decision' };
  const prevUser = rows[index + 1] && rows[index + 1].role === 'user' ? rows[index + 1] : null;
  if (!sameHumanAuthor(prevUser, authorId)) return { label: false, reason: 'different_author' };
  return { label: true, ageMs, index, afterAddendum };
}

/**
 * The reask_5m hook. `sentAt` must be captured BEFORE the new user row is
 * persisted (the read is bounded by it, so the row this send creates can never
 * be the "previous" row whatever the write order). Never throws.
 */
export async function labelReaskForChat(opts: { chatId: string; authorId: string | null | undefined; sentAt: Date; sessionId?: string }): Promise<string> {
  try {
    if (!opts.chatId) return 'no_chat';
    const rows = await prisma.crossModelMessage.findMany({
      where: { chatId: opts.chatId, createdAt: { lt: opts.sentAt } },
      orderBy: { createdAt: 'desc' },
      take: REASK_ROWS_TAKE,
      select: { role: true, createdAt: true, metadata: true },
    });
    const v = reaskVerdict(rows as Row[], opts.sentAt, opts.authorId);
    if (!v.label) return v.reason;
    const last = rows[v.index] as Row;
    const ok = labelComputePolicyReask({ decisionStash: (last.metadata as any)?.depth?.decision, facts: factsFromDepthMetadata(last.metadata), sessionId: opts.sessionId ?? opts.chatId, gapMs: v.ageMs, afterAddendum: v.afterAddendum });
    // Dynamic roster (2026-10-03): a re-ask ≤ 5 min says the answer's lane was not enough.
    labelTurnPlan(last.metadata, 'reask', { sessionId: opts.sessionId ?? opts.chatId });
    return ok ? 'labelled' : 'writer_refused';
  } catch (err: any) {
    logger.debug(`compute-policy labels: reask hook skipped (${err?.message ?? err})`);
    return 'error';
  }
}

/**
 * The thumbs hook (POST /feedback): the compute_policy `thumbs` label on the
 * rated assistant row + the revision_material label when the row carries the
 * gate's persisted decision and its pill read 'updated' (the revision landed)
 * or 'checked' (the gate withheld the rewrite in act — labelled acted:true;
 * audit 2026-09-26). The row must belong to `chatId` (the controller already
 * checked the chat belongs to the user). Never throws.
 */
export async function labelThumbsForMessage(opts: { messageId: string | null | undefined; chatId: string; type: string; reason?: string | null; sessionId?: string }): Promise<string> {
  try {
    if (!opts.messageId) return 'no_message';
    const thumbs: 'up' | 'down' | null = opts.type === 'thumbs_up' ? 'up' : opts.type === 'thumbs_down' ? 'down' : null;
    if (!thumbs) return 'not_thumbs';
    const row = await prisma.crossModelMessage.findUnique({ where: { id: opts.messageId }, select: { chatId: true, role: true, metadata: true } });
    if (!row || row.chatId !== opts.chatId) return 'not_found';
    if (row.role !== 'assistant') return 'not_assistant';
    const sessionId = opts.sessionId ?? opts.chatId;
    const cp = labelComputePolicyThumbs({ decisionStash: (row.metadata as any)?.depth?.decision, facts: factsFromDepthMetadata(row.metadata), thumbs, reason: opts.reason ?? null, sessionId });
    const rm = labelRevisionMaterialFromMetadata(row.metadata, thumbs === 'down' ? 'thumbs_down' : 'thumbs_up', sessionId);
    // drafts_agree (2026-09-26): an ACTED decision (reconcile skipped) is labelled by the user's own verdict on the "Checked ✓" answer.
    const da = labelDraftsAgreeFromMetadata(row.metadata, thumbs === 'down' ? 'thumbs_down' : 'thumbs_up', sessionId);
    // Dynamic roster (2026-10-03): thumbs down ⇒ the lane was not enough; thumbs up ⇒ it held.
    const tp = labelTurnPlan(row.metadata, thumbs === 'down' ? 'thumbs_down' : 'thumbs_up', { sessionId });
    const parts = [cp ? 'compute_policy' : '', rm ? 'revision_material' : '', da ? 'drafts_agree' : '', tp ? 'turn_plan' : ''].filter(Boolean);
    return parts.length ? `labelled:${parts.join('+')}` : 'no_decision';
  } catch (err: any) {
    logger.debug(`compute-policy labels: thumbs hook skipped (${err?.message ?? err})`);
    return 'error';
  }
}
