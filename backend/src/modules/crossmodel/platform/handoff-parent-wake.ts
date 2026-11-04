/**
 * Hand-off × the child-result hook wake (cohesive chat live fixes, 2026-09-28).
 *
 * The live acceptance (parent b9ee9c20, 05:27:39Z) showed a HUMAN's plain
 * chat receiving a raw `[MACHINE-TRIGGERED RUN …] [FRESHNESS CONTRACT …]`
 * user-role row from its child's run_completed hook — the supervisor-shaped
 * wake, in a chat where the task card + the hand-off's result row ARE the
 * notification. For such a parent the wake is noise: this leaf decides when
 * the child-result rows (run_completed / run_failed on a SPECIFIC child →
 * parent hook) are SKIPPED at delivery — terminal-marked
 * 'skipped:handoff_posted', never replayed — instead of waking the chat.
 *
 * The rule, all of which must hold (anything else delivers as before):
 *   · the target is a HUMAN-owned NON-supervisor chat (a Fleet / Project
 *     Supervisor keeps its wake — that is how it learns a lane finished);
 *   · the hook is a specific child → parent hook (sourceChatId set and not
 *     the target itself — the todo_wake self-hook and wildcard hooks never
 *     match);
 *   · every pending row is run_completed or run_failed (an attention_needed
 *     row — the child needs the user — still wakes the parent, and a mixed
 *     batch delivers whole);
 *   · a run_completed row is skipped only when the hand-off POSTED for that
 *     run — its summary carries the "[DELIVERABLES ALREADY POSTED …]" note,
 *     or the hand-off record exists for the row's runId. A completed run
 *     whose hand-off did NOT post (error / timeout) keeps the wake: the user
 *     must still hear about it;
 *   · a run_failed row is skipped only when the hand-off is enabled AND the
 *     parent's running task card could be flipped to FAILED with the cause
 *     (the caller does the flip and reports it); a chat with no card to flip
 *     keeps the wake.
 *
 * Leaf: no imports beyond types.
 *
 * DOUBLE SUPERVISION (audit 2026-10-06 T3-4, stanne #9): a run_completed the
 * hand-off did NOT post (a run with nothing deliverable — Go files only, or a
 * harvest run) used to deliver the whole batch to the human parent, which then
 * ran an 11-min harvest turn racing the project supervisor that ALSO received
 * the same completion through its project hook. When an ENABLED project-
 * supervisor hook covers the child (`psCoversChild` — the caller's probe), the
 * project supervisor owns the lane: the un-posted completion is skipped too
 * ('skipped:ps_covers_child'). A run_failed row keeps its card-flip rule and an
 * attention_needed row still wakes the parent. Kill switch
 * HANDOFF_PS_COVERED_SKIP_DISABLED=1.
 */

/** Terminal hook-row status for a skipped child-result wake (never replayed). */
export const HOOK_STATUS_HANDOFF_POSTED = 'skipped:handoff_posted';
/** audit 2026-10-06 T3-4: terminal status for an un-posted child result the project supervisor already owns. */
export const HOOK_STATUS_PS_COVERS_CHILD = 'skipped:ps_covers_child';

export function handoffPsCoveredSkipDisabled(): boolean {
  return process.env.HANDOFF_PS_COVERED_SKIP_DISABLED === '1';
}

/** The marker handoffHookNote() appends to a run_completed summary when the hand-off posted. */
export const HANDOFF_POSTED_MARKER = '[DELIVERABLES ALREADY POSTED';

export const CHILD_RESULT_TERMINAL_EVENTS: ReadonlySet<string> = new Set(['run_completed', 'run_failed']);

export interface HandoffWakeHook {
  id?: string;
  sourceChatId?: string | null;
  targetChatId: string;
}

export interface HandoffWakeTarget {
  isSupervisor?: boolean | null;
  isProjectSupervisor?: boolean | null;
}

export interface HandoffWakeRow {
  id?: string;
  eventType?: string | null;
  payload?: { summary?: unknown; runId?: unknown } | null;
}

