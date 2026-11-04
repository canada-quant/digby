/**
 * Durable audit trail for every mutation of a user's flat memory blob
 * (user_memory.facts) — 2026-09-21 owner report "my memory shows 3 facts".
 *
 * Why: the extractor, the nightly dream, the rebuild, the Memory tab and the
 * remember/forget tools all rewrite the same blob, and until now each logged
 * at INFO only — container logs vanish on every deploy wave (json-file driver,
 * containers recreated), app_error_logs keeps warn+ only, and the dream's
 * `__dream.lastRemovedCount` remembers one run. When the owner's memory shrank
 * from 16 facts (09-15 rebuild) to 3 there was NO record of who removed what.
 * One loop_metrics row per mutation (kind `user_memory_mutation`) fixes that:
 * source, key names added/removed, removals the grounding guard dropped,
 * rejections, fact count before/after. Keys only — never fact values.
 *
 * Leaf module (loop-metrics + logger only) so memory.graph, the dream and
 * context.service can all import it without a cycle. Never throws.
 */
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';
import logger from '../../../utils/logger';

export type MemoryMutationSource =
  | 'turn' | 'rebuild' | 'dream' | 'api' | 'tool' | 'profile'
  // extraction-only sources (memory_extraction rows; they never mutate the flat blob)
  | 'thread' | 'project' | 'distill' | 'coding_project_dream' | 'coding_project_fold' | 'project_brief';

export interface MemoryMutationEvent {
  userId: string;
  source: MemoryMutationSource;
  /** keys added or updated */
  added?: string[];
  /** keys deleted */
  removed?: string[];
  /** extractor `remove` proposals the grounding guard refused (turn/rebuild) */
  droppedRemovals?: string[];
  /** banned topics appended this mutation */
  rejected?: string[];
  /** banned topics LIFTED because the user explicitly asked to remember them again (ticket ccd634fb) */
  liftedRejections?: string[];
  /** visible (non-`__`) fact count before / after */
  before: number;
  after: number;
  /** dream only: the LLM consolidation was rejected by a guard (originals kept) */
  rejectedConsolidation?: string;
  /** the chat the turn ran in, when known */
  chatId?: string | null;
}

const KEY_MAX = 48;
const LIST_MAX = 40;
const trimKeys = (keys: string[] | undefined): string[] =>
  (keys ?? []).filter((k) => typeof k === 'string' && k.trim()).slice(0, LIST_MAX).map((k) => k.slice(0, KEY_MAX));

/** Count the user-visible facts in a blob (internal `__` bookkeeping excluded). */
export function countVisibleFacts(facts: Record<string, unknown> | null | undefined): number {
  return Object.keys(facts || {}).filter((k) => !k.startsWith('__')).length;
}

/** Record one blob mutation. `value` = net change in visible facts. Never throws. */
export function recordMemoryMutation(ev: MemoryMutationEvent): void {
  try {
    const added = trimKeys(ev.added);
    const removed = trimKeys(ev.removed);
    const droppedRemovals = trimKeys(ev.droppedRemovals);
    const rejected = trimKeys(ev.rejected);
    const liftedRejections = trimKeys(ev.liftedRejections);
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.USER_MEMORY_MUTATION,
      sessionId: ev.chatId ?? undefined,
      value: ev.after - ev.before,
      unit: 'facts',
      meta: {
        userId: ev.userId,
        source: ev.source,
        before: ev.before,
        after: ev.after,
        added,
        removed,
        ...(droppedRemovals.length ? { droppedRemovals } : {}),
        ...(rejected.length ? { rejected } : {}),
        ...(liftedRejections.length ? { liftedRejections } : {}),
        ...(ev.rejectedConsolidation ? { rejectedConsolidation: ev.rejectedConsolidation.slice(0, 200) } : {}),
      },
    });
    if (removed.length || droppedRemovals.length || ev.rejectedConsolidation) {
      logger.info(
        `memory-audit: ${ev.source} for ${ev.userId} — facts ${ev.before} → ${ev.after}` +
        (added.length ? `; added ${added.join(', ')}` : '') +
        (removed.length ? `; removed ${removed.join(', ')}` : '') +
        (droppedRemovals.length ? `; dropped ungrounded removals ${droppedRemovals.join(', ')}` : '') +
        (ev.rejectedConsolidation ? `; consolidation rejected: ${ev.rejectedConsolidation}` : ''),
      );
    }
  } catch {
    /* telemetry never breaks memory */
  }
}

