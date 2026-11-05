/**
 * TD-1 (Cluster 5, 2026-11-03) — the todo_create ASSIGNEE policy.
 *
 * THE DEFECT: `todo_create` accepted no `assigneeChatId` and silently stored an
 * UNASSIGNED todo. An unassigned todo has no lane that can fire `todo_done` for
 * it, so it sits on the board as work nobody owns: the board says "assigned
 * work" while nothing will ever run it. The failure mode is not theoretical —
 * the backlog reconciliation that produced this ticket (todo df87bf32) had to
 * leave seven cluster todos deliberately UNASSIGNED, because the only lanes
 * available were incidental and assigning real work to an incidental lane is
 * worse than leaving it unowned.
 *
 * THE FIX, in two halves behind one switch:
 *   - AUTO-ASSIGN: an unassigned create from a KNOWN caller lane binds that lane
 *     (the lane asked for the work; it is the honest default owner).
 *   - NAMED REFUSAL: an unassigned create with NO caller lane to bind is
 *     refused with a reason an agent can act on, instead of storing an orphan.
 *   - DELIBERATE UNASSIGNED: the escape hatch that must exist, because a
 *     backlog triage legitimately creates unowned rows. It is EXPLICIT, so the
 *     incident class (silent orphan) can never recur through it.
 *
 * SHADOW FIRST (the same discipline the wake-economy work carries): with
 * TODO_ASSIGNEE_REQUIRED_ENFORCE unset, NOTHING is refused and NOTHING is
 * reassigned — every unassigned create only records what the policy WOULD have
 * done. The default is therefore behaviour-identical to the pre-fix code, and
 * the observe rows are the audit trail that justifies flipping it.
 *
 * Import-free leaf on purpose (the owner-authority-switches.ts precedent): the
 * goal/todo service, the tool seam and the audit cron all read the same
 * predicate without pulling prisma or a service graph into a suite that mocks
 * any of them.
 */

/** TD-1 enforcement: '1' turns the auto-assign / named-refusal pair ON.
 *  Unset (the default) is observe-only — the pre-fix behaviour, plus metrics. */
export function todoAssigneeRequiredEnforced(): boolean {
  return process.env.TODO_ASSIGNEE_REQUIRED_ENFORCE === '1';
}

/** TD-1 audit cron kill switch (the audit pass reads its own inside, the
 *  session-topology precedent): '1' disables the periodic scan entirely. */
export function todoAssigneeAuditDisabled(): boolean {
  return process.env.TODO_ASSIGNEE_AUDIT_DISABLED === '1';
}

export type TodoAssigneeDecision =
  /** Keep the caller-supplied assignee (already validated/canonicalized elsewhere). */
  | { kind: 'keep'; assigneeChatId: string }
  /** Bind the caller's own lane — the honest default owner of work it created. */
  | { kind: 'auto_assign'; assigneeChatId: string }
  /** Store no assignee. `observeOnly` distinguishes "enforcement is off, so we
   *  must not change behaviour" from "the caller explicitly asked for this". */
  | { kind: 'unassigned'; observeOnly: boolean; reason: string }
  /** Refuse: enforcement is ON, the create is unassigned, and no lane exists. */
  | { kind: 'refuse'; reason: string };

/** The reason text is the CONTRACT an agent reads — it must name the gap and
 *  the two ways out, never a bare "invalid input". */
export const TODO_ASSIGNEE_REFUSAL_REASON =
  'todo_create REFUSED: no assigneeChatId and no caller lane to bind. An unassigned todo has no lane that can fire todo_done for it, so nothing would ever run it (TD-1). Pass assigneeChatId naming the worker chat responsible, or pass deliberateUnassigned:true when the row is a backlog item that is INTENTIONALLY unowned.';

/**
 * Pure, total, never throws. `enforced` is passed in (not read here) so the
 * caller resolves the switch ONCE per request and the decision stays testable
 * without mutating process.env.
 */
export function decideTodoCreateAssignee(input: {
  /** The caller-supplied assignee, already resolved/canonicalized, or null. */
  assigneeChatId?: string | null;
  /** The chat making the create (ToolContext.sessionId / actingChatId). */
  actingChatId?: string | null;
  /** The explicit escape hatch: this row is intentionally unowned. */
  deliberateUnassigned?: boolean;
  /** Resolved ONCE by the caller from todoAssigneeRequiredEnforced(). */
  enforced: boolean;
}): TodoAssigneeDecision {
  const supplied = String(input.assigneeChatId ?? '').trim();
  if (supplied) return { kind: 'keep', assigneeChatId: supplied };

  if (input.deliberateUnassigned === true) {
    return {
      kind: 'unassigned',
      observeOnly: false,
      reason: 'deliberate — the caller declared the row intentionally unowned (backlog item)',
    };
  }

  const caller = String(input.actingChatId ?? '').trim();
  if (!input.enforced) {
    // Observe-only: record what WOULD happen, change nothing.
    return {
      kind: 'unassigned',
      observeOnly: true,
      reason: caller ? 'would_auto_assign' : 'would_refuse',
    };
  }

  if (caller) return { kind: 'auto_assign', assigneeChatId: caller };

  return { kind: 'refuse', reason: TODO_ASSIGNEE_REFUSAL_REASON };
}