/**
 * REPLAY — ticket f3e56567, the SILENT-LOSS half of the tool surface.
 *
 * Reported from the Schooltime project supervisor chat (41bd202a), 2026-10-30:
 * `todo_update(progressNote)` was attempted 6+ times across wakes and "all
 * silently lost — progressNote stayed null and updatedAt stayed unchanged at
 * 10:47:26Z on read-back, so the write never reached the row", while the
 * tool reported no error. The ticket's expected behaviour is explicit:
 *
 *   "tool payloads arrive byte-intact, or the call returns an explicit
 *    length/encoding error the agent can see — never a silent mid-payload cut
 *    or a lost write that still reports plausible success."
 *
 * THE TWO SILENT-LOSS SHAPES THIS FILE PINS (both are contract holes in the
 * tool layer, independent of the byte-level decode fix in coding-model.ts):
 *
 *   1. ZERO-WRITE NO-OP. `updateTodo` / `updateGoal` build a `data` object from
 *      the request and then `if (Object.keys(data).length) { …update… }`. A call
 *      carrying the ID but none of the mutating fields performs NO write and
 *      returns the CURRENT row — which the agent reads as "updated". Nothing
 *      upstream refuses it: `{"todoId":"355152e6"}` is valid JSON for an
 *      argument object, so it parses and executes cleanly. This is exactly the
 *      reported read-back (row unchanged, no error) and exactly why the reporter
 *      retried six times.
 *
 *   2. SILENT NOTE CUT. `goals.service` stores
 *      `String(note).trim().slice(0, progressNoteMax())`. For a board note the
 *      cut removes precisely the TAIL the next firing needs (ticket ids, the
 *      continuation line) while reporting success — the ticket's acceptance bar
 *      ("land byte-intact … or fail loudly with a length error") asks for a
 *      refusal instead.
 *
 * Both fixes are REFUSALS, never guesses: the message names what is missing so
 * the caller re-issues correctly in one retry, and no user-authored prose is
 * ever echoed back.
 *
 * THE 2026-08-30 AUDIT STILL GOVERNS: nothing here loosens an argument check.
 * A refusal is the loud failure the ticket asked for.
 */
import { noOpWriteRefusal } from './tool-write-guards';

