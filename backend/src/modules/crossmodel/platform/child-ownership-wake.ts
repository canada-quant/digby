/**
 * CHILD-RESULT HOOK — OWNERSHIP-MOVED RETIREMENT (ticket f8c62820).
 *
 * `start_coding_session` auto-wires a child→parent result hook
 * (`createdVia 'system:child-result-hook'`) so the spawning parent lane is
 * woken when its child session finishes. The 2026-09-29 incident (PR #1251 →
 * child chat b811d9f7): a project supervisor took the child over with an
 * agent-sent steer (6e05992f) — effective ownership of the lane moved away
 * from the spawning parent — but the auto-wired hook kept firing full-cost
 * parent wakes for work the ex-parent no longer owned.
 *
 * This leaf is the pure pre-fire gate for that hook kind. Ownership signal:
 * the newest agent-sent steer into the child chat. If it is newer than the
 * parent's last engagement and comes from a chat OTHER than the parent,
 * ownership has moved → the pending rows are terminal-marked
 * `skipped:ownership_moved` (never replayed, never delivered) and the wake is
 * skipped. The HOOK itself stays ARMED and self-heals: a newer parent steer
 * (any parent engagement after the takeover) re-establishes ownership and the
 * next child event wakes the parent again.
 *
 * Pure on purpose: every DB fact (steers, parentLastAt) is fetched by the
 * caller (`hooks.service.ts`) and passed in, so this file is trivially
 * unit-testable and the wiring stays thin. Always on — the
 * `CHILD_OWNERSHIP_WAKE_DISABLED` release switch was removed 2026-10-31
 * (RSW-1 cohort delete): the ownership probe now runs on every child-result
 * hook, and every probe failure still delivers as before.
 */

/** Terminal row status: the wake was skipped because ownership moved away. */
export const HOOK_STATUS_OWNERSHIP_MOVED = 'skipped:ownership_moved';

/** loop_metrics kind stamped once per suppressed delivery group. */
export const CHILD_OWNERSHIP_WAKE_SKIPPED = 'child_ownership_wake_skipped';

export interface ChildOwnershipWakeHook {
  id: string;
  /** The CHILD lane emitting the result event — the hook's source. */
  sourceChatId: string;
  /** The auto-wired PARENT to wake — the hook's target (the ex-parent candidate). */
  targetChatId: string;
  createdVia: string | null;
}

export interface ChildOwnershipWakeRow {
  /** Pending hook_events row id — terminal-marked when the wake is skipped. */
  id: string;
}

export interface ChildOwnershipWakeSteer {
  /** Chat that SENT the agent message into the child lane. */
  sourceChatId: string;
  createdAt: Date;
}

export type ChildOwnershipWakeDecision =
  | { action: 'wake'; reason: string }
  | {
      action: 'skip';
      status: typeof HOOK_STATUS_OWNERSHIP_MOVED;
      metricKind: typeof CHILD_OWNERSHIP_WAKE_SKIPPED;
      reason: string;
      rowIds: string[];
    };

/**
 * Decide whether an auto-wired child→parent result hook should still wake the
 * parent. `steers` are agent-sent messages into the CHILD chat, NEWEST FIRST,
 * any sender except the child itself; `parentLastAt` is the parent's last
 * message into the child chat (null = the parent never engaged).
 */
export function decideChildResultOwnershipWake(input: {
  hook: ChildOwnershipWakeHook;
  rows: ChildOwnershipWakeRow[];
  steers: ChildOwnershipWakeSteer[];
  parentLastAt: Date | null;
}): ChildOwnershipWakeDecision {
  const { hook, rows, steers, parentLastAt } = input;
  if (!rows.length) return { action: 'wake', reason: 'no_pending_rows' };

  for (const steer of steers) {
    // The child's own run messages are not ownership signals.
    if (steer.sourceChatId === hook.sourceChatId) continue;
    // Identity BEFORE staleness: the parent's own steer — even one at
    // exactly parentLastAt — is the newest agent activity on the child and
    // means the parent still owns the lane. (Checked first because a parent
    // steer can never be strictly NEWER than parentLastAt, its own last
    // engagement; ordering this after the staleness guard would make the
    // steer_from_parent arm unreachable.)
    if (steer.sourceChatId === hook.targetChatId) {
      return { action: 'wake', reason: 'steer_from_parent' };
    }
    // An external steer older than the parent's latest engagement is stale —
    // the parent re-engaged after it. Older steers are staler still; keep
    // scanning in case the caller's ordering is not strictly newest-first.
    if (parentLastAt && steer.createdAt <= parentLastAt) continue;
    // An external chat steered the child more recently than the parent ever
    // engaged — ownership has moved away from the ex-parent.
    return {
      action: 'skip',
      status: HOOK_STATUS_OWNERSHIP_MOVED,
      metricKind: CHILD_OWNERSHIP_WAKE_SKIPPED,
      reason: `external_steer_${steer.sourceChatId}`,
      rowIds: rows.map((row) => row.id),
    };
  }

  // No agent steer newer than the parent's last engagement: either every
  // external steer predates the parent's latest engagement (parent still
  // owns — the self-heal arm) or there is no takeover signal at all.
  return parentLastAt
    ? { action: 'wake', reason: 'steer_predates_parent' }
    : { action: 'wake', reason: 'no_steer' };
}