export type MemoryExtractionOutcome = 'changed' | 'noop' | 'parse_error' | 'llm_error' | 'empty';

/**
 * One row per flat-fact extractor call (kind `memory_extraction`) — the
 * owner's 2026-09-22 rebuild replayed 150 exchanges and produced ONE mutation
 * while a manual replay of the same Lanai exchange produced adds every time;
 * without a per-call outcome there was no way to tell "the model said nothing"
 * from "the call failed and the failure was logged at debug". value = ms.
 */
/** Head + tail of a raw model answer for an outcome row: a cut-off JSON shows
 *  its truncation point, a complete-but-invalid one shows its closing shape.
 *  (Before 2026-09-23 the fold/dream rows kept only a 160-char head, so a 40%
 *  parse_error rate on the fold was undiagnosable.) */
export function extractionDetailOf(raw: unknown, n = 110): string {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= n * 2 + 20) return s;
  return `${s.slice(0, n)} …⟨${s.length} chars⟩… ${s.slice(-n)}`;
}

/**
 * Cap on an outcome row's `detail` (meta AND the warn line). 260 holds a whole head + tail
 * (extractionDetailOf ≈ 237, memory.graph extractionDetail ≤ 233). It was 160 until 2026-10-20,
 * which kept the head and cut the tail off — so the profile parse_error bursts read
 * `{ "summary": "…` with the truncation point, the one diagnostic part, missing.
 */
export const EXTRACTION_DETAIL_MAX_CHARS = 260;

export function recordExtractionOutcome(ev: { userId: string; source: MemoryMutationSource; outcome: MemoryExtractionOutcome; ms: number; chatId?: string | null; detail?: string; budgetTokens?: number; leg?: string; finishReason?: string; throttledSkips?: number; clampedFields?: string[] }): void {
  try {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.MEMORY_EXTRACTION,
      sessionId: ev.chatId ?? undefined,
      value: Math.max(0, Math.round(ev.ms)),
      unit: 'ms',
      // budgetTokens (firing 8, 2026-09-23): the output budget the project extractor
      // actually used — the live-audit column that proves the scaled-budget fix is
      // serving budgets >4000 on large states. The 8c052480 caller already passed it
      // in a spread, but this signature lacked the field, so TS excess-property
      // silence dropped it at the recorder and the probe read NULL all window —
      // a mocked-recorder pin never saw the seam. Explicitly threaded now.
      // throttledSkips / clampedFields (2026-10-20, profile leg — memory/profile-guard.ts): the turns the
      // per-user throttle skipped since the previous profile call, and the STORED-profile fields that
      // were over the caps (healed by this call). Absent when zero / none.
      meta: { userId: ev.userId, source: ev.source, outcome: ev.outcome, ...(ev.leg ? { leg: ev.leg } : {}), ...(ev.finishReason ? { finishReason: ev.finishReason } : {}), ...(typeof ev.budgetTokens === 'number' && Number.isFinite(ev.budgetTokens) ? { budgetTokens: ev.budgetTokens } : {}), ...(typeof ev.throttledSkips === 'number' && ev.throttledSkips > 0 ? { throttledSkips: ev.throttledSkips } : {}), ...(ev.clampedFields?.length ? { clampedFields: ev.clampedFields.slice(0, 8) } : {}), ...(ev.detail ? { detail: ev.detail.slice(0, EXTRACTION_DETAIL_MAX_CHARS) } : {}) },
    });
    if (ev.outcome === 'parse_error' || ev.outcome === 'llm_error' || ev.outcome === 'empty') {
      const via = ev.leg || ev.finishReason ? ` [${[ev.leg, ev.finishReason ? `finish=${ev.finishReason}` : ''].filter(Boolean).join(' ')}]` : '';
      logger.warn(`memory-audit: extraction ${ev.outcome} (${ev.source}) for ${ev.userId} after ${Math.round(ev.ms)} ms${via}${ev.detail ? `: ${ev.detail.slice(0, EXTRACTION_DETAIL_MAX_CHARS)}` : ''}`);
    }
  } catch {
    /* telemetry never breaks memory */
  }
}

// parseModelJson / salvageTruncatedJson live in model-json.ts (a no-import leaf) since 2026-10-20.
export { parseModelJson, salvageTruncatedJson } from './model-json';