describe('ticket f3e56567 — a write that does nothing must NEVER report success', () => {
  describe('noOpWriteRefusal', () => {
    it('REFUSES an id-only todo_update (the reported silent no-op)', () => {
      const why = noOpWriteRefusal('todo_update', { todoId: '355152e6' });
      expect(why).not.toBeNull();
      expect(why).toContain('Nothing was written');
      // Names the id so the caller can see WHICH row it aimed at.
      expect(why).toContain('355152e6');
      // Names the fix, not a guess.
      expect(why).toContain('progressNote');
      // Must never advise a null note is the same as omitting it.
      expect(why).toContain('progressNote: null');
    });

    it('REFUSES an id-only goal_update', () => {
      const why = noOpWriteRefusal('goal_update', { goalId: '4860aa67' });
      expect(why).not.toBeNull();
      expect(why).toContain('Nothing was written');
      expect(why).toContain('4860aa67');
    });

    it('ALLOWS every real mutation — including a null progressNote (an explicit CLEAR)', () => {
      // Each of these actually changes the row, so each must pass.
      expect(noOpWriteRefusal('todo_update', { todoId: 't', progressNote: 'landed' })).toBeNull();
      expect(noOpWriteRefusal('todo_update', { todoId: 't', progressNote: null })).toBeNull();
      expect(noOpWriteRefusal('todo_update', { todoId: 't', status: 'done' })).toBeNull();
      expect(noOpWriteRefusal('todo_update', { todoId: 't', blockedReason: 'waiting' })).toBeNull();
      expect(noOpWriteRefusal('todo_update', { todoId: 't', assigneeChatId: null })).toBeNull();
      expect(noOpWriteRefusal('todo_update', { todoId: 't', dependsOnTodoIds: [] })).toBeNull();
      expect(noOpWriteRefusal('todo_update', { todoId: 't', title: 'renamed' })).toBeNull();
      expect(noOpWriteRefusal('todo_update', { todoId: 't', blockKind: null })).toBeNull();
      expect(noOpWriteRefusal('goal_update', { goalId: 'g', priority: 1 })).toBeNull();
      expect(noOpWriteRefusal('goal_update', { goalId: 'g', dueAt: '2026-11-01' })).toBeNull();
      expect(noOpWriteRefusal('goal_update', { goalId: 'g', description: 'x' })).toBeNull();
    });

    // Ticket ac87ab80 moved the decision one layer down. This guard is a PURE
    // LEAF — it cannot read the row, so it cannot tell an already-done row (where
    // `evidence` AMENDS the stored citation, a real write) from an open one
    // (where goals.service now 400s LOUDLY naming the rule). BOTH outcomes are
    // honest, so `evidence` always counts as an attempted mutation here and the
    // service owns amend-or-refuse. What must never come back is the pre-fix
    // SILENCE: `{status:'done', evidence}` on an already-done row performing
    // zero writes and echoing the stale text as success (pinned in
    // goals.service.ac87ab80.test.ts).
    it('ALLOWS evidence alone — the SERVICE owns amend-or-refuse (amends a done row, 400s on an open one), so no silent drop is possible either way', () => {
      expect(noOpWriteRefusal('todo_update', { todoId: 't', evidence: 'PR #123 merged' })).toBeNull();
    });

    it('ALLOWS evidence WITH a closing status — that is the real close path', () => {
      expect(noOpWriteRefusal('todo_update', { todoId: 't', status: 'done', evidence: 'PR #123' })).toBeNull();
      expect(noOpWriteRefusal('todo_update', { todoId: 't', status: 'dropped', evidence: 'owner cancelled' })).toBeNull();
    });

    // Independent review of ticket ac87ab80, finding 8 (REGRESSION the service
    // change introduced and this pin locks shut). goals.service trims evidence
    // and treats '' as "nothing supplied" (`if (evidenceText)`), so a BLANK
    // string writes nothing and returns the unchanged row as a success — the
    // exact silent no-op this guard exists to refuse. Widening evidence to
    // "always a mutation" had made {evidence: ''} newly reachable.
    it('REFUSES BLANK evidence — the service stores nothing, so success would be a lie', () => {
      for (const blank of ['', '   ', '\n\t ']) {
        const why = noOpWriteRefusal('todo_update', { todoId: 't', evidence: blank });
        expect(why).not.toBeNull();
        expect(why).toContain('Nothing was written');
      }
      // ...but WITH a closing status the call DOES write (it closes the row), so
      // it is not a no-op — the closing status is the real mutation here.
      expect(noOpWriteRefusal('todo_update', { todoId: 't', status: 'done', evidence: '' })).toBeNull();
    });

    it('REFUSES a non-string evidence value (never forwarded by the executor)', () => {
      expect(noOpWriteRefusal('todo_update', { todoId: 't', evidence: null })).not.toBeNull();
      expect(noOpWriteRefusal('todo_update', { todoId: 't', evidence: 42 })).not.toBeNull();
    });

    // Independent review N1: the executor forwards `status` only when it is
    // `!== null`, so `status: null` is NOT a write. A presence-only check would
    // have waved this through as a mutation and re-created the silent no-op.
    it('REFUSES the present-but-not-forwarded shapes the executor drops', () => {
      expect(noOpWriteRefusal('todo_update', { todoId: 't', status: null })).not.toBeNull();
      expect(noOpWriteRefusal('todo_update', { todoId: 't', dependsOnTodoIds: null })).not.toBeNull();
      expect(noOpWriteRefusal('todo_update', { todoId: 't', dependsOnTodoIds: 'x' })).not.toBeNull();
      expect(noOpWriteRefusal('goal_update', { goalId: 'g', status: null })).not.toBeNull();
      expect(noOpWriteRefusal('goal_update', { goalId: 'g', dependsOnGoalIds: null })).not.toBeNull();
    });

    it('an EMPTY STRING note is still "sent" — it clears, it is not an omission', () => {
      // `progressNote: ''` makes goals.service store null ("" || null), i.e. a
      // real CLEAR. It is present, so it is not the no-op this guard refuses.
      expect(noOpWriteRefusal('todo_update', { todoId: 't', progressNote: '' })).toBeNull();
    });

    it('`force` alone is NOT a write — it only modifies a status change', () => {
      const why = noOpWriteRefusal('todo_update', { todoId: 't', force: true });
      expect(why).not.toBeNull();
    });

    it('is fail-open on a non-object payload (service validation owns that case)', () => {
      expect(noOpWriteRefusal('todo_update', undefined)).toBeNull();
      expect(noOpWriteRefusal('todo_update', null)).toBeNull();
      expect(noOpWriteRefusal('todo_update', 'todoId')).toBeNull();
    });

    it('never echoes user-authored prose into a refusal', () => {
      // A refusal carries the id and field NAMES only. This matters because the
      // same arguments may carry credentials.
      const why = noOpWriteRefusal('todo_update', { todoId: 't', apiKey: 'sk-SECRET' });
      expect(why).not.toBeNull();
      expect(why).not.toContain('sk-SECRET');
    });
  });
});