export type HandoffWakeReason = 'handoff_posted' | 'failed_card_flipped' | 'ps_covers_child';

export interface HandoffWakeDecision {
  skip: boolean;
  /** Why the wake is skipped (when `skip`), or why it delivers (when not). */
  reason: HandoffWakeReason | 'supervisor_target' | 'not_child_hook' | 'no_rows' | 'other_events' | 'not_posted' | 'failed_no_card';
  /** run_failed rows that need the parent's card flipped to failed. */
  failedRows: HandoffWakeRow[];
}

export function rowRunId(row: HandoffWakeRow): string | null {
  const v = row?.payload?.runId;
  return typeof v === 'string' && v ? v : null;
}

export function rowSummary(row: HandoffWakeRow): string {
  const v = row?.payload?.summary;
  return typeof v === 'string' ? v : '';
}

/** TRUE when the row's summary carries the hand-off's posted note. */
export function rowCarriesHandoffNote(row: HandoffWakeRow): boolean {
  return rowSummary(row).includes(HANDOFF_POSTED_MARKER);
}

/**
 * The delivery-time decision. `hasRecord(childChatId, runId)` answers whether
 * the hand-off's store record exists (the second way a posted hand-off is
 * known); `flipFailedCard(row)` flips the parent's running task card to
 * FAILED for a run_failed row and reports whether a card was written. Both
 * are awaited per row; any throw inside them delivers (fail-open).
 */
export async function decideHandoffParentWake(input: {
  hook: HandoffWakeHook;
  target: HandoffWakeTarget | null | undefined;
  rows: HandoffWakeRow[];
  hasRecord: (childChatId: string, runId: string) => Promise<boolean>;
  flipFailedCard: (row: HandoffWakeRow) => Promise<boolean>;
  /** audit 2026-10-06 T3-4: an ENABLED project-supervisor hook covers this child (asked at most once, lazily). */
  psCoversChild?: (childChatId: string) => Promise<boolean>;
}): Promise<HandoffWakeDecision> {
  const none = (reason: HandoffWakeDecision['reason']): HandoffWakeDecision => ({ skip: false, reason, failedRows: [] });
  const { hook, target, rows } = input;
  if (!target || target.isSupervisor === true || target.isProjectSupervisor === true) return none('supervisor_target');
  const source = typeof hook.sourceChatId === 'string' ? hook.sourceChatId : '';
  if (!source || source === hook.targetChatId) return none('not_child_hook');
  if (!Array.isArray(rows) || rows.length === 0) return none('no_rows');
  if (!rows.every((r) => CHILD_RESULT_TERMINAL_EVENTS.has(String(r?.eventType ?? '')))) return none('other_events');
  const failedRows: HandoffWakeRow[] = [];
  let anyPosted = false;
  let anyPsCovered = false;
  let psCovered: boolean | null = null;
  try {
    for (const row of rows) {
      const type = String(row?.eventType ?? '');
      if (type === 'run_completed') {
        let posted = rowCarriesHandoffNote(row);
        if (!posted) {
          const runId = rowRunId(row);
          posted = !!runId && (await input.hasRecord(source, runId));
        }
        if (!posted) {
          // T3-4: nothing was handed off — the project supervisor that covers
          // the child owns it; the human parent is not machine-woken as well.
          if (!handoffPsCoveredSkipDisabled() && input.psCoversChild) {
            if (psCovered === null) psCovered = (await input.psCoversChild(source)) === true;
            if (psCovered) { anyPsCovered = true; continue; }
          }
          return none('not_posted');
        }
        anyPosted = true;
        continue;
      }
      // run_failed
      failedRows.push(row);
    }
    // Flip the card for every failed row ONLY once every row is accounted
    // for — a batch that delivers must not half-flip cards first.
    for (const row of failedRows) {
      const flipped = await input.flipFailedCard(row);
      if (!flipped) return none('failed_no_card');
    }
  } catch {
    return none('not_posted');
  }
  return { skip: true, reason: anyPsCovered ? 'ps_covers_child' : anyPosted ? 'handoff_posted' : 'failed_card_flipped', failedRows };
}
