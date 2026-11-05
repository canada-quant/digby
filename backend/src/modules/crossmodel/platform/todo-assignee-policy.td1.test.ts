/**
 * TD-1 (Cluster 5, 2026-11-03) — todo_create must not silently store an
 * UNASSIGNED todo.
 *
 * THE DEFECT, restated so the tests cannot drift from it: an unassigned todo
 * has no lane that can fire `todo_done` for it, so the board reports work that
 * nothing will ever run. The reconciliation behind this ticket left seven
 * cluster todos deliberately unassigned BECAUSE the alternative (binding each
 * to whichever lane happened to be around) is worse — which is exactly why the
 * fix needs an EXPLICIT escape hatch and not just a blanket refusal.
 *
 * Pinned behaviour:
 *   (i)   an explicit assignee is kept, untouched (the pre-fix path);
 *   (ii)  enforcement OFF (the default) refuses nothing and reassigns nothing
 *         — the create stores no assignee exactly as before, and records what
 *         the enforced policy WOULD have done (`wouldBe`), so the flip is a
 *         measured decision rather than a guess;
 *   (iii) enforcement ON with a caller lane AUTO-ASSIGNS that lane;
 *   (iv)  enforcement ON with no caller lane REFUSES with a reason that names
 *         both ways out (never a bare "invalid input");
 *   (v)   deliberateUnassigned:true is honoured under enforcement — the
 *         backlog escape hatch — and is NOT the same code path as a silent
 *         orphan.
 */
import { decideTodoCreateAssignee, TODO_ASSIGNEE_REFUSAL_REASON, todoAssigneeRequiredEnforced, todoAssigneeAuditDisabled } from './todo-assignee-policy';

const LANE = '1dab917c-7bda-4a05-95f8-7451c0757c43';

describe('TD-1 todo_create assignee policy', () => {
  afterEach(() => {
    delete process.env.TODO_ASSIGNEE_REQUIRED_ENFORCE;
    delete process.env.TODO_ASSIGNEE_AUDIT_DISABLED;
  });

  it('(i) an explicit assignee is kept verbatim — the policy never rewrites a caller-supplied owner', () => {
    for (const enforced of [false, true]) {
      const d = decideTodoCreateAssignee({ assigneeChatId: LANE, actingChatId: 'other', enforced });
      expect(d).toEqual({ kind: 'keep', assigneeChatId: LANE });
    }
  });

  it('(ii) observe-only (enforced:false, the DEFAULT): nothing is refused, nothing is reassigned', () => {
    // With a caller lane: the enforced policy WOULD auto-assign; observe says so and does nothing.
    expect(decideTodoCreateAssignee({ actingChatId: LANE, enforced: false }))
      .toEqual({ kind: 'unassigned', observeOnly: true, reason: 'would_auto_assign' });
    // With no caller lane: the enforced policy WOULD refuse; observe only records it.
    expect(decideTodoCreateAssignee({ enforced: false }))
      .toEqual({ kind: 'unassigned', observeOnly: true, reason: 'would_refuse' });
  });

  it('(iii) enforced + a caller lane → AUTO-ASSIGN that lane (the honest default owner)', () => {
    expect(decideTodoCreateAssignee({ actingChatId: LANE, enforced: true }))
      .toEqual({ kind: 'auto_assign', assigneeChatId: LANE });
    // Whitespace-only ids are not lanes.
    expect(decideTodoCreateAssignee({ actingChatId: '   ', enforced: true }).kind).toBe('refuse');
    expect(decideTodoCreateAssignee({ actingChatId: '', enforced: true }).kind).toBe('refuse');
  });

  it('(iv) enforced + no caller lane → REFUSED with a reason naming both ways out', () => {
    const d = decideTodoCreateAssignee({ enforced: true });
    expect(d.kind).toBe('refuse');
    if (d.kind !== 'refuse') throw new Error('unreachable');
    expect(d.reason).toBe(TODO_ASSIGNEE_REFUSAL_REASON);
    // The contract an agent reads: it must name BOTH escapes and WHY the row is refused.
    expect(d.reason).toContain('assigneeChatId');
    expect(d.reason).toContain('deliberateUnassigned:true');
    expect(d.reason).toMatch(/todo_done/);
    expect(d.reason).toMatch(/REFUSED/);
  });

  it('(v) deliberateUnassigned:true is honoured under enforcement — the backlog escape hatch', () => {
    const d = decideTodoCreateAssignee({ deliberateUnassigned: true, actingChatId: LANE, enforced: true });
    expect(d.kind).toBe('unassigned');
    if (d.kind !== 'unassigned') throw new Error('unreachable');
    // NOT observe-only: the caller declared intent, so this is a real decision.
    expect(d.observeOnly).toBe(false);
    expect(d.reason).toContain('deliberate');
    // Deliberate-unassigned wins even when a caller lane COULD have been bound —
    // otherwise the escape hatch would be unreachable from any lane.
    expect(d.kind).not.toBe('auto_assign');
  });

  it('deliberateUnassigned is ignored when an explicit assignee is supplied (explicit owner wins)', () => {
    expect(decideTodoCreateAssignee({ assigneeChatId: LANE, deliberateUnassigned: true, enforced: true }))
      .toEqual({ kind: 'keep', assigneeChatId: LANE });
  });

  it('switches: default OFF/OFF, and only the literal "1" arms them', () => {
    expect(todoAssigneeRequiredEnforced()).toBe(false);
    expect(todoAssigneeAuditDisabled()).toBe(false);
    process.env.TODO_ASSIGNEE_REQUIRED_ENFORCE = '1';
    expect(todoAssigneeRequiredEnforced()).toBe(true);
    // A stray "true" must not silently arm a write-path refusal in prod.
    process.env.TODO_ASSIGNEE_REQUIRED_ENFORCE = 'true';
    expect(todoAssigneeRequiredEnforced()).toBe(false);
    process.env.TODO_ASSIGNEE_AUDIT_DISABLED = '1';
    expect(todoAssigneeAuditDisabled()).toBe(true);
  });
});